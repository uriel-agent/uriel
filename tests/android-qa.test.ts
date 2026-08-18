import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  androidReinstallReason,
  configuredAndroidProvisioning,
  provisionAndroidApp
} from "../apps/worker/src/android-provisioning.ts";
import { loadConfig } from "../apps/worker/src/config.ts";
import {
  ensureAndroidDevice,
  parseAdbDeviceSerials,
  shouldCaptureGenericAndroidQa
} from "../apps/worker/src/qa.ts";

describe("Android QA preflight", () => {
  it("parses only fully attached adb devices", () => {
    expect(
      parseAdbDeviceSerials(
        [
          "List of devices attached",
          "emulator-5554 device product:sdk model:Pixel",
          "emulator-5556 offline",
          "R58M123 unauthorized",
          ""
        ].join("\n")
      )
    ).toEqual(["emulator-5554"]);
  });

  it("does not add generic recordings to checklist verification evidence", () => {
    expect(shouldCaptureGenericAndroidQa({ kind: "verify", metadata: {} })).toBe(false);
    expect(
      shouldCaptureGenericAndroidQa({
        kind: "verify",
        metadata: { maestroFlow: "qa.yaml" }
      })
    ).toBe(true);
    expect(shouldCaptureGenericAndroidQa({ kind: "change", metadata: {} })).toBe(true);
  });

  it("refuses interactive developer AVDs before touching adb", async () => {
    const events: Array<{ data?: Record<string, unknown>; message: string }> = [];
    const serial = await ensureAndroidDevice(
      loadConfig({ URIEL_ANDROID_AVDS: "dungeonqa_pool_1" }),
      {
        event: async (_stage: string, _level: string, message: string, data?: Record<string, unknown>) => {
          events.push({ data, message });
        }
      } as never
    );

    expect(serial).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({
        reasons: expect.arrayContaining([expect.stringContaining("interactive developer pool")])
      })
    }));
  });

  it("accepts a complete checksum-pinned APK configuration", () => {
    expect(
      configuredAndroidProvisioning({
        androidApkSha256: "a".repeat(64),
        androidApkUrl: "https://example.test/qa.apk",
        androidAppPackage: "com.example.qa"
      })
    ).toEqual({
      packageName: "com.example.qa",
      sha256: "a".repeat(64),
      url: "https://example.test/qa.apk"
    });
  });

  it("rejects partial, unpinned, or unsupported APK configuration", () => {
    expect(() =>
      configuredAndroidProvisioning({
        androidApkUrl: "https://example.test/qa.apk"
      })
    ).toThrow("requires");
    expect(() =>
      configuredAndroidProvisioning({
        androidApkSha256: "not-a-digest",
        androidApkUrl: "https://example.test/qa.apk",
        androidAppPackage: "com.example.qa"
      })
    ).toThrow("SHA-256");
    expect(() =>
      configuredAndroidProvisioning({
        androidApkSha256: "a".repeat(64),
        androidApkUrl: "ftp://example.test/qa.apk",
        androidAppPackage: "com.example.qa"
      })
    ).toThrow("file, http, or https");
  });

  it("accepts a host-local checksum-pinned APK", () => {
    expect(
      configuredAndroidProvisioning({
        androidApkSha256: "a".repeat(64),
        androidApkUrl: "file:///var/lib/uriel/qa.apk",
        androidAppPackage: "com.example.qa"
      })
    ).toEqual({
      packageName: "com.example.qa",
      sha256: "a".repeat(64),
      url: "file:///var/lib/uriel/qa.apk"
    });
  });

  it("classifies only safe clean-reinstall conflicts", () => {
    expect(androidReinstallReason("Failure [INSTALL_FAILED_VERSION_DOWNGRADE]")).toBe(
      "version-downgrade"
    );
    expect(androidReinstallReason("INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match")).toBe(
      "signature-mismatch"
    );
    expect(androidReinstallReason("INSTALL_FAILED_INSUFFICIENT_STORAGE")).toBeUndefined();
  });

  it("downloads, verifies, installs, and then reuses a pinned APK", async () => {
    const root = await mkdtemp(join(tmpdir(), "uriel-android-provision-"));
    const binDir = join(root, "bin");
    const adbLog = join(root, "adb.log");
    const installedMarker = join(root, "installed");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(binDir));
    const adbPath = join(binDir, "adb");
    await writeFile(
      adbPath,
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$ADB_LOG"
if [ "\${1:-}" = "devices" ]; then
  echo "List of devices attached"
  echo "emulator-5554 device"
  exit 0
fi
if [ "\${3:-}" = "emu" ] && [ "\${4:-}" = "avd" ]; then
  echo uriel_qa_1
  echo OK
  exit 0
fi
if [ "\${3:-}" = "install" ]; then
  touch "$ADB_INSTALLED"
  echo Success
  exit 0
fi
if [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "pm" ] && [ "\${5:-}" = "path" ]; then
  if [ -f "$ADB_INSTALLED" ]; then
    echo package:/data/app/qa.apk
    exit 0
  fi
  exit 1
fi
if [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "dumpsys" ] && [ "\${5:-}" = "package" ]; then
  echo "versionCode=42 minSdk=24"
  echo "versionName=1.2.3"
  echo "firstInstallTime=2026-01-01 00:00:00"
  echo "lastUpdateTime=2026-01-01 00:00:01"
  exit 0
fi
if [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "pm" ] && [ "\${5:-}" = "clear" ]; then
  echo Success
  exit 0
fi
exit 1
`
    );
    await chmod(adbPath, 0o755);

    const apk = Buffer.from("signed-test-apk");
    const sha256 = createHash("sha256").update(apk).digest("hex");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/vnd.android.package-archive" });
      response.end(apk);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.ADB_LOG = adbLog;
    process.env.ADB_INSTALLED = installedMarker;
    const reporter = { event: async () => undefined };
    try {
      const config = loadConfig({
        URIEL_ANDROID_ADB_PATH: adbPath,
        URIEL_ANDROID_AVDS: "uriel_qa_1",
        URIEL_ANDROID_APK_SHA256: sha256,
        URIEL_ANDROID_APK_URL: `http://127.0.0.1:${address.port}/qa.apk`,
        URIEL_ANDROID_APP_PACKAGE: "com.example.qa",
        URIEL_STATE_DIR: root
      });
      await provisionAndroidApp(config, "emulator-5554", reporter as never);
      await provisionAndroidApp(config, "emulator-5554", reporter as never);

      const calls = await readFile(adbLog, "utf8");
      expect(calls.match(/ install -r /gu)).toHaveLength(1);
      expect(calls.match(/ shell pm clear /gu)).toHaveLength(2);
      expect(await readFile(join(root, "android-apks", `${sha256}.apk`))).toEqual(apk);
    } finally {
      process.env.PATH = previousPath;
      Reflect.deleteProperty(process.env, "ADB_LOG");
      Reflect.deleteProperty(process.env, "ADB_INSTALLED");
      server.close();
    }
  });

  it("reconciles a version downgrade only after proving worker AVD ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "uriel-android-downgrade-"));
    const binDir = join(root, "bin");
    const adbLog = join(root, "adb.log");
    const installedMarker = join(root, "installed");
    const failedOnceMarker = join(root, "failed-once");
    const apkPath = join(root, "qa.apk");
    await mkdir(binDir);
    await writeFile(installedMarker, "newer-package");
    const apk = Buffer.from("older-signed-test-apk");
    await writeFile(apkPath, apk);
    const adbPath = join(binDir, "adb");
    await writeFile(
      adbPath,
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$ADB_LOG"
if [ "\${1:-}" = "devices" ]; then
  printf 'List of devices attached\\nemulator-5554 device\\n'
  exit 0
fi
if [ "\${3:-}" = "emu" ]; then
  printf 'uriel_qa_1\\nOK\\n'
  exit 0
fi
if [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "pm" ] && [ "\${5:-}" = "path" ]; then
  [ -f "$ADB_INSTALLED" ] && echo package:/data/app/qa.apk && exit 0
  exit 1
fi
if [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "dumpsys" ]; then
  printf 'versionCode=534 minSdk=24\\nversionName=5.34\\nlastUpdateTime=2026-08-18 00:00:00\\n'
  exit 0
fi
if [ "\${3:-}" = "install" ] && [ "\${4:-}" = "-r" ] && [ ! -f "$ADB_FAILED_ONCE" ]; then
  touch "$ADB_FAILED_ONCE"
  echo 'Failure [INSTALL_FAILED_VERSION_DOWNGRADE: version code 532 is older than 534]' >&2
  exit 1
fi
if [ "\${3:-}" = "uninstall" ]; then
  rm -f "$ADB_INSTALLED"
  echo Success
  exit 0
fi
if [ "\${3:-}" = "install" ]; then
  touch "$ADB_INSTALLED"
  echo Success
  exit 0
fi
if [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "pm" ] && [ "\${5:-}" = "clear" ]; then
  echo Success
  exit 0
fi
exit 1
`
    );
    await chmod(adbPath, 0o755);

    const previousEnvironment = {
      ADB_FAILED_ONCE: process.env.ADB_FAILED_ONCE,
      ADB_INSTALLED: process.env.ADB_INSTALLED,
      ADB_LOG: process.env.ADB_LOG
    };
    process.env.ADB_FAILED_ONCE = failedOnceMarker;
    process.env.ADB_INSTALLED = installedMarker;
    process.env.ADB_LOG = adbLog;
    const events: Array<{ data?: Record<string, unknown>; message: string }> = [];
    const reporter = {
      event: async (_stage: string, _level: string, message: string, data?: Record<string, unknown>) => {
        events.push({ data, message });
      }
    };
    try {
      const config = loadConfig({
        URIEL_ANDROID_ADB_PATH: adbPath,
        URIEL_ANDROID_APK_SHA256: createHash("sha256").update(apk).digest("hex"),
        URIEL_ANDROID_APK_URL: pathToFileURL(apkPath).toString(),
        URIEL_ANDROID_APP_PACKAGE: "com.example.qa",
        URIEL_ANDROID_AVDS: "uriel_qa_1",
        URIEL_STATE_DIR: root
      });
      await provisionAndroidApp(config, "emulator-5554", reporter as never);

      const calls = await readFile(adbLog, "utf8");
      expect(calls).toMatch(/install -r .*qa\.apk[\s\S]*uninstall com\.example\.qa[\s\S]*install .*qa\.apk/u);
      expect(events).toContainEqual(expect.objectContaining({
        data: expect.objectContaining({
          action: "uninstall-reinstall",
          avd: "uriel_qa_1",
          installedVersionCode: "534",
          reason: "version-downgrade"
        })
      }));
    } finally {
      restoreEnvironment(previousEnvironment);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("refuses to provision a physical device before any destructive adb command", async () => {
    const root = await mkdtemp(join(tmpdir(), "uriel-android-physical-"));
    const binDir = join(root, "bin");
    const adbLog = join(root, "adb.log");
    const apkPath = join(root, "qa.apk");
    await mkdir(binDir);
    const apk = Buffer.from("physical-device-safety-apk");
    await writeFile(apkPath, apk);
    const adbPath = join(binDir, "adb");
    await writeFile(
      adbPath,
      `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$ADB_LOG"
if [ "\${1:-}" = "devices" ]; then
  printf 'List of devices attached\\nR58M123 device\\n'
  exit 0
fi
exit 1
`
    );
    await chmod(adbPath, 0o755);
    const previousLog = process.env.ADB_LOG;
    process.env.ADB_LOG = adbLog;
    try {
      const config = loadConfig({
        URIEL_ANDROID_ADB_PATH: adbPath,
        URIEL_ANDROID_APK_SHA256: createHash("sha256").update(apk).digest("hex"),
        URIEL_ANDROID_APK_URL: pathToFileURL(apkPath).toString(),
        URIEL_ANDROID_APP_PACKAGE: "com.example.qa",
        URIEL_ANDROID_AVDS: "uriel_qa_1",
        URIEL_STATE_DIR: root
      });

      await expect(
        provisionAndroidApp(config, "R58M123", { event: async () => undefined } as never)
      ).rejects.toThrow("may be a physical device");
      expect(await readFile(adbLog, "utf8")).not.toMatch(/install|uninstall|pm clear/u);
    } finally {
      if (previousLog === undefined) Reflect.deleteProperty(process.env, "ADB_LOG");
      else process.env.ADB_LOG = previousLog;
      await rm(root, { force: true, recursive: true });
    }
  });
});

function restoreEnvironment(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}
