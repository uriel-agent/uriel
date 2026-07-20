import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Job } from "../../../packages/core/src/index.ts";
import type { WorkerConfig } from "./config.ts";
import type { EvidenceRecorder } from "./evidence.ts";
import type { JobReporter } from "./reporter.ts";
import {
  commandExists,
  exists,
  runCommand,
  type CommandResult,
  type RunCommandOptions
} from "./shell.ts";

export async function runQa(
  job: Job,
  config: WorkerConfig,
  artifactsDir: string,
  reporter: JobReporter,
  evidence?: EvidenceRecorder
): Promise<string[]> {
  const summaries: string[] = [];
  if (job.qa === "none") {
    await reporter.event("qa", "info", "QA not requested for this job.");
    return ["QA not requested."];
  }

  if (job.qa === "browser" || job.qa === "both") {
    summaries.push(await runBrowserQa(config, artifactsDir, reporter, evidence));
  }

  if (job.qa === "android" || job.qa === "both") {
    summaries.push(await runAndroidQa(job, config, artifactsDir, reporter, evidence));
  }

  return summaries;
}

async function runBrowserQa(
  config: WorkerConfig,
  artifactsDir: string,
  reporter: JobReporter,
  evidence?: EvidenceRecorder
): Promise<string> {
  if (!config.enableBrowserQa) {
    await reporter.event("qa", "warn", "Skipping browser QA; browser QA is disabled.");
    return "Browser QA skipped: disabled by worker config.";
  }

  if (!config.browserUrl) {
    await reporter.event(
      "qa",
      "warn",
      "Skipping browser QA because URIEL_BROWSER_URL is not configured."
    );
    return "Browser QA skipped: URIEL_BROWSER_URL is not configured.";
  }

  if (!(await commandExists("npx"))) {
    await reporter.event("qa", "warn", "Skipping browser QA; npx is missing.");
    return "Browser QA skipped: npx is missing.";
  }

  const scriptPath = join(artifactsDir, "browser-qa.mjs");
  const screenshotPath = join(artifactsDir, "browser-screenshot.png");
  const tracePath = join(artifactsDir, "browser-trace.zip");
  const videoDir = join(artifactsDir, "browser-video");
  await writeFile(
    scriptPath,
    `
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  recordVideo: { dir: ${JSON.stringify(videoDir)} }
});
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
await page.goto(${JSON.stringify(config.browserUrl)}, { waitUntil: "networkidle", timeout: 60000 });
await page.screenshot({ path: ${JSON.stringify(screenshotPath)}, fullPage: true });
await context.tracing.stop({ path: ${JSON.stringify(tracePath)} });
await context.close();
await browser.close();
`,
    "utf8"
  );

  const result = await runObservedCommand(
    evidence,
    "npx",
    ["--yes", "-p", "playwright", "node", scriptPath],
    { timeoutMs: 120_000 }
  );
  if (result.code !== 0) {
    await reporter.event("qa", "error", "Browser QA failed.", {
      stderr: result.stderr.slice(-4000)
    });
    return "Browser QA failed.";
  }

  await uploadIfExists("browser-screenshot.png", screenshotPath, "image/png", reporter);
  await uploadIfExists("browser-trace.zip", tracePath, "application/zip", reporter);
  await reporter.event("qa", "info", "Browser QA completed.");
  return "Browser QA completed.";
}

async function runAndroidQa(
  job: Job,
  config: WorkerConfig,
  artifactsDir: string,
  reporter: JobReporter,
  evidence?: EvidenceRecorder
): Promise<string> {
  if (!config.enableAndroidQa) {
    await reporter.event("qa", "warn", "Skipping Android QA; Android QA is disabled.");
    return "Android QA skipped: disabled by worker config.";
  }

  if (!(await commandExists("adb"))) {
    await reporter.event("qa", "warn", "Skipping Android QA; adb is missing.");
    return "Android QA skipped: adb is missing.";
  }

  const canBootEmulator = (await exists("/dev/kvm")) || process.platform === "darwin";
  if (!canBootEmulator) {
    await reporter.event(
      "qa",
      "info",
      "/dev/kvm is unavailable; relying on an already-booted emulator or attached device."
    );
  }

  if (canBootEmulator && config.androidAvd && (await commandExists("emulator"))) {
    await reporter.event("qa", "info", `Ensuring Android AVD ${config.androidAvd} is booted.`);
    await runObservedCommand(evidence, "sh", [
      "-lc",
      `pgrep -f "emulator.*${config.androidAvd}" >/dev/null || nohup emulator -avd ${config.androidAvd} -no-snapshot -no-audio -no-window >/tmp/uriel-emulator.log 2>&1 &`
    ]);
  }

  await runObservedCommand(evidence, "adb", ["start-server"], { timeoutMs: 30_000 });
  const devices = await runObservedCommand(evidence, "adb", ["devices"], { timeoutMs: 30_000 });
  if (!/\tdevice/u.test(devices.stdout)) {
    await reporter.event(
      "qa",
      "warn",
      "Skipping Android recording because no booted adb device is attached.",
      { devices: devices.stdout }
    );
    return "Android QA skipped: no booted adb device is attached.";
  }

  const remotePath = `/sdcard/uriel-${job.id}.mp4`;
  const localPath = join(artifactsDir, "android-screenrecord.mp4");
  await reporter.event("qa", "info", "Recording Android screen for 10 seconds.");
  const record = await runObservedCommand(
    evidence,
    "adb",
    ["shell", "screenrecord", "--time-limit", "10", remotePath],
    { timeoutMs: 20_000 }
  );
  if (record.code !== 0) {
    await reporter.event("qa", "error", "Android screenrecord failed.", {
      stderr: record.stderr.slice(-4000)
    });
    return "Android QA failed: screenrecord failed.";
  }
  const pull = await runObservedCommand(evidence, "adb", ["pull", remotePath, localPath], {
    timeoutMs: 30_000
  });
  await runObservedCommand(evidence, "adb", ["shell", "rm", "-f", remotePath], {
    timeoutMs: 30_000
  });
  if (pull.code !== 0) {
    await reporter.event("qa", "error", "Failed to pull Android recording.", {
      stderr: pull.stderr.slice(-4000)
    });
    return "Android QA failed: recording pull failed.";
  }

  if (typeof job.metadata.maestroFlow === "string" && await commandExists("maestro")) {
    await reporter.event("qa", "info", `Running Maestro flow ${job.metadata.maestroFlow}.`);
    const maestro = await runObservedCommand(
      evidence,
      "maestro",
      ["test", job.metadata.maestroFlow],
      { timeoutMs: 180_000 }
    );
    await writeFile(join(artifactsDir, "maestro.log"), maestro.stdout + maestro.stderr);
    await uploadIfExists("maestro.log", join(artifactsDir, "maestro.log"), "text/plain", reporter);
  }

  await uploadIfExists("android-screenrecord.mp4", localPath, "video/mp4", reporter);
  await reporter.event("qa", "info", "Android QA completed.");
  return "Android QA completed.";
}

async function runObservedCommand(
  evidence: EvidenceRecorder | undefined,
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  evidence?.recordCommand(command, args, result, options);
  return result;
}

async function uploadIfExists(
  name: string,
  path: string,
  contentType: string,
  reporter: JobReporter
): Promise<void> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return;
    }
    await reporter.uploadArtifact(name, await readFile(path), contentType);
  } catch {
    return;
  }
}
