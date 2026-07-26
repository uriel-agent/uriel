import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  buildChecksPromptSection,
  buildHarnessInvocation,
  buildJobCallbackPayload,
  enforceCheckResultEvidence,
  isHarnessId,
  parseCheckResults,
  parseJustRecipes,
  repoCacheKey,
  signPayloadSha256,
  type CheckResult,
  type Job,
  worktreeSlug
} from "../../../packages/core/src/index.ts";
import type { WorkerConfig } from "./config.ts";
import {
  configuredAndroidProvisioning,
  provisionAndroidApp
} from "./android-provisioning.ts";
import { EvidenceRecorder } from "./evidence.ts";
import { ensureLinearIssue } from "./linear.ts";
import {
  ensureAndroidDevice,
  recordAndroidClip,
  runQa,
  shouldCaptureGenericAndroidQa
} from "./qa.ts";
import { JobReporter } from "./reporter.ts";
import {
  commandExists,
  exists,
  runCommand,
  type CommandResult,
  type RunCommandOptions
} from "./shell.ts";
import { LocalJobStore } from "./store.ts";

export async function runJob(
  job: Job,
  config: WorkerConfig,
  runtime: { androidAvd?: string; iosSimulatorUdid?: string } = {}
): Promise<void> {
  const store = new LocalJobStore(config);
  const reporter = new JobReporter({
    jobId: job.id,
    store
  });
  const evidence = new EvidenceRecorder();
  const artifactsDir = join(config.artifactsDir, job.id);

  try {
    await mkdir(artifactsDir, { recursive: true });
    await reporter.status("running");
    await reporter.event("job", "info", `Starting job ${job.id}.`);

    const worktree = await prepareWorktree(job, config, reporter, evidence);
    await inspectRepository(worktree, artifactsDir, reporter, evidence);
    await runProfileSetup(job, config, worktree, reporter, evidence);
    let androidSerial: string | undefined;
    if ((job.qa === "android" || job.qa === "both" || job.qa === "all") && config.enableAndroidQa) {
      try {
        androidSerial = await ensureAndroidDevice(config, reporter, evidence, runtime.androidAvd);
      } catch (error) {
        await reporter.event(
          "qa",
          "warn",
          `Android device preflight failed: ${errorMessage(error)}`
        );
      }
      if (!androidSerial && configuredAndroidProvisioning(config)) {
        throw new Error("Android APK provisioning is configured, but no exclusive Android device is available.");
      }
      if (androidSerial) {
        await provisionAndroidApp(config, androidSerial, reporter, evidence);
        if (shouldCaptureGenericAndroidQa(job)) {
          try {
            await recordAndroidClip(
              "before-qa-screenrecord.mp4",
              10,
              artifactsDir,
              reporter,
              evidence,
              androidSerial
            );
          } catch (error) {
            await reporter.event(
              "qa",
              "warn",
              `Skipping pre-harness Android recording: ${errorMessage(error)}`
            );
          }
        }
      }
    }
    let harnessError: unknown;
    let harnessFailed = false;
    try {
      await runHarness(job, config, worktree, artifactsDir, reporter, evidence, androidSerial);
    } catch (error) {
      harnessError = error;
      harnessFailed = true;
    }
    await collectAgentArtifacts(job, artifactsDir, store, reporter);
    if (job.checks?.length) {
      await collectCheckResults(job, artifactsDir, store, reporter);
    }
    if (harnessFailed) {
      throw harnessError;
    }
    const qaSummaries = await runQa(
      job,
      config,
      artifactsDir,
      reporter,
      evidence,
      androidSerial,
      runtime.iosSimulatorUdid
    );
    for (const summary of qaSummaries) {
      evidence.recordQaSummary(summary);
    }
    await finalizePullRequest(job, worktree, artifactsDir, store, reporter, evidence);

    await reporter.status("completed");
    await writeEvidenceManifest(evidence, job, store, reporter, "Job completed.");
    await sendJobCallback(job, config, reporter, "Job completed.");
    await reporter.event("job", "info", "Job completed.");
  } catch (error) {
    const summary = errorMessage(error);
    await reporter.status("failed");
    await writeEvidenceManifest(evidence, job, store, reporter, summary);
    await sendJobCallback(job, config, reporter, summary);
    await reporter.event("job", "error", summary);
    throw error;
  }
}

