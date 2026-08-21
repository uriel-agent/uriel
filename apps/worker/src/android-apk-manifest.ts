import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";

import type { WorkerConfig } from "./config.ts";
import { runCommand, type CommandResult } from "./shell.ts";

/**
 * The manifest an operator-supplied `URIEL_ANDROID_APK_REFRESH_CMD` maintains.
 * Extra keys are tolerated; `sha256` is optional but verified when present.
 */
export interface AndroidApkManifest {
  apkPath: string;
  fingerprint: string;
  sha256?: string;
}

/**
 * Reads and validates the APK manifest. Returns `undefined` for any condition
 * that makes the manifest unusable as an override source (unset path, missing
 * file, invalid JSON, or missing/malformed required fields) so callers fall
 * back to the static `URIEL_ANDROID_APK_*` configuration exactly as if no
 * manifest had been configured.
 */
export async function readAndroidApkManifest(
  manifestFile: string
): Promise<AndroidApkManifest | undefined> {
  let raw: string;
  try {
    raw = await readFile(manifestFile, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  const fingerprint =
    typeof value.fingerprint === "string" ? value.fingerprint.trim().toLowerCase() : "";
  const apkPath = typeof value.apkPath === "string" ? value.apkPath.trim() : "";
  const sha256 =
    typeof value.sha256 === "string" ? value.sha256.trim().toLowerCase() : undefined;
  if (!/^[a-f0-9]{40}$/u.test(fingerprint)) return undefined;
  if (!apkPath) return undefined;
  if (sha256 !== undefined && !/^[a-f0-9]{64}$/u.test(sha256)) return undefined;
  return { apkPath, fingerprint, sha256 };
}

/**
 * Verifies the manifest's optional sha256 against the actual APK file. Throws
 * loud on mismatch (or on a manifest that points at an unreadable file) —
 * a corrupt or half-written download must never be treated as compatible.
 * No-op when the manifest doesn't carry a sha256.
 */
export async function verifyAndroidApkManifestChecksum(
  manifest: AndroidApkManifest
): Promise<void> {
  if (!manifest.sha256) return;
  let actual: string;
  try {
    actual = await sha256File(manifest.apkPath);
  } catch (error) {
    throw new Error(
      `Android APK manifest at ${manifest.apkPath} could not be read to verify its checksum: ` +
        errorMessage(error)
    );
  }
  if (actual !== manifest.sha256) {
    throw new Error(
      `Android APK manifest checksum mismatch: manifest declares sha256 ${manifest.sha256} ` +
        `but ${manifest.apkPath} hashes to ${actual}.`
    );
  }
}

async function sha256File(path: string): Promise<string> {
  await stat(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

const REFRESH_LOCK_STALE_MS = 10 * 60_000;
const REFRESH_LOCK_POLL_MS = 2_000;

export interface AndroidApkRefreshResult {
  /** True when this call actually ran the refresh command (holds the lock). */
  ran: boolean;
  result?: CommandResult;
}

/**
 * Runs the operator-supplied refresh command under a cross-job lock file
 * placed next to the manifest, so two concurrent jobs can't run it at once.
 * The refresh dir (cwd for the command) is a dedicated state-dir subdirectory
 * — see {@link androidApkRefreshDir}.
 *
 * If another job already holds a fresh (<10 minute) lock, this call waits for
 * it to clear instead of running the command itself (`ran: false`); the
 * caller should then simply re-read the manifest, since the concurrent run
 * was very likely refreshing the same target. A lock older than 10 minutes is
 * assumed to be left over from a crashed run and is stolen.
 */
export async function runAndroidApkRefresh(
  config: Pick<WorkerConfig, "androidApkManifestFile" | "androidApkRefreshCmd" | "androidApkRefreshTimeoutSeconds" | "stateDir">
): Promise<AndroidApkRefreshResult> {
  const cmd = config.androidApkRefreshCmd;
  const manifestFile = config.androidApkManifestFile;
  if (!cmd || !manifestFile) return { ran: false };

  const refreshDir = androidApkRefreshDir(config);
  await mkdir(refreshDir, { recursive: true });
  const lockFile = `${manifestFile}.lock`;
  const timeoutMs = config.androidApkRefreshTimeoutSeconds * 1_000;
  const acquired = await acquireRefreshLock(lockFile, timeoutMs + 30_000);
  if (!acquired) {
    return { ran: false };
  }
  try {
    const result = await runCommand("sh", ["-lc", cmd], {
      cwd: refreshDir,
      timeoutMs
    });
    return { ran: true, result };
  } finally {
    await rm(lockFile, { force: true });
  }
}

/** Dedicated cwd for the refresh command; created on demand. */
export function androidApkRefreshDir(config: Pick<WorkerConfig, "stateDir">): string {
  return `${config.stateDir}/android-apk-refresh`;
}

async function acquireRefreshLock(lockFile: string, maxWaitMs: number): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      await writeFile(lockFile, `${process.pid}\n`, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const age = await lockAgeMs(lockFile);
    if (age === undefined) continue; // lock vanished between the failed create and the stat; retry the create
    if (age >= REFRESH_LOCK_STALE_MS) {
      await rm(lockFile, { force: true }); // stale lock from a crashed refresh; steal it
      continue;
    }
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(REFRESH_LOCK_POLL_MS, Math.max(0, deadline - Date.now())));
    if ((await lockAgeMs(lockFile)) === undefined) {
      return false; // the holder finished; let the caller re-read the manifest instead of refreshing again
    }
  }
}

async function lockAgeMs(lockFile: string): Promise<number | undefined> {
  try {
    const info = await stat(lockFile);
    return Date.now() - info.mtimeMs;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
