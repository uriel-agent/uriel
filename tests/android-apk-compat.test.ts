import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertProvisionedAndroidApkCompatible } from "../apps/worker/src/android-compatibility.ts";
import { loadConfig } from "../apps/worker/src/config.ts";
import { createId, type Job } from "../packages/core/src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true })
    )
  );
});

describe("provisioned Android APK compatibility", () => {
  it("proceeds when the provisioned fingerprint is present in nested JSON", async () => {
    const worktree = await createWorktree({
      releases: { compatible: ["A".repeat(40), "not-a-fingerprint"] }
    });
    const reporter = { event: vi.fn(async () => undefined) };

    await expect(
      assertProvisionedAndroidApkCompatible(
        androidJob(),
        androidConfig("a".repeat(40)),
        worktree,
        reporter
      )
    ).resolves.toBeUndefined();
    expect(reporter.event).not.toHaveBeenCalled();
  });

  it("fails with an explicit event when the provisioned fingerprint is absent", async () => {
    const compatible = ["b".repeat(40), "c".repeat(40)];
    const worktree = await createWorktree({ compatible });
    const reporter = { event: vi.fn(async () => undefined) };
    const expected =
      `Provisioned APK fingerprint ${"a".repeat(40)} is not in config/android-compat.json ` +
      `([${compatible.join(",")}]) — the installed app can no longer receive updates for ` +
      "this revision; refresh the worker APK.";

    await expect(
      assertProvisionedAndroidApkCompatible(
        androidJob(),
        androidConfig("a".repeat(40)),
        worktree,
        reporter
      )
    ).rejects.toThrow(expected);
    expect(reporter.event).toHaveBeenCalledWith("qa", "error", expected);
  });

  it("skips the check when compatibility configuration is unset", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "uriel-apk-compat-unset-"));
    temporaryDirectories.push(worktree);
    const reporter = { event: vi.fn(async () => undefined) };
    const config = androidConfig("a".repeat(40));
    config.androidApkFingerprint = undefined;
    config.androidCompatFile = undefined;

    await expect(
      assertProvisionedAndroidApkCompatible(
        androidJob(),
        config,
        worktree,
        reporter
      )
    ).resolves.toBeUndefined();
    expect(reporter.event).not.toHaveBeenCalled();
  });
});

async function createWorktree(contents: unknown): Promise<string> {
  const worktree = await mkdtemp(join(tmpdir(), "uriel-apk-compat-"));
  temporaryDirectories.push(worktree);
  const configDir = join(worktree, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "android-compat.json"),
    `${JSON.stringify(contents, null, 2)}\n`,
    "utf8"
  );
  return worktree;
}

function androidConfig(fingerprint: string) {
  return loadConfig({
    URIEL_ANDROID_APK_FINGERPRINT: fingerprint,
    URIEL_ANDROID_APK_SHA256: "d".repeat(64),
    URIEL_ANDROID_APK_URL: "https://downloads.example.test/app.apk",
    URIEL_ANDROID_APP_PACKAGE: "com.example.qa",
    URIEL_ANDROID_COMPAT_FILE: "config/android-compat.json"
  });
}

function androidJob(): Job {
  const now = new Date().toISOString();
  return {
    approvals: [],
    artifacts: [],
    branch: "codex/android-compat",
    createdAt: now,
    events: [],
    id: createId("job"),
    kind: "verify",
    metadata: {},
    profile: "generic",
    prompt: "Verify the Android app.",
    qa: "android",
    repo: "https://github.com/example/app",
    source: "api",
    status: "running",
    updatedAt: now
  };
}
