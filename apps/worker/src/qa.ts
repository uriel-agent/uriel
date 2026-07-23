import { readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
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
    summaries.push(
      await runAndroidQa(
        job,
        config,
        artifactsDir,
        reporter,
        evidence,
        androidSerial
      )
    );
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

  const serial =
    requestedSerial ?? (await ensureAndroidDevice(config, reporter, evidence));
  if (!serial) {
    return "Android QA skipped: no booted adb device is attached.";
  }

  const recordingName = "android-screenrecord.mp4";
  await recordAndroidClip(
    recordingName,
    10,
    artifactsDir,
    reporter,
    evidence,
    serial
  );
  if (!(await exists(join(artifactsDir, recordingName)))) {
    return "Android QA failed: screenrecord failed.";
  }

  if (typeof job.metadata.maestroFlow === "string" && await commandExists("maestro")) {
    await reporter.event("qa", "info", `Running Maestro flow ${job.metadata.maestroFlow}.`);
    const maestro = await runObservedCommand(
      evidence,
      "maestro",
      ["test", job.metadata.maestroFlow],
      {
        env: { ANDROID_SERIAL: serial },
        timeoutMs: 180_000
      }
    );
    await writeFile(join(artifactsDir, "maestro.log"), maestro.stdout + maestro.stderr);
    await uploadIfExists("maestro.log", join(artifactsDir, "maestro.log"), "text/plain", reporter);
  }

  await reporter.event("qa", "info", "Android QA completed.");
  return "Android QA completed.";
}

export async function ensureAndroidDevice(
  config: WorkerConfig,
  reporter: JobReporter,
  evidence?: EvidenceRecorder
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

  const emulatorCommand = await resolveEmulatorCommand(config);
  let serial = config.androidSerial;
  if (!serial && config.androidAvd) {
    serial = await serialForAvd(config.androidAvd, evidence);
  }

  let waitForBoot = Boolean(serial);
  if (canBootEmulator && config.androidAvd && emulatorCommand && !serial) {
    await reporter.event("qa", "info", `Ensuring Android AVD ${config.androidAvd} is booted.`);
    const avd = quote(config.androidAvd);
    const executable = quote(emulatorCommand);
    const logName = config.androidAvd.replace(/[^a-zA-Z0-9_.-]/gu, "_");
    await runObservedCommand(evidence, "sh", [
      "-lc",
      `nohup ${executable} -avd ${avd} -no-snapshot -no-audio -no-window >/tmp/uriel-emulator-${logName}.log 2>&1 &`
    ]);
    waitForBoot = true;
  } else if (config.androidAvd && !emulatorCommand && !serial) {
    await reporter.event(
      "qa",
      "warn",
      `Cannot boot Android AVD ${config.androidAvd}; set URIEL_ANDROID_EMULATOR_PATH or add emulator to PATH.`
    );
  }

  await runObservedCommand(evidence, "adb", ["start-server"], { timeoutMs: 30_000 });
  if (waitForBoot) {
    serial = await waitForAndroidBoot(config, serial, evidence);
    if (!serial) {
      await reporter.event(
        "qa",
        "warn",
        `Skipping Android recording because the emulator did not finish booting within ${Math.round(config.androidBootTimeoutMs / 1_000)} seconds.`
      );
      return undefined;
    }
  }

  const devices = await runObservedCommand(evidence, "adb", ["devices"], { timeoutMs: 30_000 });
  const bootedSerials = parseBootedDeviceSerials(devices.stdout);
  if (serial && !bootedSerials.includes(serial)) {
    await reporter.event(
      "qa",
      "warn",
      `Skipping Android recording because configured device ${serial} is not booted.`,
      { devices: devices.stdout, serial }
    );
    return undefined;
  }
  if (!serial && bootedSerials.length === 1) {
    [serial] = bootedSerials;
  }
  if (!serial) {
    await reporter.event(
      "qa",
      "warn",
      bootedSerials.length === 0
        ? "Skipping Android recording because no booted adb device is attached."
        : "Skipping Android recording because multiple devices are attached; configure URIEL_ANDROID_SERIAL or URIEL_ANDROID_AVD.",
      { devices: devices.stdout }
    );
    return undefined;
  }
  await reporter.event("qa", "info", `Using Android device ${serial}.`);
  return serial;
}

