import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Job } from "../../../packages/core/src/index.ts";
import {
  readAndroidApkManifest,
  runAndroidApkRefresh,
  verifyAndroidApkManifestChecksum,
  type AndroidApkManifest
} from "./android-apk-manifest.ts";
import { configuredAndroidProvisioning } from "./android-provisioning.ts";
import type { WorkerConfig } from "./config.ts";
import type { JobReporter } from "./reporter.ts";

interface EffectiveApkSource {
  fingerprint?: string;
  manifest?: AndroidApkManifest;
}

export async function assertProvisionedAndroidApkCompatible(
  job: Job,
  config: WorkerConfig,
  worktree: string,
  reporter: Pick<JobReporter, "event">
): Promise<void> {
  const compatFile = config.androidCompatFile;
  if (!compatFile || !jobRequestsProvisionedAndroid(job, config)) {
    return;
  }

  let effective: EffectiveApkSource;
  try {
    effective = await resolveEffectiveApkSource(config);
  } catch (error) {
    const message = errorMessage(error);
    await reporter.event("qa", "error", message);
    throw error instanceof Error ? error : new Error(message);
  }
  if (!effective.fingerprint) {
    return;
  }

  if (isAbsolute(compatFile)) {
    throw new Error("URIEL_ANDROID_COMPAT_FILE must be a repository-relative path.");
  }

  const worktreeRoot = await realpath(worktree);
  const compatPath = await realpath(resolve(worktreeRoot, compatFile));
  const relativeCompatPath = relative(worktreeRoot, compatPath);
  if (
    relativeCompatPath === ".." ||
    relativeCompatPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeCompatPath)
  ) {
    throw new Error("URIEL_ANDROID_COMPAT_FILE must resolve inside the job worktree.");
  }

  const compatibleFingerprints = extractApkFingerprints(
    JSON.parse(await readFile(compatPath, "utf8")) as unknown
  );
  if (compatibleFingerprints.includes(effective.fingerprint)) {
    return;
  }

  const refreshAttempted = Boolean(config.androidApkManifestFile && config.androidApkRefreshCmd);
  let refreshDetail: string | undefined;
  if (refreshAttempted) {
    await reporter.event(
      "qa",
      "info",
      `APK fingerprint ${effective.fingerprint} is not compatible with ${compatFile} — running the configured refresh command.`,
      { fingerprint: effective.fingerprint }
    );

    const refresh = await runAndroidApkRefresh(config);
    if (refresh.ran && refresh.result && refresh.result.code !== 0) {
      const output = `${refresh.result.stderr}\n${refresh.result.stdout}`.trim();
      refreshDetail = `refresh command exited ${refresh.result.code}: ${output}`;
    } else {
      let reread: EffectiveApkSource;
      try {
        reread = await resolveEffectiveApkSource(config);
      } catch (error) {
        const message = errorMessage(error);
        await reporter.event("qa", "error", message);
        throw error instanceof Error ? error : new Error(message);
      }
      if (reread.fingerprint && compatibleFingerprints.includes(reread.fingerprint)) {
        await reporter.event(
          "qa",
          "info",
          `Refreshed the provisioned Android APK to fingerprint ${reread.fingerprint}.`,
          { fingerprint: reread.fingerprint }
        );
        return;
      }
      effective = reread.fingerprint ? reread : effective;
      refreshDetail = refresh.ran
        ? reread.fingerprint
          ? `refresh completed but fingerprint ${reread.fingerprint} is still not in ${compatFile}`
          : `refresh completed but ${config.androidApkManifestFile} has no usable fingerprint`
        : `a concurrent refresh was already in progress; after waiting, fingerprint ` +
          `${reread.fingerprint ?? effective.fingerprint} is still not in ${compatFile}`;
    }
  }

  const message =
    `Provisioned APK fingerprint ${effective.fingerprint} is not in ${compatFile} ` +
    `([${compatibleFingerprints.join(",")}]) — the installed app can no longer receive ` +
    "updates for this revision; refresh the worker APK." +
    (refreshAttempted
      ? ` Automatic refresh was attempted (${refreshDetail}).`
      : " No URIEL_ANDROID_APK_REFRESH_CMD/URIEL_ANDROID_APK_MANIFEST_FILE pair is configured to attempt an automatic refresh.");
  await reporter.event("qa", "error", message);
  throw new Error(message);
}

/**
 * Resolves the fingerprint the compatibility gate (and, downstream, Android
 * provisioning) should treat as authoritative: the APK manifest's fingerprint
 * when `URIEL_ANDROID_APK_MANIFEST_FILE` is configured and parses to a valid
 * manifest, otherwise the static `URIEL_ANDROID_APK_FINGERPRINT`. Throws when
 * a manifest is present but its optional sha256 doesn't match the APK on
 * disk — a corrupt/half-written download must never be treated as
 * compatible — or when the static fingerprint is configured but malformed.
 */
async function resolveEffectiveApkSource(config: WorkerConfig): Promise<EffectiveApkSource> {
  const manifestFile = config.androidApkManifestFile;
  if (manifestFile) {
    const manifest = await readAndroidApkManifest(manifestFile);
    if (manifest) {
      await verifyAndroidApkManifestChecksum(manifest);
      return { fingerprint: manifest.fingerprint, manifest };
    }
  }
  const fingerprint = config.androidApkFingerprint;
  if (fingerprint && !/^[a-f0-9]{40}$/u.test(fingerprint)) {
    throw new Error(
      "URIEL_ANDROID_APK_FINGERPRINT must be a 40-character hexadecimal fingerprint."
    );
  }
  return { fingerprint };
}

function extractApkFingerprints(value: unknown): string[] {
  const fingerprints = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      for (const match of candidate.matchAll(/(?<![a-f0-9])[a-f0-9]{40}(?![a-f0-9])/giu)) {
        fingerprints.add(match[0].toLowerCase());
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (candidate && typeof candidate === "object") {
      for (const entry of Object.values(candidate)) visit(entry);
    }
  };
  visit(value);
  return [...fingerprints];
}

function jobRequestsProvisionedAndroid(job: Job, config: WorkerConfig): boolean {
  return config.enableAndroidQa &&
    (job.qa === "android" || job.qa === "both" || job.qa === "all") &&
    Boolean(configuredAndroidProvisioning(config));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
