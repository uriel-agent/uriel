import { resolve } from "node:path";

export const ANDROID_DEVICE_GRANT_VERSION = 1;

export interface AndroidDeviceGrant {
  avd: string;
  grantedAt: string;
  jobId: string;
  kind: "uriel-android-device-grant";
  owner: "uriel-worker";
  serial: string;
  version: 1;
  worktree: string;
}

export function buildAndroidDeviceGrant(input: {
  avd: string;
  grantedAt?: string;
  jobId: string;
  serial: string;
  worktree: string;
}): AndroidDeviceGrant {
  if (!input.avd.trim()) throw new Error("Android device grant requires an AVD name.");
  if (!input.serial.trim()) throw new Error("Android device grant requires a serial.");
  if (!/^[A-Za-z0-9._-]+$/u.test(input.jobId)) {
    throw new Error("Android device grant requires a safe job id.");
  }
  return {
    avd: input.avd,
    grantedAt: input.grantedAt ?? new Date().toISOString(),
    jobId: input.jobId,
    kind: "uriel-android-device-grant",
    owner: "uriel-worker",
    serial: input.serial,
    version: ANDROID_DEVICE_GRANT_VERSION,
    worktree: resolve(input.worktree)
  };
}

export function androidDeviceGrantEnvironment(input: {
  avd: string;
  grantPath: string;
  jobId: string;
  serial: string;
}): NodeJS.ProcessEnv {
  return {
    ANDROID_SERIAL: input.serial,
    URIEL_ANDROID_AVD: input.avd,
    URIEL_ANDROID_DEVICE_GRANT: resolve(input.grantPath),
    URIEL_JOB_ID: input.jobId
  };
}