async function prepareWorktree(
  job: Job,
  config: WorkerConfig,
  reporter: JobReporter,
  evidence: EvidenceRecorder
): Promise<string> {
  await mkdir(config.reposDir, { recursive: true });
  await mkdir(config.worktreesDir, { recursive: true });

  const cacheDir = join(config.reposDir, repoCacheKey(job.repo));
  const worktree = join(
    config.worktreesDir,
    `${job.id}-${worktreeSlug(job.branch)}`
  );
  if (await exists(worktree)) {
    await rm(worktree, { force: true, recursive: true });
  }

  if (await exists(cacheDir)) {
    await reporter.event("repo", "info", "Fetching latest origin/main.", {
      cacheDir
    });
    await runObservedChecked(
      evidence,
      "git",
      ["-C", cacheDir, "fetch", "origin", "main", "--prune"],
      { timeoutMs: 120_000 }
    );
  } else {
    await reporter.event("repo", "info", "Cloning bare repository cache.", {
      repo: job.repo,
      cacheDir
    });
    await runObservedChecked(evidence, "git", ["clone", "--bare", job.repo, cacheDir], {
      timeoutMs: 300_000
    });
  }

  const worktreeRef = job.ref
    ? await resolveWorktreeRef(job.ref, cacheDir, reporter, evidence)
    : "origin/main";

  await runObservedCommand(evidence, "git", ["-C", cacheDir, "worktree", "prune"], {
    timeoutMs: 60_000
  });
  await reporter.event("repo", "info", `Creating worktree ${job.branch}.`, {
    ref: worktreeRef,
    worktree
  });
  await runObservedChecked(
    evidence,
    "git",
    ["-C", cacheDir, "worktree", "add", "-B", job.branch, worktree, worktreeRef],
    { timeoutMs: 120_000 }
  );
  return worktree;
}

async function resolveWorktreeRef(
  ref: string,
  cacheDir: string,
  reporter: JobReporter,
  evidence: EvidenceRecorder
): Promise<string> {
  const revParseArgs = ["-C", cacheDir, "rev-parse", "--verify", `${ref}^{commit}`];
  let resolved = await runObservedCommand(evidence, "git", revParseArgs, {
    timeoutMs: 60_000
  });
  if (resolved.code !== 0) {
    await reporter.event("repo", "info", `Fetching requested ref ${ref}.`);
    await runObservedCommand(
      evidence,
      "git",
      ["-C", cacheDir, "fetch", "origin", ref],
      { timeoutMs: 120_000 }
    );
    resolved = await runObservedCommand(evidence, "git", revParseArgs, {
      timeoutMs: 60_000
    });
  }
  const commit = resolved.stdout.trim();
  if (resolved.code !== 0 || !commit) {
    throw new Error(`Requested ref "${ref}" could not be resolved to a commit.`);
  }
  return commit;
}

async function inspectRepository(
  worktree: string,
  artifactsDir: string,
  reporter: JobReporter,
  evidence: EvidenceRecorder
): Promise<void> {
  const agentInstructions = join(worktree, "AGENTS.md");
  if (await exists(agentInstructions)) {
    const content = await readFile(agentInstructions, "utf8");
    await writeFile(join(artifactsDir, "AGENTS.md"), content);
    await reporter.uploadArtifact("AGENTS.md", content, "text/markdown");
    evidence.recordAgentsFile("AGENTS.md");
    await reporter.event("repo", "info", "Loaded AGENTS.md instructions.");
  }

  if (await exists(join(worktree, "flake.nix"))) {
    evidence.recordFlake();
    await reporter.event("repo", "info", "Evaluating Nix flake outputs.");
    const result = await runObservedCommand(
      evidence,
      "nix",
      ["flake", "show", "--json", "--no-write-lock-file"],
      { cwd: worktree, timeoutMs: 180_000 }
    );
    await writeFile(
      join(artifactsDir, "nix-flake-show.json"),
      result.stdout || result.stderr
    );
    await reporter.uploadArtifact(
      "nix-flake-show.json",
      result.stdout || result.stderr,
      "application/json"
    );
    if (result.code !== 0) {
      await reporter.event("repo", "warn", "nix flake show failed.", {
        stderr: result.stderr.slice(-4000)
      });
    }
  }

  if (await exists(join(worktree, "justfile")) || await exists(join(worktree, "Justfile"))) {
    const result = await runObservedCommand(evidence, "just", ["--list"], {
      cwd: worktree,
      timeoutMs: 60_000
    });
    evidence.recordJustfile(parseJustRecipes(result.stdout));
    await writeFile(join(artifactsDir, "just-list.txt"), result.stdout + result.stderr);
    await reporter.uploadArtifact("just-list.txt", result.stdout + result.stderr, "text/plain");
  }
}

