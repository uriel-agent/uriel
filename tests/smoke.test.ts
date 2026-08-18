import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AndroidSlotPool } from "../apps/worker/src/android-slots.ts";
import { CleanupSupervisor } from "../apps/worker/src/cleanup.ts";
import { loadConfig } from "../apps/worker/src/config.ts";
import { HostCapacityGovernor } from "../apps/worker/src/host-capacity.ts";
import { SmokeCoordinator } from "../apps/worker/src/smoke.ts";
import { LocalJobStore } from "../apps/worker/src/store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })
  ));
});

describe("readiness smoke", () => {
  it("refuses overlap, then cold-boots, runs adb, and tears down exclusively", async () => {
    const root = await temporaryDirectory();
    const attached = join(root, "attached");
    const adbLog = join(root, "adb.log");
    const adb = await executable(join(root, "bin", "adb"), `
echo "$*" >> ${JSON.stringify(adbLog)}
if [ "\${1:-}" = "start-server" ]; then exit 0; fi
if [ "\${1:-}" = "devices" ]; then
  echo "List of devices attached"
  if [ -f ${JSON.stringify(attached)} ]; then echo "emulator-5554 device product:sdk model:Pixel"; fi
  exit 0
fi
if [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "emu" ] && [ "\${4:-}" = "avd" ]; then
  if [ ! -f ${JSON.stringify(attached)} ]; then exit 1; fi
  echo uriel_qa_1; echo OK; exit 0
fi
if [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "getprop" ]; then
  echo 1; exit 0
fi
if [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "shell" ] && [ "\${4:-}" = "echo" ]; then
  echo "\${5:-}"; exit 0
fi
if [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "emu" ] && [ "\${4:-}" = "kill" ]; then
  rm -f ${JSON.stringify(attached)}; exit 0
fi
exit 1`);
    const emulator = await executable(join(root, "bin", "emulator"), `
if [ "\${1:-}" = "-accel-check" ]; then echo "accel: usable"; exit 0; fi
if [ "\${1:-}" = "-list-avds" ]; then echo uriel_qa_1; exit 0; fi
touch ${JSON.stringify(attached)}
exit 0`);
    const config = loadConfig({
      HOME: root,
      PATH: "",
      URIEL_ANDROID_ADB_PATH: adb,
      URIEL_ANDROID_AVDS: "uriel_qa_1",
      URIEL_ANDROID_BOOT_TIMEOUT_SECONDS: "5",
      URIEL_ANDROID_EMULATOR_PATH: emulator,
      URIEL_CLEANUP_GRACE_SECONDS: "1",
      URIEL_STATE_DIR: root
    });
    const store = new LocalJobStore(config);
    await store.init();
    let activeJobs = 1;
    let exclusive = false;
    const coordinator = new SmokeCoordinator({
      androidSlots: new AndroidSlotPool(config.androidAvds),
      beginExclusive: () => {
        if (exclusive || activeJobs > 0) return false;
        exclusive = true;
        return true;
      },
      capacity: new HostCapacityGovernor(config, async () => ({
        diskAvailableBytes: 100 * 1024 ** 3,
        memoryAvailableBytes: 16 * 1024 ** 3,
        memoryTotalBytes: 32 * 1024 ** 3,
        swapUsedBytes: 0
      })),
      cleanup: new CleanupSupervisor(config),
      config,
      endExclusive: () => { exclusive = false; },
      schedulerState: () => ({ activeJobs, queuedJobs: 0 }),
      store
    });

    expect(coordinator.start()).toEqual({
      accepted: false,
      reason: "real jobs are active or queued"
    });
    activeJobs = 0;
    expect(coordinator.start()).toEqual({ accepted: true });
    await waitForSmoke(coordinator);

    expect(coordinator.snapshot()).toMatchObject({ lastStatus: "passed", running: false });
    expect(exclusive).toBe(false);
    await expect(stat(attached)).rejects.toThrow();
    const log = await readFile(adbLog, "utf8");
    expect(log).toContain("shell echo uriel-smoke");
    expect(log).toContain("emu kill");
    const smokeJobs = (await store.listJobs()).filter((job) => job.source === "watchdog");
    expect(smokeJobs).toHaveLength(1);
    expect(smokeJobs[0]?.status).toBe("completed");
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "uriel-smoke-"));
  temporaryDirectories.push(path);
  return path;
}

async function executable(path: string, body: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function waitForSmoke(coordinator: SmokeCoordinator): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!coordinator.snapshot().running) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("smoke did not finish");
}
