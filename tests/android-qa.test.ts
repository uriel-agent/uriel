import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configuredAndroidProvisioning,
  provisionAndroidApp
} from "../apps/worker/src/android-provisioning.ts";
import { loadConfig } from "../apps/worker/src/config.ts";
import {
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
        URIEL_ANDROID_APK_SHA256: sha256,
        URIEL_ANDROID_APK_URL: `http://127.0.0.1:${address.port}/qa.apk`,
        URIEL_ANDROID_APP_PACKAGE: "com.example.qa",
        URIEL_STATE_DIR: root
      });
      await provisionAndroidApp(config, "emulator-5554", reporter as never);
      await provisionAndroidApp(config, "emulator-5554", reporter as never);

      const calls = await readFile(adbLog, "utf8");
      expect(calls.match(/ install -r /gu)).toHaveLength(1);
      expect(await readFile(join(root, "android-apks", `${sha256}.apk`))).toEqual(apk);
    } finally {
      process.env.PATH = previousPath;
      Reflect.deleteProperty(process.env, "ADB_LOG");
      Reflect.deleteProperty(process.env, "ADB_INSTALLED");
      server.close();
    }
  });
});