async function runProfileSetup(
  job: Job,
  config: WorkerConfig,
  worktree: string,
  reporter: JobReporter,
  evidence: EvidenceRecorder
): Promise<void> {
  const issueTracker = metadataString(job, "issueTracker") ?? config.issueTrackerAdapter;
  const repoBootstrap = metadataString(job, "repoBootstrap") ?? config.repoBootstrapAdapter;

  if (issueTracker === "linear") {
    const issue = await ensureLinearIssue(job, {
      apiKey: config.issueTrackerApiKey,
      inProgressState: config.issueTrackerInProgressState,
      teamKey: config.issueTrackerTeamKey
    });
    if (issue) {
      await reporter.event("repo", "info", `Using issue tracker issue ${issue}.`);
    } else {
      await reporter.event(
        "repo",
        "warn",
        "Issue tracker adapter is enabled but no issue was available or created; configure URIEL_ADAPTER_ISSUE_TRACKER_API_KEY and URIEL_ADAPTER_ISSUE_TRACKER_TEAM_KEY to allow creation."
      );
    }
  }

  if (repoBootstrap === "direnv") {
    if (await commandExists("direnv")) {
      await reporter.event("repo", "info", "Allowing direnv for repository bootstrap.");
      await runObservedCommand(evidence, "direnv", ["allow"], { cwd: worktree, timeoutMs: 60_000 });
    } else {
      await reporter.event("repo", "warn", "direnv is missing; skipping direnv bootstrap.");
    }
  }
}

async function runHarness(
  job: Job,
  config: WorkerConfig,
  worktree: string,
  artifactsDir: string,
  reporter: JobReporter,
  evidence: EvidenceRecorder,
  androidSerial?: string
): Promise<void> {
  const harnessId = metadataString(job, "harness") ?? config.harnessAdapter ?? "opencode";
  if (!isHarnessId(harnessId)) {
    throw new Error(`Unknown harness adapter: ${harnessId}.`);
  }

  const harnessConfig = harnessId === "codex"
    ? { effort: config.codexEffort, model: config.codexModel }
    : { model: harnessId === "opencode" ? config.opencodeModel : config.claudeModel };
  const invocation = buildHarnessInvocation(harnessId, {
    branch: job.branch,
    ...harnessConfig,
    prompt: buildPrompt(job, artifactsDir),
    worktree
  });
  const transcriptPath = join(artifactsDir, invocation.transcriptArtifact);

  if (config.dryRun || !(await commandExists(invocation.command))) {
    const message = config.dryRun
      ? "URIEL_DRY_RUN enabled; skipping harness execution."
      : `${invocation.command} is missing; writing a dry-run transcript.`;
    await reporter.event("worker", "warn", message);
    await writeFile(transcriptPath, JSON.stringify({ message, prompt: job.prompt }) + "\n");
    await reporter.uploadArtifact(
      invocation.transcriptArtifact,
      await readFile(transcriptPath),
      "application/x-ndjson"
    );
    return;
  }

  await reporter.event("worker", "info", `Running ${harnessId} headlessly.`);
  const result = await runObservedCommand(evidence, invocation.command, invocation.args, {
    cwd: worktree,
    ...(androidSerial ? { env: { ANDROID_SERIAL: androidSerial } } : {}),
    timeoutMs: config.harnessTimeoutMinutes * 60_000
  });
  await writeFile(transcriptPath, result.stdout + result.stderr);
  await reporter.uploadArtifact(
    invocation.transcriptArtifact,
    await readFile(transcriptPath),
    "application/x-ndjson"
  );
  if (result.code !== 0) {
    throw new Error(`${harnessId} failed with ${result.code}.`);
  }
}

