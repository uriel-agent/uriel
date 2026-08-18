import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { resolveAndroidTools } from "./android-tooling.ts";
import type { WorkerConfig } from "./config.ts";
import type { EvidenceRecorder } from "./evidence.ts";
import type { JobReporter } from "./reporter.ts";
import { exists, runCommand } from "./shell.ts";

const downloads = new Map<string, Promise<string>>();

export interface AndroidProvisioningConfig {
  packageName: string;
  sha256: string;
  url: string;
}

export function configuredAndroidProvisioning(
  config: Pick<WorkerConfig, "androidApkSha256" | "androidApkUrl" | "androidAppPackage">
): AndroidProvisioningConfig | undefined {
  const values = [config.androidApkUrl, config.androidApkSha256, config.androidAppPackage];
  if (values.every((value) => !value)) return undefined;
  if (values.some((value) => !value)) {
    throw new Error(
      "Android APK provisioning requires URIEL_ANDROID_APK_URL, URIEL_ANDROID_APK_SHA256, and URIEL_ANDROID_APP_PACKAGE together."
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(config.androidApkSha256!)) {
    throw new Error("URIEL_ANDROID_APK_SHA256 must be a lowercase 64-character SHA-256 digest.");
  }
  const url = new URL(config.androidApkUrl!);
  if (!["file:", "https:", "http:"].includes(url.protocol)) {
    throw new Error("URIEL_ANDROID_APK_URL must use file, http, or https.");
  }
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(config.androidAppPackage!)) {
    throw new Error("URIEL_ANDROID_APP_PACKAGE is not a valid Android package name.");
  }
  return {
    packageName: config.androidAppPackage!,
    sha256: config.androidApkSha256!,
    url: url.toString()
  };
}

export async function provisionAndroidApp(
  config: WorkerConfig,
  serial: string,
  reporter: JobReporter,
  evidence?: EvidenceRecorder
): Promise<void> {
  const provisioning = configuredAndroidProvisioning(config);
  if (!provisioning) return;
  const adb = (await resolveAndroidTools(config)).adb;
  if (!adb) {
    throw new Error("Cannot provision the Android QA package because adb is not executable.");
  }

  const cacheDir = join(config.stateDir, "android-apks");
  const deviceDir = join(config.stateDir, "android-devices", safePathSegment(serial));
  const markerPath = join(deviceDir, `${provisioning.sha256}.installed`);
  const installedState = await adbPackageState(
    adb.command,
    serial,
    provisioning.packageName,
    evidence
  );
  const recordedState = await readRecordedPackageState(markerPath);
  if (installedState && recordedState === installedState) {
    await reporter.event(
      "qa",
      "info",
      `Verified ${provisioning.packageName} is already provisioned on ${serial}.`,
      { sha256: provisioning.sha256 }
    );
    return;
  }

  const apkPath = await cachedApk(provisioning, cacheDir, reporter);
  await reporter.event(
    "qa",
    "info",
    `Installing configured Android QA package on ${serial}.`,
    { packageName: provisioning.packageName, sha256: provisioning.sha256 }
  );
  const install = await runObservedCommand(
    evidence,
    adb.command,
    ["-s", serial, "install", "-r", apkPath],
    { timeoutMs: 10 * 60_000 }
  );
  if (install.code !== 0) {
    throw new Error(
      `Failed to install Android QA package on ${serial}: ${(install.stderr || install.stdout).trim()}`
    );
  }
  const provisionedState = await adbPackageState(
    adb.command,
    serial,
    provisioning.packageName,
    evidence
  );
  if (!provisionedState) {
    throw new Error(
      `APK install succeeded but ${provisioning.packageName} is not installed on ${serial}.`
    );
  }
  await mkdir(deviceDir, { recursive: true });
  await writeFile(markerPath, `${JSON.stringify({
    installedAt: new Date().toISOString(),
    packageName: provisioning.packageName,
    packageState: provisionedState,
    serial,
    sha256: provisioning.sha256
  })}\n`);
}

async function cachedApk(
  provisioning: AndroidProvisioningConfig,
  cacheDir: string,
  reporter: JobReporter
): Promise<string> {
  const existing = downloads.get(provisioning.sha256);
  if (existing) return existing;

  const pending = downloadAndVerify(provisioning, cacheDir, reporter).finally(() => {
    downloads.delete(provisioning.sha256);
  });
  downloads.set(provisioning.sha256, pending);
  return pending;
}

async function downloadAndVerify(
  provisioning: AndroidProvisioningConfig,
  cacheDir: string,
  reporter: JobReporter
): Promise<string> {
  if (new URL(provisioning.url).protocol === "file:") {
    const localPath = fileURLToPath(provisioning.url);
    const actualSha256 = await sha256File(localPath);
    if (actualSha256 !== provisioning.sha256) {
      throw new Error(
        `Android APK checksum mismatch: expected ${provisioning.sha256}, received ${actualSha256}.`
      );
    }
    return localPath;
  }

  await mkdir(cacheDir, { recursive: true });
  const apkPath = join(cacheDir, `${provisioning.sha256}.apk`);
  if (await exists(apkPath) && await sha256File(apkPath) === provisioning.sha256) {
    return apkPath;
  }

  await rm(apkPath, { force: true });
  const temporaryPath = `${apkPath}.${process.pid}.${Date.now()}.tmp`;
  await reporter.event("qa", "info", "Downloading configured Android QA APK.", {
    sha256: provisioning.sha256,
    url: provisioning.url
  });
  try {
    const response = await fetch(provisioning.url, {
      redirect: "follow",
      signal: AbortSignal.timeout(15 * 60_000)
    });
    if (!response.ok || !response.body) {
      throw new Error(`APK download returned HTTP ${response.status}.`);
    }
    await pipeline(
      Readable.from(response.body as unknown as AsyncIterable<Uint8Array>),
      createWriteStream(temporaryPath)
    );
    const actualSha256 = await sha256File(temporaryPath);
    if (actualSha256 !== provisioning.sha256) {
      throw new Error(
        `Android APK checksum mismatch: expected ${provisioning.sha256}, received ${actualSha256}.`
      );
    }
    await rename(temporaryPath, apkPath);
    return apkPath;
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function sha256File(path: string): Promise<string> {
  await stat(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function adbPackageState(
  adbCommand: string,
  serial: string,
  packageName: string,
  evidence?: EvidenceRecorder
): Promise<string | undefined> {
  const pathResult = await runObservedCommand(
    evidence,
    adbCommand,
    ["-s", serial, "shell", "pm", "path", packageName],
    { timeoutMs: 30_000 }
  );
  if (pathResult.code !== 0 || !pathResult.stdout.trim().startsWith("package:")) {
    return undefined;
  }
  const packageResult = await runObservedCommand(
    evidence,
    adbCommand,
    ["-s", serial, "shell", "dumpsys", "package", packageName],
    { timeoutMs: 30_000 }
  );
  if (packageResult.code !== 0) return undefined;
  const identity = packageResult.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) =>
      /^(versionCode|versionName|firstInstallTime|lastUpdateTime)=/u.test(line)
    )
    .join("\n");
  return identity || undefined;
}

async function readRecordedPackageState(path: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { packageState?: unknown };
    return typeof value.packageState === "string" ? value.packageState : undefined;
  } catch {
    return undefined;
  }
}

async function runObservedCommand(
  evidence: EvidenceRecorder | undefined,
  command: string,
  args: string[],
  options: { timeoutMs?: number } = {}
) {
  const result = await runCommand(command, args, options);
  evidence?.recordCommand(command, args, result, options);
  return result;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_");
}
