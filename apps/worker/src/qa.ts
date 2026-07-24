import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Job } from "../../../packages/core/src/index.ts";
import type { WorkerConfig } from "./config.ts";
import type { EvidenceRecorder } from "./evidence.ts";
import type { JobReporter } from "./reporter.ts";
import {
  commandExists,
  exists,
  quote,
  runCommand,
  type CommandResult,
  type RunCommandOptions
} from "./shell.ts";

export async function runQa(
  job: Job,
  config: WorkerConfig,
  artifactsDir: string,
  reporter: JobReporter,
  evidence?: EvidenceRecorder,
  androidSerial?: string
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
    summaries.push(await runAndroidQa(job, config, artifactsDir, reporter, evidence, androidSerial));
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
  evidence?: EvidenceRecorder,
  requestedSerial?: string
): Promise<string> {
  if (!config.enableAndroidQa) {
    await reporter.event("qa", "warn", "Skipping Android QA; Android QA is disabled.");
    return "Android QA skipped: disabled by worker config.";
  }

  const serial = requestedSerial ?? await ensureAndroidDevice(config, reporter, evidence);
  if (!serial) {
    return "Android QA skipped: no booted adb device is attached.";
  }

  const maestroFlow = typeof job.metadata.maestroFlow === "string"
    ? job.metadata.maestroFlow
    : undefined;
  if (!shouldCaptureGenericAndroidQa(job)) {
    await reporter.event(
      "qa",
      "info",
      "Checklist verification evidence was captured by the harness; skipping generic Android recording."
    );
    return "Android checklist evidence captured by the harness.";
  }

  const recordingName = "android-screenrecord.mp4";
  await recordAndroidClip(recordingName, 10, artifactsDir, reporter, evidence, serial);
  if (!(await exists(join(artifactsDir, recordingName)))) {
    return "Android QA failed: screenrecord failed.";
  }

  if (maestroFlow && await commandExists("maestro")) {
    await reporter.event("qa", "info", `Running Maestro flow ${maestroFlow}.`);
    const maestro = await runObservedCommand(
      evidence,
      "maestro",
      ["test", maestroFlow],
      { timeoutMs: 180_000 }
    );
    await writeFile(join(artifactsDir, "maestro.log"), maestro.stdout + maestro.stderr);
    await uploadIfExists("maestro.log", join(artifactsDir, "maestro.log"), "text/plain", reporter);
  }

  await reporter.event("qa", "info", "Android QA completed.");
  return "Android QA completed.";
}

export function shouldCaptureGenericAndroidQa(
  job: Pick<Job, "kind" | "metadata">
): boolean {
  return job.kind !== "verify" || typeof job.metadata.maestroFlow === "string";
}

