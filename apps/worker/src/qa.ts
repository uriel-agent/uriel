import { spawn } from "node:child_process";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Job } from "../../../packages/core/src/index.ts";
import {
  checkAndroidEmulatorAcceleration,
  parseAdbDeviceSerials,
  resolveAndroidTools
} from "./android-tooling.ts";
import {
  androidAvdOwnershipErrors,
  isWorkerOwnedAndroidAvd
} from "./android-ownership.ts";
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
  androidSerial?: string,
  iosSimulatorUdid?: string
): Promise<string[]> {
  const summaries: string[] = [];
  if (job.qa === "none") {
    await reporter.event("qa", "info", "QA not requested for this job.");
    return ["QA not requested."];
  }

  if (job.qa === "browser" || job.qa === "both" || job.qa === "all") {
    summaries.push(await runBrowserQa(config, artifactsDir, reporter, evidence));
  }

  if (job.qa === "android" || job.qa === "both" || job.qa === "all") {
    summaries.push(await runAndroidQa(job, config, artifactsDir, reporter, evidence, androidSerial));
  }

  if (job.qa === "ios" || job.qa === "all") {
    summaries.push(
      await runIosQa(job, config, artifactsDir, reporter, evidence, iosSimulatorUdid)
    );
  }

  return summaries;
}

export { parseAdbDeviceSerials } from "./android-tooling.ts";

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
  const adb = (await resolveAndroidTools(config)).adb;
  if (!adb) {
    await reporter.event("qa", "error", "Android QA failed; adb is no longer executable.");
    return "Android QA failed: adb is not executable.";
  }
  await recordAndroidClip(
    recordingName,
    10,
    artifactsDir,
    reporter,
    evidence,
    serial,
    adb.command
  );
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