async function waitForAndroidBoot(
  config: WorkerConfig,
  initialSerial: string | undefined,
  evidence?: EvidenceRecorder
): Promise<string | undefined> {
  const deadline = Date.now() + config.androidBootTimeoutMs;
  let serial = initialSerial;
  while (Date.now() < deadline) {
    if (!serial && config.androidAvd) {
      serial = await serialForAvd(config.androidAvd, evidence);
    }
    if (serial) {
      const boot = await runObservedCommand(
        evidence,
        "adb",
        ["-s", serial, "shell", "getprop", "sys.boot_completed"],
        { timeoutMs: Math.max(1, Math.min(5_000, deadline - Date.now())) }
      );
      if (boot.code === 0 && boot.stdout.trim() === "1") {
        return serial;
      }
    }
    await delay(Math.max(1, Math.min(2_000, deadline - Date.now())));
  }
  return undefined;
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
    [
      ...(serial ? ["-s", serial] : []),
      "shell",
      "screenrecord",
      "--time-limit",
      String(seconds),
      remotePath
    ],
    { timeoutMs: Math.max(20_000, seconds * 1_000 + 10_000) }
  );
  if (record.code !== 0) {
    await reporter.event("qa", "error", "Android screenrecord failed.", {
      stderr: record.stderr.slice(-4000)
    });
    return;
  }
  const targetArgs = serial ? ["-s", serial] : [];
  const pull = await runObservedCommand(
    evidence,
    "adb",
    [...targetArgs, "pull", remotePath, localPath],
    { timeoutMs: 30_000 }
  );
  await runObservedCommand(
    evidence,
    "adb",
    [...targetArgs, "shell", "rm", "-f", remotePath],
    { timeoutMs: 30_000 }
  );
  if (pull.code !== 0) {
    await reporter.event("qa", "error", "Failed to pull Android recording.", {
      stderr: pull.stderr.slice(-4000)
    });
    return;
  }

  await uploadIfExists(name, localPath, "video/mp4", reporter);
}

async function resolveEmulatorCommand(
  config: WorkerConfig
): Promise<string | undefined> {
  const candidates = [
    config.androidEmulatorPath,
    process.env.ANDROID_SDK_ROOT
      ? join(process.env.ANDROID_SDK_ROOT, "emulator", "emulator")
      : undefined,
    process.env.ANDROID_HOME
      ? join(process.env.ANDROID_HOME, "emulator", "emulator")
      : undefined,
    process.platform === "darwin"
      ? join(homedir(), "Library", "Android", "sdk", "emulator", "emulator")
      : undefined
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return (await commandExists("emulator")) ? "emulator" : undefined;
}

async function serialForAvd(
  avd: string,
  evidence?: EvidenceRecorder
): Promise<string | undefined> {
  const devices = await runObservedCommand(evidence, "adb", ["devices"], {
    timeoutMs: 30_000
  });
  for (const serial of parseBootedDeviceSerials(devices.stdout)) {
    if (!serial.startsWith("emulator-")) {
      continue;
    }
    const result = await runObservedCommand(
      evidence,
      "adb",
      ["-s", serial, "emu", "avd", "name"],
      { timeoutMs: 5_000 }
    );
    const name = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line && line !== "OK");
    if (result.code === 0 && name === avd) {
      return serial;
    }
  }
  return undefined;
}

export function parseBootedDeviceSerials(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => /^([^\s]+)\s+device$/u.exec(line)?.[1])
    .filter((serial): serial is string => Boolean(serial));
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
