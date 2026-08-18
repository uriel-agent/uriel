import { readFile, rename, writeFile } from "node:fs/promises";

import { createId, type Job } from "../../../packages/core/src/index.ts";
import { configuredAndroidProvisioning, provisionAndroidApp } from "./android-provisioning.ts";
import type { AndroidSlotPool } from "./android-slots.ts";
import { listAttachedAndroidAvds, resolveAndroidTools } from "./android-tooling.ts";
import type { CleanupSupervisor } from "./cleanup.ts";
import type { WorkerConfig } from "./config.ts";
import type { HostCapacityGovernor } from "./host-capacity.ts";
import type { JobSchedulerState } from "./job-scheduler.ts";
import { ensureAndroidDevice } from "./qa.ts";
import { JobReporter } from "./reporter.ts";
import { runCommand } from "./shell.ts";
import type { LocalJobStore } from "./store.ts";

export interface SmokeSnapshot {
  lastCompletedAt?: string;
  lastError?: string;
  lastJobId?: string;
  lastStartedAt?: string;
  lastStatus?: "failed" | "passed" | "skipped";
  running: boolean;
}

interface SmokeCoordinatorOptions {
  androidSlots: AndroidSlotPool;
  beginExclusive(): boolean;
  capacity: HostCapacityGovernor;
  cleanup: CleanupSupervisor;
  config: WorkerConfig;
  endExclusive(): void;
  schedulerState(): JobSchedulerState;
  store: LocalJobStore;
}

export class SmokeCoordinator {
  private lastCompletedAt?: string;
  private lastError?: string;
  private lastJobId?: string;
  private lastStartedAt?: string;
  private lastStatus?: SmokeSnapshot["lastStatus"];
  private running = false;

  constructor(private readonly options: SmokeCoordinatorOptions) {}

  start(): { accepted: boolean; reason?: string } {
    if (this.running) return { accepted: false, reason: "readiness smoke is already running" };
    const state = this.options.schedulerState();
    if (state.activeJobs > 0 || state.queuedJobs > 0) {
      return { accepted: false, reason: "real jobs are active or queued" };
    }
    if (!this.options.beginExclusive()) {
      return { accepted: false, reason: "exclusive maintenance gate is unavailable" };
    }
    this.running = true;
    this.lastStartedAt = new Date().toISOString();
    void this.run()
      .catch((error) => {
        this.lastError = redactSecrets(errorMessage(error), this.options.config);
        this.lastStatus = "failed";
      })
      .finally(() => {
        this.running = false;
        this.lastCompletedAt = new Date().toISOString();
        this.options.endExclusive();
      });
    return { accepted: true };
  }

