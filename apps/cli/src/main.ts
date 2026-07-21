import { readFile } from "node:fs/promises";

import {
  isRecord,
  validateCreateJobRequest,
  validateJobChecks,
  type Job,
  type QaMode
} from "../../../packages/core/src/index.ts";

interface CliConfig {
  token?: string;
  workerUrl: string;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const config = loadConfig(rest);

  if (command === "submit") {
    const checks = await readChecksFile(valueAfter(rest, "--checks-file"));
    const payload = {
      callbackUrl: valueAfter(rest, "--callback-url"),
      ...(checks ? { checks } : {}),
      issue: valueAfter(rest, "--issue"),
      kind: valueAfter(rest, "--kind"),
      metadata: compactMetadata({
        harness: valueAfter(rest, "--harness"),
        issueTracker: valueAfter(rest, "--issue-tracker"),
        repoBootstrap: valueAfter(rest, "--repo-bootstrap")
      }),
      prompt: requiredValue(rest, "--prompt"),
      profile: valueAfter(rest, "--profile"),
      qa: (valueAfter(rest, "--qa") ?? "none") as QaMode,
      ref: valueAfter(rest, "--ref"),
      repo: requiredValue(rest, "--repo"),
      source: "api" as const
    };
    const validation = validateCreateJobRequest(payload);
    if (!validation.ok) {
      throw new Error(validation.error);
    }
    const response = await apiFetch(config, "/jobs", {
      body: JSON.stringify(validation.value),
      method: "POST"
    });
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }

  if (command === "status") {
    const jobId = rest[0];
    if (!jobId) {
      throw new Error("urielctl status requires <job-id>.");
    }
    const response = await apiFetch(config, `/jobs/${encodeURIComponent(jobId)}`);
    const job = (await response.json()) as Job;
    console.log(JSON.stringify(job, null, 2));
    for (const result of job.checkResults ?? []) {
      console.log(`  [${result.verdict}] ${result.id} — ${result.notes ?? ""}`);
    }
    return;
  }

  if (command === "approve") {
    const [jobId, stepId] = rest;
    if (!jobId || !stepId) {
      throw new Error("urielctl approve requires <job-id> <step-id>.");
    }
    const response = await apiFetch(
      config,
      `/jobs/${encodeURIComponent(jobId)}/approve/${encodeURIComponent(stepId)}`,
      { method: "POST" }
    );
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }

  if (command === "cancel") {
    const jobId = rest[0];
    if (!jobId) {
      throw new Error("urielctl cancel requires <job-id>.");
    }
    const response = await apiFetch(
      config,
      `/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" }
    );
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }

  console.log(`Usage:
  urielctl submit --repo <github-url> --prompt <text> [--kind change|verify] [--ref <ref>] [--checks-file <path>] [--callback-url <url>] [--issue ISSUE-123] [--profile <id>] [--harness opencode|claude-code|codex] [--issue-tracker <adapter>] [--repo-bootstrap <adapter>] [--qa browser|android|both]
  urielctl status <job-id>
  urielctl approve <job-id> <step-id>
  urielctl cancel <job-id>

Environment:
  URIEL_WORKER_URL=http://127.0.0.1:8788
  URIEL_WORKER_TOKEN=...`);
}

async function readChecksFile(path: string | undefined) {
  if (!path) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Could not read checks file ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const validation = validateJobChecks(
    isRecord(parsed) && "checks" in parsed ? parsed.checks : parsed
  );
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  return validation.value;
}

async function apiFetch(
  config: CliConfig,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const response = await fetch(new URL(path, config.workerUrl), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      ...init.headers
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  return response;
}

function loadConfig(args: string[]): CliConfig {
  const url =
    valueAfter(args, "--worker-url") ?? process.env.URIEL_WORKER_URL ?? "http://127.0.0.1:8788";
  if (!url) {
    throw new Error("Set URIEL_WORKER_URL or pass --worker-url <url>.");
  }
  return {
    token: valueAfter(args, "--token") ?? process.env.URIEL_WORKER_TOKEN,
    workerUrl: url
  };
}

function requiredValue(args: string[], flag: string): string {
  const value = valueAfter(args, flag);
  if (!value) {
    throw new Error(`Missing required ${flag}.`);
  }
  return value;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function compactMetadata(
  input: Record<string, string | undefined>
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value) {
      output[key] = value;
    }
  }
  return output;
}

void main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
