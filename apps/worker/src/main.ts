import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  buildBranchName,
  createJobEvent,
  createId,
  parseGitHubRepo,
  type CreateJobRequest,
  type JsonValue,
  type Job,
  validateCreateJobRequest
} from "../../../packages/core/src/index.ts";
import { loadConfig, type WorkerConfig } from "./config.ts";
import { CleanupSupervisor } from "./cleanup.ts";
import { AndroidSlotPool } from "./android-slots.ts";
import { configuredAndroidProvisioning } from "./android-provisioning.ts";
import { androidAvdOwnershipErrors } from "./android-ownership.ts";
import { resolveAndroidTools } from "./android-tooling.ts";
import { IosSimulatorSlotPool } from "./ios-simulator-slots.ts";
import { JobScheduler } from "./job-scheduler.ts";
import { HostCapacityGovernor, type HostCapacityDecision } from "./host-capacity.ts";
import { JobReporter } from "./reporter.ts";
import { runJob, sendJobCallback } from "./runner.ts";
import { runCommand } from "./shell.ts";
import { appendWatchdogAlert, SmokeCoordinator } from "./smoke.ts";
import { LocalJobStore } from "./store.ts";
import { checkWorkerReadiness } from "./worker-readiness.ts";
import { ReadinessWatchdog } from "./watchdog.ts";

const scheduler: {
  androidSlots?: AndroidSlotPool;
  capacity?: HostCapacityGovernor;
  cleanup?: CleanupSupervisor;
  iosSimulatorSlots?: IosSimulatorSlotPool;
  jobs?: JobScheduler;
  smoke?: SmokeCoordinator;
  watchdog?: ReadinessWatchdog;
} = {};
const maintenance: { owner?: "smoke" | "watchdog" } = {};

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "serve") {
    const config = loadConfig();
    const overrides = parseServeArgs(rest);
    await serve({ ...config, ...overrides });
    return;
  }

  if (command === "run") {
    const jobFile = valueAfter(rest, "--job-file");
    if (!jobFile) {
      throw new Error("uriel-worker run requires --job-file <path>.");
    }
    const job = JSON.parse(await readFile(jobFile, "utf8")) as Job;
    const config = loadConfig();
    const capacity = new HostCapacityGovernor(config);
    const cleanup = new CleanupSupervisor(config);
    await runJob(job, config, {
      capacityGate: async () => capacity.evaluate(
        { activeHeavyJobs: 1, queuedJobs: 0 },
        { enforceWorkerLimit: false }
      ),
      cleanup
    });
    return;
  }

  console.log(`Usage:
  uriel-worker serve [--host 127.0.0.1] [--port 8788]
  uriel-worker run --job-file ./job.json`);
}

