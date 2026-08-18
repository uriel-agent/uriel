import { describe, expect, it } from "vitest";

import {
  androidDeviceGrantEnvironment,
  buildAndroidDeviceGrant
} from "../apps/worker/src/android-device-grant.ts";

describe("Android device grants", () => {
  it("binds a worker-owned AVD and serial to one job and worktree", () => {
    const grant = buildAndroidDeviceGrant({
      avd: "uriel_dungeon_1",
      grantedAt: "2026-08-18T22:30:00.000Z",
      jobId: "job-123",
      serial: "emulator-5556",
      worktree: "/tmp/../tmp/uriel/job-123"
    });

    expect(grant).toEqual({
      avd: "uriel_dungeon_1",
      grantedAt: "2026-08-18T22:30:00.000Z",
      jobId: "job-123",
      kind: "uriel-android-device-grant",
      owner: "uriel-worker",
      serial: "emulator-5556",
      version: 1,
      worktree: "/tmp/uriel/job-123"
    });
  });

  it("passes the exact grant contract to the harness", () => {
    expect(
      androidDeviceGrantEnvironment({
        avd: "uriel_dungeon_1",
        grantPath: "/tmp/../tmp/grant.json",
        jobId: "job-123",
        serial: "emulator-5556"
      })
    ).toEqual({
      ANDROID_SERIAL: "emulator-5556",
      URIEL_ANDROID_AVD: "uriel_dungeon_1",
      URIEL_ANDROID_DEVICE_GRANT: "/tmp/grant.json",
      URIEL_JOB_ID: "job-123"
    });
  });

  it("rejects an unsafe job id", () => {
    expect(() =>
      buildAndroidDeviceGrant({
        avd: "uriel_dungeon_1",
        jobId: "../other-job",
        serial: "emulator-5556",
        worktree: "/tmp/job"
      })
    ).toThrow(/safe job id/);
  });
});