  snapshot(): SmokeSnapshot {
    return {
      ...(this.lastCompletedAt ? { lastCompletedAt: this.lastCompletedAt } : {}),
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.lastJobId ? { lastJobId: this.lastJobId } : {}),
      ...(this.lastStartedAt ? { lastStartedAt: this.lastStartedAt } : {}),
      ...(this.lastStatus ? { lastStatus: this.lastStatus } : {}),
      running: this.running
    };
  }

  private async run(): Promise<void> {
    const { androidSlots, capacity, cleanup, config, store } = this.options;
    const job = smokeJob();
    this.lastJobId = job.id;
    this.lastError = undefined;
    await store.putJob(job);
    const reporter = new JobReporter({ jobId: job.id, store });
    let lease: Awaited<ReturnType<AndroidSlotPool["acquire"]>> | undefined;
    try {
      const decision = await capacity.evaluate({ activeHeavyJobs: 0, queuedJobs: 0 });
      if (!decision.admitted) throw new Error(`smoke blocked by capacity: ${decision.reason}`);
      lease = await androidSlots.acquire();
      const avd = lease.avd;
      if (!avd) throw new Error("smoke acquired an Android slot without an AVD");
      await cleanup.claimAndroidDevice(avd);
      await cleanup.ledger.record(job.id, "android-lease", "android-lease", { avd });
      await reporter.status("running");
      await reporter.event("worker", "info", `Starting cold-boot readiness smoke on ${avd}.`);

      const tools = await resolveAndroidTools(config);
      if (!tools.adb) throw new Error("smoke cannot resolve adb");
      const attached = await listAttachedAndroidAvds(tools.adb.command);
      const existing = attached.avds.find((binding) => binding.avd === avd);
      if (existing) {
        await cleanup.ledger.record(job.id, "android-device", "android-device", {
          avd,
          serial: existing.serial
        });
        await cleanup.cleanupJob(job.id, "scheduled smoke cold-start reset");
        await cleanup.ledger.record(job.id, "android-lease", "android-lease", { avd });
      }

      const preBoot = await capacity.evaluate({ activeHeavyJobs: 0, queuedJobs: 0 });
      if (!preBoot.admitted) throw new Error(`smoke blocked by capacity: ${preBoot.reason}`);

      const serial = await ensureAndroidDevice(config, reporter, undefined, avd, async (binding) => {
        await cleanup.ledger.record(job.id, "android-device", "android-device", {
          avd: binding.avd,
          serial: binding.serial ?? null
        });
      });
      if (!serial) throw new Error(`smoke could not cold-boot ${avd}`);
      if (configuredAndroidProvisioning(config)) {
        await provisionAndroidApp(config, serial, reporter, undefined, avd);
      }
      const command = await runCommand(tools.adb.command, [
        "-s", serial, "shell", "echo", "uriel-smoke"
      ], { timeoutMs: 30_000 });
      if (command.code !== 0 || command.stdout.trim() !== "uriel-smoke") {
        throw new Error(`minimal adb smoke command failed with ${command.code}`);
      }
      await reporter.event("qa", "info", "Cold-boot readiness smoke passed.", { avd, serial });
      await reporter.status("completed");
      this.lastStatus = "passed";
    } catch (error) {
      const message = errorMessage(error);
      const safeMessage = redactSecrets(message, config);
      this.lastError = safeMessage;
      this.lastStatus = message.includes("blocked by capacity") ? "skipped" : "failed";
      await reporter.status("failed");
      await reporter.event("qa", "error", `Readiness smoke failed: ${safeMessage}`);
    } finally {
      try {
        const actions = await cleanup.cleanupJob(job.id, "scheduled smoke teardown");
        await reporter.event("worker", "info", "Readiness smoke teardown completed.", {
          actions: JSON.parse(JSON.stringify(actions))
        });
      } catch (error) {
        const safeMessage = redactSecrets(errorMessage(error), config);
        this.lastError = `teardown failed: ${safeMessage}`;
        this.lastStatus = "failed";
        await reporter.event("worker", "error", `Readiness smoke teardown failed: ${safeMessage}`);
      } finally {
        lease?.release();
        if (lease) await cleanup.ledger.release(job.id, "android-lease");
      }
      try {
        await store.pruneJobs(
          (candidate) => candidate.source === "watchdog" &&
            (candidate.status === "completed" || candidate.status === "failed"),
          config.smokeHistoryLimit
        );
      } catch (error) {
        console.error(`Failed to prune smoke history: ${redactSecrets(errorMessage(error), config)}`);
      }
    }
  }
}

export async function appendWatchdogAlert(
  config: WorkerConfig,
  alert: { causes: string[]; status: string }
): Promise<void> {
  const record = {
    at: new Date().toISOString(),
    causes: alert.causes,
    remediation: "Check authenticated /status, then repair the named subsystem; the watchdog will retry after cooldown.",
    status: alert.status,
    type: "uriel-readiness-alert"
  };
  const path = `${config.stateDir}/readiness-alerts.jsonl`;
  let existing: string[] = [];
  try { existing = (await readFile(path, "utf8")).split(/\r?\n/u).filter(Boolean); } catch { /* first alert */ }
  const lines = [...existing, JSON.stringify(record)].slice(-config.maxJobEvents);
  const temporary = `${path}.${process.pid}.tmp`;
  console.error(JSON.stringify(record));
  await writeFile(temporary, `${lines.join("\n")}\n`, "utf8");
  await rename(temporary, path);
}

function smokeJob(): Job {
  const now = new Date().toISOString();
  const id = createId("smoke");
  return {
    approvals: [], artifacts: [], branch: `smoke/${id}`, createdAt: now, events: [], id,
    kind: "verify", metadata: { scheduledReadinessSmoke: true }, profile: "generic",
    prompt: "Cold-boot readiness smoke.", qa: "android", requestedBy: "uriel-watchdog",
    source: "watchdog", status: "queued", updatedAt: now,
    repo: "https://github.com/uriel-agent/uriel"
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactSecrets(message: string, config: WorkerConfig): string {
  return [config.workerToken, config.callbackSecret, config.androidApkUrl, config.androidApkSha256]
    .filter((value): value is string => Boolean(value))
    .reduce((redacted, secret) => redacted.replaceAll(secret, "[redacted]"), message);
}
