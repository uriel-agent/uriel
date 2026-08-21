import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { assertProvisionedAndroidApkCompatible } from "../apps/worker/src/android-compatibility.ts";
import { loadConfig, type WorkerConfig } from "../apps/worker/src/config.ts";
import { quote } from "../apps/worker/src/shell.ts";
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
        await androidConfig("a".repeat(40)),
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
      "this revision; refresh the worker APK. No URIEL_ANDROID_APK_REFRESH_CMD/" +
      "URIEL_ANDROID_APK_MANIFEST_FILE pair is configured to attempt an automatic refresh.";

    await expect(
      assertProvisionedAndroidApkCompatible(
        androidJob(),
        await androidConfig("a".repeat(40)),
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
    const config = await androidConfig("a".repeat(40));
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

  it("proceeds using the manifest apkPath when the manifest fingerprint is compatible", async () => {
    const compatible = [`${"2".repeat(40)}`, "d".repeat(40)];
    const worktree = await createWorktree({ compatible });
    const manifestFile = await manifestPath();
    await writeManifestFile(manifestFile, {
      apkPath: "/opt/uriel/apks/current.apk",
      fingerprint: "2".repeat(40)
    });
    const config = await androidConfig("a".repeat(40), {
      URIEL_ANDROID_APK_MANIFEST_FILE: manifestFile
    });
    const reporter = { event: vi.fn(async () => undefined) };

    await expect(
      assertProvisionedAndroidApkCompatible(androidJob(), config, worktree, reporter)
    ).resolves.toBeUndefined();
    expect(reporter.event).not.toHaveBeenCalled();
  });

  it("runs the refresh command once and proceeds when it writes a now-compatible manifest", async () => {
    const compatible = ["e".repeat(40)];
    const worktree = await createWorktree({ compatible });
    const manifestFile = await manifestPath();
    const config = await androidConfig("a".repeat(40), {
      URIEL_ANDROID_APK_MANIFEST_FILE: manifestFile,
      URIEL_ANDROID_APK_REFRESH_CMD: writeManifestCommand(manifestFile, {
        apkPath: "/opt/uriel/apks/current.apk",
        fingerprint: "e".repeat(40)
      })
    });
    const reporter = { event: vi.fn(async () => undefined) };

    await expect(
      assertProvisionedAndroidApkCompatible(androidJob(), config, worktree, reporter)
    ).resolves.toBeUndefined();

    expect(reporter.event).toHaveBeenCalledTimes(2);
    expect(reporter.event).toHaveBeenNthCalledWith(
      1,
      "qa",
      "info",
      expect.stringContaining("running the configured refresh command"),
      expect.objectContaining({ fingerprint: "a".repeat(40) })
    );
    expect(reporter.event).toHaveBeenNthCalledWith(
      2,
      "qa",
      "info",
      `Refreshed the provisioned Android APK to fingerprint ${"e".repeat(40)}.`,
      { fingerprint: "e".repeat(40) }
    );
  });

  it("fails with the extended message when the refresh produces a still-incompatible manifest", async () => {
    const compatible = ["f".repeat(40)];
    const worktree = await createWorktree({ compatible });
    const manifestFile = await manifestPath();
    const config = await androidConfig("a".repeat(40), {
      URIEL_ANDROID_APK_MANIFEST_FILE: manifestFile,
      URIEL_ANDROID_APK_REFRESH_CMD: writeManifestCommand(manifestFile, {
        apkPath: "/opt/uriel/apks/current.apk",
        fingerprint: "1".repeat(40)
      })
    });
    const reporter = { event: vi.fn(async () => undefined) };

    await expect(
      assertProvisionedAndroidApkCompatible(androidJob(), config, worktree, reporter)
    ).rejects.toThrow(
      new RegExp(
        `Provisioned APK fingerprint ${"1".repeat(40)} is not in config/android-compat\\.json .*` +
          "Automatic refresh was attempted \\(refresh completed but fingerprint " +
          `${"1".repeat(40)} is still not in config/android-compat\\.json\\)\\.`
      )
    );
    expect(reporter.event).toHaveBeenCalledWith(
      "qa",
      "error",
      expect.stringContaining(
        `refresh completed but fingerprint ${"1".repeat(40)} is still not in config/android-compat.json`
      )
    );
  });

  it("fails with the refresh error included when the refresh command exits non-zero", async () => {
    const compatible = ["4".repeat(40)];
    const worktree = await createWorktree({ compatible });
    const manifestFile = await manifestPath();
    const config = await androidConfig("a".repeat(40), {
      URIEL_ANDROID_APK_MANIFEST_FILE: manifestFile,
      URIEL_ANDROID_APK_REFRESH_CMD: "echo 'refresh source unreachable' >&2; exit 7"
    });
    const reporter = { event: vi.fn(async () => undefined) };

    await expect(
      assertProvisionedAndroidApkCompatible(androidJob(), config, worktree, reporter)
    ).rejects.toThrow(
      /Automatic refresh was attempted \(refresh command exited 7: refresh source unreachable\)\./
    );
  });

  it("fails loud on a sha256 mismatch between the manifest and the APK on disk", async () => {
    const compatible = ["3".repeat(40)];
    const worktree = await createWorktree({ compatible });
    const scratchDir = await mkdtemp(join(tmpdir(), "uriel-apk-file-"));
    temporaryDirectories.push(scratchDir);
    const apkPath = join(scratchDir, "current.apk");
    await writeFile(apkPath, "definitely-an-apk");
    const actualSha256 = createHash("sha256").update("definitely-an-apk").digest("hex");
    const manifestFile = await manifestPath();
    await writeManifestFile(manifestFile, {
      apkPath,
      fingerprint: "3".repeat(40),
      sha256: "0".repeat(64)
    });
    expect(actualSha256).not.toBe("0".repeat(64));
    const config = await androidConfig("a".repeat(40), {
      URIEL_ANDROID_APK_MANIFEST_FILE: manifestFile
    });
    const reporter = { event: vi.fn(async () => undefined) };

    await expect(
      assertProvisionedAndroidApkCompatible(androidJob(), config, worktree, reporter)
    ).rejects.toThrow(/Android APK manifest checksum mismatch/);
    expect(reporter.event).toHaveBeenCalledWith(
      "qa",
      "error",
      expect.stringContaining("Android APK manifest checksum mismatch")
    );
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

async function manifestPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "uriel-apk-manifest-"));
  temporaryDirectories.push(dir);
  return join(dir, "apk-manifest.json");
}

async function writeManifestFile(manifestFile: string, contents: unknown): Promise<void> {
  await writeFile(manifestFile, `${JSON.stringify(contents)}\n`, "utf8");
}

function writeManifestCommand(manifestFile: string, contents: unknown): string {
  const json = JSON.stringify(contents).replace(/'/gu, "'\\''");
  return `printf '%s' '${json}' > ${quote(manifestFile)}`;
}

async function androidConfig(
  fingerprint: string,
  extraEnv: Record<string, string> = {}
): Promise<WorkerConfig> {
  const stateDir = await mkdtemp(join(tmpdir(), "uriel-apk-statedir-"));
  temporaryDirectories.push(stateDir);
  return loadConfig({
    URIEL_ANDROID_APK_FINGERPRINT: fingerprint,
    URIEL_ANDROID_APK_SHA256: "d".repeat(64),
    URIEL_ANDROID_APK_URL: "https://downloads.example.test/app.apk",
    URIEL_ANDROID_APP_PACKAGE: "com.example.qa",
    URIEL_ANDROID_COMPAT_FILE: "config/android-compat.json",
    URIEL_STATE_DIR: stateDir,
    ...extraEnv
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
