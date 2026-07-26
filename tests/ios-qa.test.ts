import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadConfig } from "../apps/worker/src/config.ts";
import { IosSimulatorSlotPool } from "../apps/worker/src/ios-simulator-slots.ts";
import {
  parseBootedSimulatorUdids,
  recordIosClip,
  runQa,
  runIosQa
} from "../apps/worker/src/qa.ts";
import {
  qaModes,
  validateCreateJobRequest
} from "../packages/core/src/index.ts";

describe("iOS QA preflight", () => {
  it("parses booted simulator UDIDs across multiple runtimes", () => {
    expect(
      parseBootedSimulatorUdids(JSON.stringify({
        devices: {
          "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
            {
              isAvailable: true,
              name: "iPhone 15",
              state: "Booted",
              udid: "11111111-1111-1111-1111-111111111111"
            }
          ],
          "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
            {
              isAvailable: true,
              name: "iPhone 16 Pro",
              state: "Booted",
              udid: "22222222-2222-2222-2222-222222222222"
            }
          ]
        }
      }))
    ).toEqual([
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222"
    ]);
  });

  it("returns no simulator UDIDs for an empty booted-device listing", () => {
    expect(parseBootedSimulatorUdids('{"devices":{}}')).toEqual([]);
  });

  it("adds ios and all without changing the existing both mode", () => {
    expect(qaModes).toEqual(["none", "browser", "android", "ios", "both", "all"]);
    for (const qa of ["ios", "all", "both"] as const) {
      const validation = validateCreateJobRequest({
        prompt: "Verify the app",
        qa,
        repo: "https://github.com/example/application.git"
      });
      expect(validation.ok).toBe(true);
      if (validation.ok) expect(validation.value.qa).toBe(qa);
    }
  });

  it("keeps both on browser and Android while all also runs iOS", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "uriel-ios-modes-"));
    const config = loadConfig({
      URIEL_ENABLE_ANDROID_QA: "false",
      URIEL_ENABLE_BROWSER_QA: "false",
      URIEL_ENABLE_IOS_QA: "false"
    });
    const reporter = { event: async () => undefined };

    expect(
      await runQa(
        { metadata: {}, qa: "both" } as never,
        config,
        artifactsDir,
        reporter as never
      )
    ).toEqual([
      "Browser QA skipped: disabled by worker config.",
      "Android QA skipped: disabled by worker config."
    ]);
    expect(
      await runQa(
        { metadata: {}, qa: "all" } as never,
        config,
        artifactsDir,
        reporter as never
      )
    ).toEqual([
      "Browser QA skipped: disabled by worker config.",
      "Android QA skipped: disabled by worker config.",
      "iOS QA skipped: disabled by worker config."
    ]);
  });

  it("parses iOS Simulator worker configuration", () => {
    const config = loadConfig({
      URIEL_ENABLE_IOS_QA: "false",
      URIEL_IOS_BOOT_TIMEOUT_SECONDS: "420",
      URIEL_IOS_SIMULATOR_NAME: "iPhone 16 Pro",
      URIEL_IOS_SIMULATOR_UDIDS: "first-udid, second-udid"
    });

    expect(config.enableIosQa).toBe(false);
    expect(config.iosBootTimeoutSeconds).toBe(420);
    expect(config.iosSimulatorName).toBe("iPhone 16 Pro");
    expect(config.iosSimulatorUdid).toBe("first-udid");
    expect(config.iosSimulatorUdids).toEqual(["first-udid", "second-udid"]);
  });

  it("leases configured simulator UDIDs exclusively", async () => {
    const pool = new IosSimulatorSlotPool(["first-udid", "second-udid", "first-udid"]);
    const first = await pool.acquire();
    const second = await pool.acquire();
    let thirdResolved = false;
    const thirdPromise = pool.acquire().then((lease) => {
      thirdResolved = true;
      return lease;
    });

    expect([first.udid, second.udid]).toEqual(["first-udid", "second-udid"]);
    await Promise.resolve();
    expect(thirdResolved).toBe(false);

    first.release();
    const third = await thirdPromise;
    expect(third.udid).toBe("first-udid");
    second.release();
    third.release();
  });

  it("skips with a warning when xcrun is missing", async () => {
    const artifactsDir = await mkdtemp(join(tmpdir(), "uriel-ios-qa-"));
    const events: Array<{ level: string; message: string }> = [];
    const reporter = {
      event: async (_type: string, level: string, message: string) => {
        events.push({ level, message });
      }
    };
    const previousPath = process.env.PATH;
    const binDir = await mkdtemp(join(tmpdir(), "uriel-ios-qa-bin-"));
    const shellPath = join(binDir, "sh");
    await writeFile(shellPath, "#!/bin/sh\nexit 1\n");
    await chmod(shellPath, 0o755);
    process.env.PATH = binDir;
    try {
      const summary = await runIosQa(
        { metadata: {} } as never,
        loadConfig({}),
        artifactsDir,
        reporter as never
      );

      expect(summary).toBe("iOS QA skipped: no booted simulator is available.");
      expect(events).toContainEqual({
        level: "warn",
        message: "Skipping iOS QA; xcrun is missing."
      });
    } finally {
      if (previousPath === undefined) {
        Reflect.deleteProperty(process.env, "PATH");
      } else {
        process.env.PATH = previousPath;
      }
    }
  });

  it("stops simulator recording with SIGINT before uploading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "uriel-ios-recording-"));
    const binDir = join(root, "bin");
    const xcrunPath = join(binDir, "xcrun");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(binDir));
    await writeFile(
      xcrunPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const outputPath = process.argv.at(-1);
process.on("SIGINT", () => {
  fs.writeFileSync(outputPath, "finalized recording");
  fs.writeFileSync(process.env.XCRUN_SIGNAL_LOG, "SIGINT");
  process.exit(0);
});
setInterval(() => undefined, 1000);
`
    );
    await chmod(xcrunPath, 0o755);

    const uploads: string[] = [];
    const reporter = {
      event: async () => undefined,
      uploadArtifact: async (name: string) => {
        uploads.push(name);
      }
    };
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.XCRUN_SIGNAL_LOG = join(root, "signal.log");
    try {
      await recordIosClip(
        "recording.mp4",
        0.5,
        root,
        reporter as never,
        undefined,
        "simulator-udid"
      );

      expect(await readFile(join(root, "signal.log"), "utf8")).toBe("SIGINT");
      expect(await readFile(join(root, "recording.mp4"), "utf8")).toBe("finalized recording");
      expect(uploads).toEqual(["recording.mp4"]);
    } finally {
      if (previousPath === undefined) {
        Reflect.deleteProperty(process.env, "PATH");
      } else {
        process.env.PATH = previousPath;
      }
      Reflect.deleteProperty(process.env, "XCRUN_SIGNAL_LOG");
    }
  });
});