export async function ensureAndroidDevice(
  config: WorkerConfig,
  reporter: JobReporter,
  evidence?: EvidenceRecorder,
  requestedAvd: string | undefined = config.androidAvd
): Promise<string | undefined> {
  if (!(await commandExists("adb"))) {
    await reporter.event("qa", "warn", "Skipping Android QA; adb is missing.");
    return undefined;
  }

  const canBootEmulator = (await exists("/dev/kvm")) || process.platform === "darwin";
  if (!canBootEmulator) {
    await reporter.event(
      "qa",
      "info",
      "/dev/kvm is unavailable; relying on an already-booted emulator or attached device."
    );
  }

  await runObservedCommand(evidence, "adb", ["start-server"], { timeoutMs: 30_000 });

  let serial: string | undefined;
  if (requestedAvd) {
    await reporter.event("qa", "info", `Ensuring Android AVD ${requestedAvd} is booted.`);
    serial = await serialForAvd(requestedAvd, evidence);
    if (!serial) {
      if (!canBootEmulator || !(await commandExists("emulator"))) {
        await reporter.event(
          "qa",
          "warn",
          `Android AVD ${requestedAvd} is not attached and this host cannot boot it.`
        );
        return undefined;
      }
      const avd = quote(requestedAvd);
      const launch = await runObservedCommand(evidence, "sh", [
        "-lc",
        `nohup emulator -avd ${avd} -no-snapshot -no-audio -no-window >/tmp/uriel-emulator.log 2>&1 &`
      ]);
      if (launch.code !== 0) {
        await reporter.event("qa", "warn", `Failed to start Android AVD ${requestedAvd}.`, {
          stderr: launch.stderr.slice(-4000)
        });
        return undefined;
      }
    }
    const deadline = Date.now() + config.androidBootTimeoutSeconds * 1_000;
    let bootCompleted = false;
    while (Date.now() < deadline) {
      serial = serial ?? await serialForAvd(requestedAvd, evidence);
      if (!serial) {
        await delay(Math.max(1, Math.min(2_000, deadline - Date.now())));
        continue;
      }
      const boot = await runObservedCommand(
        evidence,
        "adb",
        ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        { timeoutMs: Math.max(1, Math.min(5_000, deadline - Date.now())) }
      );
      if (boot.code === 0 && boot.stdout.trim() === "1") {
        bootCompleted = true;
        break;
      }
      await delay(Math.max(1, Math.min(2_000, deadline - Date.now())));
    }
    if (!bootCompleted) {
      await reporter.event(
        "qa",
        "warn",
        `Skipping Android recording because AVD ${requestedAvd} did not finish booting within ${config.androidBootTimeoutSeconds} seconds.`
      );
      return undefined;
    }
  } else {
    const devices = await attachedDeviceSerials(evidence);
    const inheritedSerial = process.env.ANDROID_SERIAL?.trim();
    if (inheritedSerial) {
      if (!devices.includes(inheritedSerial)) {
        await reporter.event(
          "qa",
          "warn",
          `ANDROID_SERIAL=${inheritedSerial} is not an attached adb device.`
        );
        return undefined;
      }
      serial = inheritedSerial;
    } else if (devices.length === 1) {
      serial = devices[0];
    } else if (devices.length > 1) {
      await reporter.event(
        "qa",
        "warn",
        "Skipping Android QA because multiple adb devices are attached and no AVD/ANDROID_SERIAL selected one.",
        { devices }
      );
      return undefined;
    }
  }

  if (!serial) {
    await reporter.event(
      "qa",
      "warn",
      "Skipping Android recording because no booted adb device is attached.",
    );
    return undefined;
  }
  await reporter.event("qa", "info", `Android QA bound to ${serial}.`, {
    ...(requestedAvd ? { avd: requestedAvd } : {})
  });
  return serial;
}

export async function recordAndroidClip(
  name: string,
  seconds: number,
  artifactsDir: string,
  reporter: JobReporter,
  evidence?: EvidenceRecorder,
  serial?: string
): Promise<void> {
  const remotePath = `/sdcard/uriel-${process.pid}-${Date.now()}.mp4`;
  const localPath = join(artifactsDir, name);
  await reporter.event("qa", "info", `Recording Android screen for ${seconds} seconds.`);
  const record = await runObservedCommand(
    evidence,
    "adb",
    [...adbTarget(serial), "shell", "screenrecord", "--time-limit", String(seconds), remotePath],
    { timeoutMs: Math.max(20_000, seconds * 1_000 + 10_000) }
  );
  if (record.code !== 0) {
    await reporter.event("qa", "error", "Android screenrecord failed.", {
      stderr: record.stderr.slice(-4000)
    });
    return;
  }
  const pull = await runObservedCommand(evidence, "adb", [...adbTarget(serial), "pull", remotePath, localPath], {
    timeoutMs: 30_000
  });
  await runObservedCommand(evidence, "adb", [...adbTarget(serial), "shell", "rm", "-f", remotePath], {
    timeoutMs: 30_000
  });
  if (pull.code !== 0) {
    await reporter.event("qa", "error", "Failed to pull Android recording.", {
      stderr: pull.stderr.slice(-4000)
    });
    return;
  }

  await uploadIfExists(name, localPath, "video/mp4", reporter);
}

export function parseAdbDeviceSerials(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => /^(\S+)\s+device(?:\s|$)/u.exec(line)?.[1])
    .filter((serial): serial is string => Boolean(serial));
}

async function attachedDeviceSerials(evidence?: EvidenceRecorder): Promise<string[]> {
  const result = await runObservedCommand(evidence, "adb", ["devices"], { timeoutMs: 30_000 });
  return result.code === 0 ? parseAdbDeviceSerials(result.stdout) : [];
}

async function serialForAvd(
  requestedAvd: string,
  evidence?: EvidenceRecorder
): Promise<string | undefined> {
  for (const serial of await attachedDeviceSerials(evidence)) {
    const result = await runObservedCommand(
      evidence,
      "adb",
      ["-s", serial, "emu", "avd", "name"],
      { timeoutMs: 5_000 }
    );
    const avd = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line && line !== "OK");
    if (result.code === 0 && avd === requestedAvd) return serial;
  }
  return undefined;
}

function adbTarget(serial: string | undefined): string[] {
  return serial ? ["-s", serial] : [];
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
