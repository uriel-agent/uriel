import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildHarnessInvocation,
  isHarnessId,
  parseJustRecipes,
  repoCacheKey,
  type Job,
  worktreeSlug
} from "../../../packages/core/src/index.ts";
import type { WorkerConfig } from "./config.ts";
import { EvidenceRecorder } from "./evidence.ts";
import { ensureLinearIssue } from "./linear.ts";
import { runQa } from "./qa.ts";
import { JobReporter } from "./reporter.ts";
import {
  commandExists,
  exists,
  runCommand,
  type CommandResult,
  type RunCommandOptions
} from "./shell.ts";
import { LocalJobStore } from "./store.ts";

export async function runJob(job: Job, config: WorkerConfig): Promise<void> {
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
    await runHarness(job, config, worktree, artifactsDir, reporter, evidence);
    const qaSummaries = await runQa(job, config, artifactsDir, reporter, evidence);
    for (const summary of qaSummaries) {
      evidence.recordQaSummary(summary);
    }
    await finalizePullRequest(job, worktree, artifactsDir, reporter, evidence);

    await reporter.status("completed");
    await writeEvidenceManifest(evidence, job, store, reporter, "Job completed.");
    await reporter.event("job", "info", "Job completed.");
  } catch (error) {
    await reporter.status("failed");
    await writeEvidenceManifest(evidence, job, store, reporter, errorMessage(error));
    await reporter.event("job", "error", errorMessage(error));
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

  await reporter.event("repo", "info", `Creating worktree ${job.branch}.`, {
    worktree
  });
  await runObservedChecked(
    evidence,
    "git",
    ["-C", cacheDir, "worktree", "add", "-B", job.branch, worktree, "origin/main"],
    { timeoutMs: 120_000 }
  );
  return worktree;
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
  evidence: EvidenceRecorder
): Promise<void> {
  const harnessId = metadataString(job, "harness") ?? config.harnessAdapter ?? "opencode";
  if (!isHarnessId(harnessId)) {
    throw new Error(`Unknown harness adapter: ${harnessId}.`);
  }

  const invocation = buildHarnessInvocation(harnessId, {
    branch: job.branch,
    model: harnessId === "opencode" ? config.opencodeModel : config.claudeModel,
    prompt: buildPrompt(job),
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
    timeoutMs: 45 * 60_000
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

async function finalizePullRequest(
  job: Job,
  worktree: string,
  artifactsDir: string,
  reporter: JobReporter,
  evidence: EvidenceRecorder
): Promise<void> {
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

function buildPrompt(job: Job): string {
  return [
    "You are Uriel, a remote NixOS-first coding agent.",
    "Follow this repository's AGENTS.md instructions exactly.",
    `Branch: ${job.branch}`,
    job.issue ? `Issue: ${job.issue}` : undefined,
    `Requested QA: ${job.qa}`,
    "",
    job.prompt
  ]
    .filter(Boolean)
    .join("\n");
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
