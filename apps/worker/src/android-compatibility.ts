import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { Job } from "../../../packages/core/src/index.ts";
import { configuredAndroidProvisioning } from "./android-provisioning.ts";
import type { WorkerConfig } from "./config.ts";
import type { JobReporter } from "./reporter.ts";

export async function assertProvisionedAndroidApkCompatible(
  job: Job,
  config: WorkerConfig,
  worktree: string,
  reporter: Pick<JobReporter, "event">
): Promise<void> {
  const fingerprint = config.androidApkFingerprint;
  const compatFile = config.androidCompatFile;
  if (!fingerprint || !compatFile || !jobRequestsProvisionedAndroid(job, config)) {
    return;
  }
  if (!/^[a-f0-9]{40}$/u.test(fingerprint)) {
    throw new Error(
      "URIEL_ANDROID_APK_FINGERPRINT must be a 40-character hexadecimal fingerprint."
    );
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
  if (compatibleFingerprints.includes(fingerprint)) {
    return;
  }

  const message =
    `Provisioned APK fingerprint ${fingerprint} is not in ${compatFile} ` +
    `([${compatibleFingerprints.join(",")}]) — the installed app can no longer receive ` +
    "updates for this revision; refresh the worker APK.";
  await reporter.event("qa", "error", message);
  throw new Error(message);
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