async function serve(config: WorkerConfig): Promise<void> {
  const store = new LocalJobStore(config);
  await store.init();
  scheduler.cleanup = new CleanupSupervisor(config);
  const startupCleanup = await scheduler.cleanup.reconcileStartup();
  if (startupCleanup.length > 0) {
    console.log(JSON.stringify({ actions: startupCleanup, type: "startup-cleanup" }));
  }
  const strandedJobs = await store.failRunningJobsAfterRestart();
  scheduler.androidSlots = new AndroidSlotPool(config.androidAvds);
  scheduler.iosSimulatorSlots = new IosSimulatorSlotPool(config.iosSimulatorUdids);
  scheduler.capacity = new HostCapacityGovernor(config);
  scheduler.jobs = new JobScheduler(config.maxConcurrentJobs, (error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  }, {
    admission: async ({ activeJobs, queuedJobs }) => {
      if (maintenance.owner) {
        return { admitted: false, reason: `${maintenance.owner} maintenance owns the heavy-resource gate` };
      }
      const decision = await scheduler.capacity?.evaluate({
        activeHeavyJobs: activeJobs,
        queuedJobs
      });
      return decision
        ? { admitted: decision.admitted, reason: decision.reason, state: decision }
        : { admitted: false, reason: "host capacity governor is unavailable" };
    },
    onBlocked: async (jobId, decision) => {
      await appendCapacityEvent(
        config,
        jobId,
        "warn",
        `Queued for host capacity: ${decision.reason ?? "host capacity is temporarily unavailable"}`,
        decision
      );
    },
    onUnblocked: async (jobId, decision) => {
      await appendCapacityEvent(config, jobId, "info", "Host capacity recovered; starting job.", decision);
    },
    retryDelayMs: config.capacityRetrySeconds * 1_000
  });
  scheduler.smoke = new SmokeCoordinator({
    androidSlots: scheduler.androidSlots,
    beginExclusive: () => {
      const state = scheduler.jobs?.state();
      if (maintenance.owner || !state || state.activeJobs > 0 || state.queuedJobs > 0) {
        return false;
      }
      maintenance.owner = "smoke";
      return true;
    },
    capacity: scheduler.capacity,
    cleanup: scheduler.cleanup,
    config,
    endExclusive: () => {
      maintenance.owner = undefined;
      scheduler.jobs?.wake();
    },
    schedulerState: () => scheduler.jobs?.state() ?? { activeJobs: 0, queuedJobs: 0 },
    store
  });
  scheduler.watchdog = createWatchdog(config);
  scheduler.watchdog.start();
  const server = createServer((request, response) => {
    void handleRequest(request, response, config);
  });
  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve);
  });
  console.log(`uriel-worker listening on http://${config.host}:${config.port}`);
  for (const job of (await store.listJobs()).filter((candidate) => candidate.status === "queued")) {
    enqueueJob(job, config);
  }
  for (const job of strandedJobs) {
    const reporter = new JobReporter({ jobId: job.id, store });
    void sendJobCallback(
      job,
      config,
      reporter,
      "Worker restarted while the job was running; job marked failed."
    );
  }
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: WorkerConfig
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true, service: "uriel-worker" });
      return;
    }

    if (config.workerToken && !authorized(request, config.workerToken)) {
      writeJson(response, 401, { error: "Unauthorized." });
      return;
    }

    if (request.method === "GET" && url.pathname === "/ready") {
      const readiness = await currentReadiness(config);
      writeJson(response, readiness.ok ? 200 : 503, readiness);
      return;
    }

    if (request.method === "GET" && url.pathname === "/status") {
      writeJson(response, 200, await workerTelemetry(config));
      return;
    }

    if (request.method === "POST" && url.pathname === "/smoke") {
      if (!scheduler.smoke) {
        writeJson(response, 503, { error: "Readiness smoke is unavailable before worker startup." });
        return;
      }
      const started = scheduler.smoke.start();
      writeJson(response, started.accepted ? 202 : 409, {
        ...started,
        smoke: scheduler.smoke.snapshot()
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/jobs") {
      const store = new LocalJobStore(config);
      writeJson(response, 200, await store.listJobs());
      return;
    }

    if (request.method === "POST" && url.pathname === "/jobs") {
      const input = JSON.parse(await readBody(request, 1024 * 1024)) as unknown;
      const validation = validateCreateJobRequest(input);
      if (!validation.ok) {
        writeJson(response, 400, { error: validation.error });
        return;
      }
      if (!repoAllowed(config, validation.value.repo)) {
        writeJson(response, 403, { error: "Repository is not allowed by this worker." });
        return;
      }
      if (requestsAndroidQa(validation.value.qa) && config.enableAndroidQa) {
        const ownershipErrors = androidAvdOwnershipErrors(config);
        if (ownershipErrors.length > 0) {
          writeJson(response, 503, {
            error: "Android QA is not ready because dedicated AVD ownership is invalid.",
            reasons: ownershipErrors
          });
          return;
        }
      }
      const store = new LocalJobStore(config);
      const job = await store.putJob(createJob(validation.value));
      enqueueJob(job, config);
      writeJson(response, 202, { ok: true, jobId: job.id });
      return;
    }

    const jobMatch = /^\/jobs\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && jobMatch?.[1]) {
      const job = await new LocalJobStore(config).getJob(decodeURIComponent(jobMatch[1]));
      if (!job) {
        writeJson(response, 404, { error: "Job not found." });
        return;
      }
      writeJson(response, 200, job);
      return;
    }

    const cancelMatch = /^\/jobs\/([^/]+)\/cancel$/u.exec(url.pathname);
    if (request.method === "POST" && cancelMatch?.[1]) {
      const jobId = decodeURIComponent(cancelMatch[1]);
      const result = await new LocalJobStore(config).cancelJob(jobId);
      if (!result) {
        writeJson(response, 404, { error: "Job not found." });
        return;
      }
      if (!result.changed) {
        writeJson(response, 409, {
          error: `Cannot cancel job with status "${result.job.status}".`
        });
        return;
      }
      if (scheduler.jobs?.cancel(jobId)) {
        await new LocalJobStore(config).appendEvent(
          jobId,
          createJobEvent("worker", "info", "Removed cancelled job from the scheduler queue.")
        );
      }
      if (scheduler.cleanup) {
        const actions = await scheduler.cleanup.cleanupJob(jobId, "job cancelled");
        await new LocalJobStore(config).appendEvent(
          jobId,
          createJobEvent("worker", "info", "Cancellation cleanup completed.", {
            actions: JSON.parse(JSON.stringify(actions)) as JsonValue
          })
        );
      }
      writeJson(response, 200, result.job);
      return;
    }

    const approveMatch = /^\/jobs\/([^/]+)\/approve\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "POST" && approveMatch?.[1] && approveMatch[2]) {
      const store = new LocalJobStore(config);
      const jobId = decodeURIComponent(approveMatch[1]);
      const stepId = decodeURIComponent(approveMatch[2]);
      const job = await store.getJob(jobId);
      if (!job) {
        writeJson(response, 404, { error: "Job not found." });
        return;
      }
      const next = {
        ...job,
        approvals: job.approvals.filter((approval) => approval.stepId !== stepId),
        status: "queued" as const,
        updatedAt: new Date().toISOString()
      };
      await store.putJob(next);
      await store.appendEvent(jobId, createJobEvent("approval", "info", `Approved step ${stepId}.`));
      writeJson(response, 200, await store.getJob(jobId));
      return;
    }

    const eventsMatch = /^\/jobs\/([^/]+)\/events$/u.exec(url.pathname);
    if (request.method === "GET" && eventsMatch?.[1]) {
      const job = await new LocalJobStore(config).getJob(decodeURIComponent(eventsMatch[1]));
      if (!job) {
        writeJson(response, 404, { error: "Job not found." });
        return;
      }
      writeJson(response, 200, job.events);
      return;
    }

    const artifactMatch = /^\/jobs\/([^/]+)\/artifacts\/(.+)$/u.exec(url.pathname);
    if (request.method === "GET" && artifactMatch?.[1] && artifactMatch[2]) {
      const jobId = decodeURIComponent(artifactMatch[1]);
      const name = decodeURIComponent(artifactMatch[2]);
      const store = new LocalJobStore(config);
      const job = await store.getJob(jobId);
      const artifact = job?.artifacts.find((candidate) => candidate.name === name);
      if (!artifact?.url) {
        writeJson(response, 404, { error: "Artifact not found." });
        return;
      }
      response.writeHead(200, {
        "content-type": artifact.contentType ?? "application/octet-stream"
      });
      createReadStream(artifact.url).pipe(response);
      return;
    }

    writeJson(response, 404, { error: "Not found." });
  } catch (error) {
    writeJson(response, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function requestsAndroidQa(qa: CreateJobRequest["qa"]): boolean {
  return qa === "android" || qa === "both" || qa === "all";
}

function enqueueJob(job: Job, config: WorkerConfig): void {
  scheduler.jobs?.enqueue(job.id, async () => {
    const current = await new LocalJobStore(config).getJob(job.id);
    if (current?.status !== "queued") return;
    const needsAndroid =
      config.enableAndroidQa &&
      (job.qa === "android" || job.qa === "both" || job.qa === "all");
    const needsIos = config.enableIosQa && (job.qa === "ios" || job.qa === "all");
    const androidLease = needsAndroid ? await scheduler.androidSlots?.acquire() : undefined;
    const iosSimulatorLease = needsIos
      ? await scheduler.iosSimulatorSlots?.acquire()
      : undefined;
    try {
      if (androidLease?.avd && scheduler.cleanup) {
        await scheduler.cleanup.claimAndroidDevice(androidLease.avd);
        await scheduler.cleanup.ledger.record(job.id, "android-lease", "android-lease", {
          avd: androidLease.avd
        });
      }
      const leasedJob = await new LocalJobStore(config).getJob(job.id);
      if (leasedJob?.status !== "queued") return;
      await runJob(job, config, {
        androidAvd: androidLease?.avd,
        capacityGate: async () => (scheduler.capacity ?? new HostCapacityGovernor(config)).evaluate({
          activeHeavyJobs: scheduler.jobs?.state().activeJobs ?? 1,
          queuedJobs: scheduler.jobs?.state().queuedJobs ?? 0
        }, { enforceWorkerLimit: false }),
        cleanup: scheduler.cleanup,
        iosSimulatorUdid: iosSimulatorLease?.udid
      });
    } finally {
      androidLease?.release();
      if (androidLease && scheduler.cleanup) {
        await scheduler.cleanup.ledger.release(job.id, "android-lease");
      }
      iosSimulatorLease?.release();
      if (scheduler.cleanup) await scheduler.cleanup.applyRetention();
    }
  });
}

async function appendCapacityEvent(
  config: WorkerConfig,
  jobId: string,
  level: "info" | "warn",
  message: string,
  decision: { state?: unknown }
): Promise<void> {
  const state = decision.state as HostCapacityDecision | undefined;
  await new LocalJobStore(config).appendEvent(
    jobId,
    createJobEvent("worker", level, message, state ? capacityDecisionJson(state) : undefined)
  );
}

function capacityDecisionJson(decision: HostCapacityDecision): JsonValue {
  return JSON.parse(JSON.stringify(decision)) as JsonValue;
}

async function currentReadiness(config: WorkerConfig) {
  const state = scheduler.jobs?.state() ?? { activeJobs: 0, queuedJobs: 0 };
  const usage = { activeHeavyJobs: state.activeJobs, queuedJobs: state.queuedJobs };
  const decision = await (scheduler.capacity ?? new HostCapacityGovernor(config)).evaluate(usage);
  return checkWorkerReadiness(config, usage, decision);
}

async function workerTelemetry(config: WorkerConfig) {
  const readiness = await currentReadiness(config);
  const cleanup = scheduler.cleanup ?? new CleanupSupervisor(config);
  const resources = await cleanup.ledger.active();
  const resourceCounts = Object.fromEntries(
    [...new Set(resources.map(({ kind }) => kind))].map((kind) => [
      kind,
      resources.filter((resource) => resource.kind === kind).length
    ])
  );
  let provisioningConfigured = false;
  try { provisioningConfigured = Boolean(configuredAndroidProvisioning(config)); } catch { /* readiness explains invalid config */ }
  return {
    android: scheduler.androidSlots?.state() ?? {
      available: config.androidAvds.length,
      leased: 0,
      total: config.androidAvds.length,
      waiting: 0
    },
    cleanup: { activeResourceCounts: resourceCounts, activeResources: resources.length },
    provisioning: {
      configured: provisioningConfigured,
      packageName: config.androidAppPackage ?? null
    },
    queue: scheduler.jobs?.state() ?? { activeJobs: 0, queuedJobs: 0 },
    readiness,
    service: "uriel-worker",
    smoke: scheduler.smoke?.snapshot() ?? { running: false },
    watchdog: scheduler.watchdog?.snapshot() ?? { consecutiveDegraded: 0, running: false }
  };
}

function createWatchdog(config: WorkerConfig): ReadinessWatchdog {
  return new ReadinessWatchdog({
    alert: async (probe) => appendWatchdogAlert(config, probe),
    cooldownMs: config.watchdogCooldownSeconds * 1_000,
    intervalMs: config.watchdogIntervalSeconds * 1_000,
    probe: async () => {
      const readiness = await currentReadiness(config);
      const state = scheduler.jobs?.state() ?? { activeJobs: 0, queuedJobs: 0 };
      return {
        actionable: state.activeJobs === 0 && state.queuedJobs === 0 && !maintenance.owner,
        causes: readiness.checks
          .filter((check) => check.status === "fail" || check.status === "warn")
          .map((check) => `${check.id}: ${check.detail}`),
        status: readiness.status
      };
    },
    recover: async () => {
      const state = scheduler.jobs?.state();
      if (maintenance.owner || !state || state.activeJobs > 0 || state.queuedJobs > 0) return;
      maintenance.owner = "watchdog";
      try {
        const confirmed = scheduler.jobs?.state();
        if (!confirmed || confirmed.activeJobs > 0 || confirmed.queuedJobs > 0) return;
        await scheduler.cleanup?.reconcileStartup();
        const adb = (await resolveAndroidTools(config)).adb;
        if (adb) {
          await runCommand(adb.command, ["kill-server"], { timeoutMs: 30_000 });
          await runCommand(adb.command, ["start-server"], { timeoutMs: 30_000 });
        }
      } finally {
        maintenance.owner = undefined;
        scheduler.jobs?.wake();
      }
    },
    threshold: config.watchdogFailureThreshold
  });
}

function createJob(request: CreateJobRequest): Job {
  const now = new Date().toISOString();
  const id = createId("job");
  return {
    approvals: [],
    artifacts: [],
    branch: buildBranchName(request, id.slice(-6)),
    callbackUrl: request.callbackUrl,
    checks: request.checks,
    createdAt: now,
    events: [],
    id,
    issue: request.issue,
    kind: request.kind ?? "change",
    metadata: request.metadata ?? {},
    profile: request.profile ?? "generic",
    prompt: request.prompt,
    qa: request.qa ?? "none",
    ref: request.ref,
    repo: request.repo,
    requestedBy: request.requestedBy,
    source: request.source ?? "api",
    status: "queued",
    updatedAt: now
  };
}

function repoAllowed(config: WorkerConfig, repo: string): boolean {
  if (config.allowedRepos.length === 0) {
    return true;
  }
  const parsed = parseGitHubRepo(repo);
  return config.allowedRepos.some((allowed) => {
    const normalized = allowed.trim().replace(/\.git$/u, "");
    return normalized === repo.replace(/\.git$/u, "") || normalized === parsed?.slug;
  });
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  const received = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (received.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < received.length; index += 1) {
    diff |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return diff === 0;
}

async function readBody(
  request: IncomingMessage,
  maxBytes: number
): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function parseServeArgs(args: string[]): Partial<WorkerConfig> {
  return {
    ...(valueAfter(args, "--host") ? { host: valueAfter(args, "--host") } : {}),
    ...(valueAfter(args, "--port")
      ? { port: Number.parseInt(valueAfter(args, "--port") ?? "8788", 10) }
      : {})
  };
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