async function collectAgentArtifacts(
  job: Job,
  artifactsDir: string,
  store: LocalJobStore,
  reporter: JobReporter
): Promise<void> {
  const latest = await store.getJob(job.id);
  const registered = new Set(latest?.artifacts.map((artifact) => artifact.name) ?? []);
  const files = await listFiles(artifactsDir);
  for (const path of files) {
    const name = relative(artifactsDir, path);
    if (name === "check-results.json" || registered.has(name)) {
      continue;
    }
    await reporter.registerArtifact(name);
    registered.add(name);
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files.sort();
}

async function collectCheckResults(
  job: Job,
  artifactsDir: string,
  store: LocalJobStore,
  reporter: JobReporter
): Promise<void> {
  if (!job.checks?.length) {
    return;
  }
  let raw = "";
  try {
    raw = await readFile(join(artifactsDir, "check-results.json"), "utf8");
  } catch {
    raw = "";
  }
  const parsed = parseCheckResults(raw, job.checks);
  for (const warning of parsed.warnings) {
    await reporter.event("qa", "warn", warning);
  }

  const latest = await store.getJob(job.id);
  const artifactNames = new Set(
    latest?.artifacts.map((artifact) => artifact.name) ?? []
  );
  const results: CheckResult[] = [];
  for (const result of parsed.results) {
    const artifacts: string[] = [];
    for (const name of result.artifacts ?? []) {
      if (artifactNames.has(name)) {
        artifacts.push(name);
      } else {
        await reporter.event(
          "qa",
          "warn",
          `Dropped unregistered artifact reference "${name}" from check result "${result.id}".`
        );
      }
    }
    const evidence = result.evidence?.filter((item) => artifactNames.has(item.artifact));
    const verifiedResult = enforceCheckResultEvidence({
      ...result,
      ...(result.artifacts ? { artifacts } : {}),
      ...(result.evidence ? { evidence } : {})
    });
    if (verifiedResult.verdict !== result.verdict) {
      await reporter.event(
        "qa",
        "warn",
        `Downgraded check result "${result.id}" from pass to unsure because it has no captured outcome evidence.`
      );
    }
    results.push(verifiedResult);
  }
  await store.setCheckResults(job.id, results);
}

async function finalizePullRequest(
  job: Job,
  worktree: string,
  artifactsDir: string,
  store: LocalJobStore,
  reporter: JobReporter,
  evidence: EvidenceRecorder
): Promise<void> {
  if (job.kind === "verify") {
    await reporter.event(
      "repo",
      "info",
      "Verify jobs do not push branches or open pull requests."
    );
    return;
  }

  const status = await runObservedChecked(evidence, "git", ["status", "--porcelain"], {
    cwd: worktree
  });
  if (!status.stdout.trim()) {
    await reporter.event("repo", "warn", "No file changes were produced.");
    return;
  }

  await runObservedChecked(evidence, "git", ["add", "-A"], { cwd: worktree });
  await runObservedChecked(
    evidence,
    "git",
    ["commit", "-m", summarizeCommit(job.prompt)],
    { cwd: worktree, timeoutMs: 120_000 }
  );
  await runObservedChecked(evidence, "git", ["push", "-u", "origin", job.branch], {
    cwd: worktree,
    timeoutMs: 300_000
  });

  if (!(await commandExists("gh"))) {
    await reporter.event("repo", "warn", "gh is missing; branch pushed but PR was not created.");
    return;
  }

  const prBody = buildPullRequestBody(job);
  const bodyPath = join(artifactsDir, "pull-request-body.md");
  await writeFile(bodyPath, prBody);
  const pr = await runObservedCommand(
    evidence,
    "gh",
    [
      "pr",
      "create",
      "--draft",
      "--title",
      summarizeCommit(job.prompt),
      "--body-file",
      bodyPath
    ],
    { cwd: worktree, timeoutMs: 120_000 }
  );
  if (pr.code !== 0) {
    await reporter.event("repo", "warn", "PR creation failed.", {
      stderr: pr.stderr.slice(-4000)
    });
    return;
  }
  evidence.recordPullRequest(pr.stdout.trim());
  await store.setPullRequestUrl(job.id, pr.stdout.trim());
  await reporter.event("repo", "info", "Draft PR created.", {
    url: pr.stdout.trim()
  });
}

async function runObservedCommand(
  evidence: EvidenceRecorder,
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  evidence.recordCommand(command, args, result, options);
  return result;
}

async function runObservedChecked(
  evidence: EvidenceRecorder,
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  const result = await runObservedCommand(evidence, command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.code}\n${result.stderr}`
    );
  }
  return result;
}

async function writeEvidenceManifest(
  evidence: EvidenceRecorder,
  fallbackJob: Job,
  store: LocalJobStore,
  reporter: JobReporter,
  summary: string
): Promise<void> {
  try {
    const latest = await store.getJob(fallbackJob.id);
    await evidence.write(latest ?? fallbackJob, latest?.artifacts ?? [], reporter, summary);
  } catch (error) {
    console.error(`Failed to write evidence manifest: ${errorMessage(error)}`);
  }
}

function buildPrompt(job: Job, artifactsDir: string): string {
  return [
    "You are Uriel, a remote NixOS-first coding agent.",
    "Follow this repository's AGENTS.md instructions exactly.",
    `Branch: ${job.branch}`,
    job.kind === "verify" ? "Kind: verify" : undefined,
    job.issue ? `Issue: ${job.issue}` : undefined,
    `Requested QA: ${job.qa}`,
    "",
    job.prompt,
    job.checks?.length
      ? `\n${buildChecksPromptSection(
          job.checks,
          join(artifactsDir, "check-results.json"),
          artifactsDir
        )}`
      : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

export async function sendJobCallback(
  fallbackJob: Job,
  config: WorkerConfig,
  reporter: JobReporter,
  summary: string
): Promise<void> {
  try {
    const job = (await reporter.getJob()) ?? fallbackJob;
    if (!job.callbackUrl) {
      return;
    }

    if (!config.callbackSecret) {
      await callbackEvent(
        reporter,
        "warn",
        "Job callback is configured without URIEL_CALLBACK_SECRET; sending an unsigned callback."
      );
    }

    const payload = buildJobCallbackPayload(job, summary);
    const body = JSON.stringify(payload);
    const signature = config.callbackSecret
      ? await signPayloadSha256(config.callbackSecret, body)
      : undefined;
    const delays = [0, 5_000, 30_000];
    for (const [index, delayMs] of delays.entries()) {
      if (delayMs > 0) {
        await delay(delayMs);
      }
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        config.callbackTimeoutSeconds * 1_000
      );
      try {
        const response = await fetch(job.callbackUrl, {
          body,
          headers: {
            "content-type": "application/json",
            "x-uriel-event": payload.event,
            "x-uriel-job-id": job.id,
            ...(signature ? { "x-uriel-signature": signature } : {})
          },
          method: "POST",
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return;
      } catch (error) {
        await callbackEvent(
          reporter,
          "warn",
          `Job callback attempt ${index + 1} failed: ${errorMessage(error)}`
        );
      } finally {
        clearTimeout(timeout);
      }
    }
    await callbackEvent(reporter, "error", "Job callback failed after 3 attempts.");
  } catch (error) {
    await callbackEvent(
      reporter,
      "error",
      `Job callback could not be sent: ${errorMessage(error)}`
    );
  }
}

async function callbackEvent(
  reporter: JobReporter,
  level: "warn" | "error",
  message: string
): Promise<void> {
  try {
    await reporter.event("worker", level, message);
  } catch (error) {
    console.error(`${message} Event recording failed: ${errorMessage(error)}`);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildPullRequestBody(job: Job): string {
  return [
    `Automated Uriel job: ${job.id}`,
    "",
    `Source: ${job.source}`,
    `QA requested: ${job.qa}`,
    job.issue ? `Issue: ${job.issue}` : undefined,
    "",
    "Evidence artifacts are stored in the Uriel worker artifact directory."
  ]
    .filter(Boolean)
    .join("\n");
}

function summarizeCommit(prompt: string): string {
  const summary = prompt.split(/\n/u)[0]?.trim() || "Uriel agent changes";
  return summary.length > 72 ? `${summary.slice(0, 69)}...` : summary;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function metadataString(job: Job, key: string): string | undefined {
  const value = job.metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