export async function runIosQa(
  job: Job,
  config: WorkerConfig,
  artifactsDir: string,
  reporter: JobReporter,
  evidence?: EvidenceRecorder,
  requestedUdid?: string
): Promise<string> {
  if (!config.enableIosQa) {
    await reporter.event("qa", "warn", "Skipping iOS QA; iOS QA is disabled.");
    return "iOS QA skipped: disabled by worker config.";
  }

  const udid = await ensureIosSimulator(config, reporter, evidence, requestedUdid);
  if (!udid) {
    return "iOS QA skipped: no booted simulator is available.";
  }

  const recordingName = "ios-screenrecord.mp4";
  await recordIosClip(recordingName, 10, artifactsDir, reporter, evidence, udid);
  if (!(await exists(join(artifactsDir, recordingName)))) {
    return "iOS QA failed: screen recording failed.";
  }

  const maestroFlow = typeof job.metadata.maestroFlow === "string"
    ? job.metadata.maestroFlow
    : undefined;
  if (maestroFlow && await commandExists("maestro")) {
    await reporter.event("qa", "info", `Running Maestro flow ${maestroFlow} on iOS.`);
    const maestro = await runObservedCommand(
      evidence,
      "maestro",
      ["test", maestroFlow, "--udid", udid],
      { timeoutMs: 180_000 }
    );
    const maestroLogPath = join(artifactsDir, "ios-maestro.log");
    await writeFile(maestroLogPath, maestro.stdout + maestro.stderr);
    await uploadIfExists("ios-maestro.log", maestroLogPath, "text/plain", reporter);
  }

  const screenshotName = "ios-screenshot.png";
  const screenshotPath = join(artifactsDir, screenshotName);
  const screenshot = await runObservedCommand(
    evidence,
    "xcrun",
    ["simctl", "io", udid, "screenshot", screenshotPath],
    { timeoutMs: 30_000 }
  );
  if (screenshot.code !== 0) {
    await reporter.event("qa", "error", "iOS screenshot failed.", {
      stderr: screenshot.stderr.slice(-4000)
    });
  } else {
    await uploadIfExists(screenshotName, screenshotPath, "image/png", reporter);
  }

  await reporter.event("qa", "info", "iOS QA completed.");
  return "iOS QA completed.";
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
  requestedAvd: string | undefined = config.androidAvd,
  onDeviceOwned?: (binding: { avd: string; serial?: string }) => Promise<void>
): Promise<string | undefined> {
  const ownershipErrors = androidAvdOwnershipErrors(config);
  if (ownershipErrors.length > 0) {
    await reporter.event(
      "qa",
      "warn",
      "Skipping Android QA because dedicated AVD ownership is invalid.",
      { reasons: ownershipErrors }
    );
    return undefined;
  }
  if (!requestedAvd || !isWorkerOwnedAndroidAvd(config, requestedAvd)) {
    await reporter.event(
      "qa",
      "warn",
      "Skipping Android QA because no worker-owned AVD was exclusively leased."
    );
    return undefined;
  }

  const tools = await resolveAndroidTools(config);
  if (!tools.adb) {
    await reporter.event("qa", "warn", "Skipping Android QA; adb is not executable.", {
      checked: tools.adbCandidates
    });
    return undefined;
  }
  const adbCommand = tools.adb.command;

  await runObservedCommand(evidence, adbCommand, ["start-server"], { timeoutMs: 30_000 });

  let serial: string | undefined;
  await reporter.event("qa", "info", `Ensuring Android AVD ${requestedAvd} is booted.`);
  serial = await serialForAvd(requestedAvd, adbCommand, evidence);
  if (serial) await onDeviceOwned?.({ avd: requestedAvd, serial });
  if (!serial) {
    const acceleration = tools.emulator
      ? await checkAndroidEmulatorAcceleration(tools.emulator.command)
      : undefined;
    if (!tools.emulator || !acceleration?.ok) {
      await reporter.event(
        "qa",
        "warn",
        `Android AVD ${requestedAvd} is not attached and this host cannot boot it.`,
        {
          checked: tools.emulatorCandidates,
          ...(acceleration ? { acceleration: acceleration.detail } : {})
        }
      );
      return undefined;
    }
    const avd = quote(requestedAvd);
    const emulator = quote(tools.emulator.command);
    const launch = await runObservedCommand(evidence, "sh", [
      "-lc",
      `nohup ${emulator} -avd ${avd} -no-snapshot -no-audio -no-window >/tmp/uriel-emulator.log 2>&1 &`
    ]);
    if (launch.code !== 0) {
      await reporter.event("qa", "warn", `Failed to start Android AVD ${requestedAvd}.`, {
        stderr: launch.stderr.slice(-4000)
      });
      return undefined;
    }
    await onDeviceOwned?.({ avd: requestedAvd });
  }
  const deadline = Date.now() + config.androidBootTimeoutSeconds * 1_000;
  let bootCompleted = false;
  while (Date.now() < deadline) {
    if (!serial) {
      serial = await serialForAvd(requestedAvd, adbCommand, evidence);
      if (serial) await onDeviceOwned?.({ avd: requestedAvd, serial });
    }
    if (!serial) {
      await delay(Math.max(1, Math.min(2_000, deadline - Date.now())));
      continue;
    }
    const boot = await runObservedCommand(
      evidence,
      adbCommand,
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

  if (!serial) {
    await reporter.event(
      "qa",
      "warn",
      "Skipping Android recording because no booted adb device is attached.",
    );
    return undefined;
  }
  await reporter.event("qa", "info", `Android QA bound to ${serial}.`, {
    avd: requestedAvd
  });
  return serial;
}

export async function ensureIosSimulator(
  config: WorkerConfig,
  reporter: JobReporter,
  evidence?: EvidenceRecorder,
  requestedUdid: string | undefined = config.iosSimulatorUdid
): Promise<string | undefined> {
  if (!(await commandExists("xcrun"))) {
    await reporter.event("qa", "warn", "Skipping iOS QA; xcrun is missing.");
    return undefined;
  }

  const requestedName = requestedUdid ? undefined : config.iosSimulatorName;
  let booted = await bootedSimulators(evidence);
  const alreadyBooted = selectBootedSimulator(booted, requestedUdid, requestedName);
  if (alreadyBooted) {
    await reportIosSimulatorBinding(alreadyBooted, reporter);
    return alreadyBooted.udid;
  }

  const bootTarget = requestedUdid ?? requestedName;
  if (!bootTarget) {
    if (booted.length === 1 && booted[0]) {
      await reportIosSimulatorBinding(booted[0], reporter);
      return booted[0].udid;
    }
    await reporter.event(
      "qa",
      "warn",
      booted.length > 1
        ? "Skipping iOS QA because multiple simulators are booted and no simulator UDID or name selected one."
        : "Skipping iOS QA because no simulator is booted and no simulator UDID or name is configured.",
      booted.length > 1 ? { devices: booted.map((simulator) => simulator.udid) } : undefined
    );
    return undefined;
  }

  await reporter.event("qa", "info", `Booting iOS Simulator ${bootTarget}.`);
  const boot = await runObservedCommand(
    evidence,
    "xcrun",
    ["simctl", "boot", bootTarget],
    { timeoutMs: 30_000 }
  );
  if (boot.code !== 0) {
    await reporter.event("qa", "warn", `Failed to boot iOS Simulator ${bootTarget}.`, {
      stderr: boot.stderr.slice(-4000)
    });
    return undefined;
  }

  const deadline = Date.now() + config.iosBootTimeoutSeconds * 1_000;
  while (Date.now() < deadline) {
    booted = await bootedSimulators(evidence);
    const simulator = selectBootedSimulator(booted, requestedUdid, requestedName);
    if (simulator) {
      await reportIosSimulatorBinding(simulator, reporter);
      return simulator.udid;
    }
    await delay(Math.max(1, Math.min(2_000, deadline - Date.now())));
  }

  await reporter.event(
    "qa",
    "warn",
    `Skipping iOS QA because Simulator ${bootTarget} did not finish booting within ${config.iosBootTimeoutSeconds} seconds.`
  );
  return undefined;
}

export async function recordAndroidClip(
  name: string,
  seconds: number,
  artifactsDir: string,
  reporter: JobReporter,
  evidence?: EvidenceRecorder,
  serial?: string,
  adbCommand = "adb"
): Promise<void> {
  const remotePath = `/sdcard/uriel-${process.pid}-${Date.now()}.mp4`;
  const localPath = join(artifactsDir, name);
  await reporter.event("qa", "info", `Recording Android screen for ${seconds} seconds.`);
  const record = await runObservedCommand(
    evidence,
    adbCommand,
    [...adbTarget(serial), "shell", "screenrecord", "--time-limit", String(seconds), remotePath],
    { timeoutMs: Math.max(20_000, seconds * 1_000 + 10_000) }
  );
  if (record.code !== 0) {
    await reporter.event("qa", "error", "Android screenrecord failed.", {
      stderr: record.stderr.slice(-4000)
    });
    return;
  }
  const pull = await runObservedCommand(
    evidence,
    adbCommand,
    [...adbTarget(serial), "pull", remotePath, localPath],
    { timeoutMs: 30_000 }
  );
  await runObservedCommand(
    evidence,
    adbCommand,
    [...adbTarget(serial), "shell", "rm", "-f", remotePath],
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

/**
 * Records the simulator screen for `seconds`, then stops.
 *
 * Unlike `adb shell screenrecord --time-limit`, `simctl io recordVideo` runs until it is
 * signalled, and it must be stopped with SIGINT — SIGTERM/SIGKILL leave the container unfinalised
 * and the file unplayable.
 *
 * Expect the resulting clip to be much SHORTER than `seconds`: simctl encodes a frame only when
 * the display changes, so an idle simulator yields a fraction of a second no matter how long the
 * recording ran. Measured on a booted iPhone simulator: a 4-second capture of a static screen
 * produced 0.07s of video, while the same capture with the UI actually changing produced 0.94s.
 * A short clip is therefore not evidence that the timing or the signalling is broken.
 */
export async function recordIosClip(
  name: string,
  seconds: number,
  artifactsDir: string,
  reporter: JobReporter,
  evidence: EvidenceRecorder | undefined,
  udid: string
): Promise<void> {
  const localPath = join(artifactsDir, name);
  const args = ["simctl", "io", udid, "recordVideo", localPath];
  await reporter.event("qa", "info", `Recording iOS Simulator screen for ${seconds} seconds.`);
  const record = await runCommandUntilInterrupt("xcrun", args, seconds * 1_000);
  evidence?.recordCommand("xcrun", args, record);
  if (record.code !== 0) {
    await rm(localPath, { force: true });
    await reporter.event("qa", "error", "iOS Simulator recording failed.", {
      stderr: record.stderr.slice(-4000)
    });
    return;
  }

  await uploadIfExists(name, localPath, "video/mp4", reporter);
}

export function parseBootedSimulatorUdids(output: string): string[] {
  return parseBootedSimulators(output).map((simulator) => simulator.udid);
}

async function attachedDeviceSerials(
  adbCommand: string,
  evidence?: EvidenceRecorder
): Promise<string[]> {
  const result = await runObservedCommand(
    evidence,
    adbCommand,
    ["devices"],
    { timeoutMs: 30_000 }
  );
  return result.code === 0 ? parseAdbDeviceSerials(result.stdout) : [];
}

interface BootedSimulator {
  name: string;
  udid: string;
}

function parseBootedSimulators(output: string): BootedSimulator[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !isRecord(parsed.devices)) {
    return [];
  }

  const simulators: BootedSimulator[] = [];
  for (const devices of Object.values(parsed.devices)) {
    if (!Array.isArray(devices)) continue;
    for (const device of devices) {
      if (
        isRecord(device) &&
        device.state === "Booted" &&
        typeof device.udid === "string" &&
        typeof device.name === "string"
      ) {
        simulators.push({ name: device.name, udid: device.udid });
      }
    }
  }
  return simulators;
}

async function bootedSimulators(evidence?: EvidenceRecorder): Promise<BootedSimulator[]> {
  const result = await runObservedCommand(
    evidence,
    "xcrun",
    ["simctl", "list", "devices", "booted", "-j"],
    { timeoutMs: 30_000 }
  );
  return result.code === 0 ? parseBootedSimulators(result.stdout) : [];
}

function selectBootedSimulator(
  simulators: BootedSimulator[],
  requestedUdid?: string,
  requestedName?: string
): BootedSimulator | undefined {
  if (requestedUdid) {
    return simulators.find((simulator) => simulator.udid === requestedUdid);
  }
  if (requestedName) {
    return simulators.find((simulator) => simulator.name === requestedName);
  }
  return undefined;
}

async function reportIosSimulatorBinding(
  simulator: BootedSimulator,
  reporter: JobReporter
): Promise<void> {
  await reporter.event("qa", "info", `iOS QA bound to ${simulator.udid}.`, {
    name: simulator.name
  });
}

async function serialForAvd(
  requestedAvd: string,
  adbCommand: string,
  evidence?: EvidenceRecorder
): Promise<string | undefined> {
  for (const serial of await attachedDeviceSerials(adbCommand, evidence)) {
    const result = await runObservedCommand(
      evidence,
      adbCommand,
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

async function runCommandUntilInterrupt(
  command: string,
  args: string[],
  interruptAfterMs: number
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let interrupted = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const interrupt = setTimeout(() => {
      interrupted = child.kill("SIGINT");
      if (interrupted) {
        forceKill = setTimeout(() => child.kill("SIGKILL"), 10_000);
      }
    }, interruptAfterMs);

    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(interrupt);
      if (forceKill) clearTimeout(forceKill);
      resolve({
        code,
        durationMs: Date.now() - startedAt,
        stderr,
        stdout
      });
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += error.message;
      if (child.pid) child.kill("SIGKILL");
      finish(1);
    });
    child.on("close", (code, signal) => {
      finish(code ?? (interrupted && signal === "SIGINT" ? 0 : 1));
    });
  });
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

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
