import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CleanupSupervisor, ownedPath } from "../apps/worker/src/cleanup.ts";
import { loadConfig } from "../apps/worker/src/config.ts";
import { ResourceLedger } from "../apps/worker/src/resource-ledger.ts";

const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })
  ));
});

describe("resource cleanup", () => {
  it("persists every worker-owned resource class and releases idempotently", async () => {
    const root = await temporaryDirectory();
    const ledger = new ResourceLedger(loadConfig({ URIEL_STATE_DIR: root }));
    const records = [
      ["worktree", "worktree"],
      ["harness-process", "harness-process"],
      ["android-device", "android-device"],
      ["android-lease", "android-lease"],
      ["artifacts", "artifacts"],
      ["package-marker", "package-marker"]
    ] as const;
    for (const [id, kind] of records) await ledger.record("job_1", id, kind, { marker: id });

    expect((await ledger.active("job_1")).map(({ kind }) => kind).sort()).toEqual(
      records.map(([, kind]) => kind).sort()
    );
    await ledger.release("job_1", "android-lease");
    const first = await ledger.resources("job_1");
    await ledger.release("job_1", "android-lease");
    expect(await ledger.resources("job_1")).toEqual(first);
  });

  it("kills only the journaled process identity and deletes only the scoped worktree", async () => {
    const root = await temporaryDirectory();
    const config = loadConfig({
      URIEL_CLEANUP_GRACE_SECONDS: "1",
      URIEL_STATE_DIR: root,
      URIEL_WORKTREES_DIR: join(root, "worktrees")
    });
    const cleanup = new CleanupSupervisor(config);
    const worktree = join(config.worktreesDir, "job_1-feature");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "owned.txt"), "owned");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore"
    });
    children.push(child);
    if (!child.pid) throw new Error("test child did not start");
    const started = await ps(child.pid, "lstart=");
    await cleanup.ledger.record("job_1", "worktree", "worktree", { path: worktree });
    await cleanup.ledger.record("job_1", "harness-process", "harness-process", {
      command: process.execPath,
      pid: child.pid,
      processStartedAt: started
    });

    const actions = await cleanup.cleanupJob("job_1", "job cancelled");

    expect(actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "killed", resourceId: "harness-process" }),
      expect.objectContaining({ action: "deleted", resourceId: "worktree" })
    ]));
    await expect(stat(worktree)).rejects.toThrow();
    expect(await cleanup.ledger.active("job_1")).toEqual([]);
    expect(await cleanup.cleanupJob("job_1", "retry")).toEqual([]);
  });

  it("terminates the owned harness process group including descendants", async () => {
    const root = await temporaryDirectory();
    const config = loadConfig({
      URIEL_CLEANUP_GRACE_SECONDS: "1",
      URIEL_STATE_DIR: root
    });
    const cleanup = new CleanupSupervisor(config);
    const child = spawn("sh", ["-c", "sleep 30 & wait"], {
      detached: true,
      stdio: "ignore"
    });
    children.push(child);
    if (!child.pid) throw new Error("test process group did not start");
    await cleanup.ledger.record("job_1", "harness-process", "harness-process", {
      command: "sh",
      pid: child.pid,
      processGroup: true,
      processStartedAt: await ps(child.pid, "lstart=")
    });

    expect(await cleanup.cleanupJob("job_1", "job cancelled")).toContainEqual(
      expect.objectContaining({ action: "killed", resourceId: "harness-process" })
    );
    expect(processGroupExists(child.pid)).toBe(false);
  });

  it("re-proves Android AVD ownership before stopping a device", async () => {
    const root = await temporaryDirectory();
    const killLog = join(root, "kills.log");
    const adb = await executable(join(root, "bin", "adb"), `
if [ "\${1:-}" = "devices" ]; then
  echo "List of devices attached"
  echo "emulator-5554 device product:sdk model:Pixel"
  exit 0
fi
if [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "emu" ] && [ "\${4:-}" = "avd" ]; then
  if [ -f ${JSON.stringify(killLog)} ]; then exit 1; fi
  echo uriel_qa_1
  echo OK
  exit 0
fi
if [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "emu" ] && [ "\${4:-}" = "kill" ]; then
  echo "\${2}" >> ${JSON.stringify(killLog)}
  exit 0
fi
exit 1`);
    const config = loadConfig({
      URIEL_ANDROID_ADB_PATH: adb,
      URIEL_ANDROID_AVDS: "uriel_qa_1",
      URIEL_STATE_DIR: root
    });
    const cleanup = new CleanupSupervisor(config);
    await cleanup.ledger.record("job_1", "android-device", "android-device", {
      avd: "uriel_qa_1",
      serial: null
    });

    expect(await cleanup.cleanupJob("job_1", "job failed")).toContainEqual(
      expect.objectContaining({ action: "killed", resourceId: "android-device" })
    );
    expect(await readFile(killLog, "utf8")).toContain("emulator-5554");
  });

  it("reaps a completed job device after the idle TTL and cancels a stale reap on reuse", async () => {
    const root = await temporaryDirectory();
    const killLog = join(root, "kills.log");
    const adb = await executable(join(root, "bin", "adb"), `
if [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "emu" ] && [ "\${4:-}" = "avd" ]; then
  if [ -f ${JSON.stringify(killLog)} ]; then exit 1; fi
  echo uriel_qa_1
  echo OK
  exit 0
fi
if [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "emu" ] && [ "\${4:-}" = "kill" ]; then
  echo "\${2}" >> ${JSON.stringify(killLog)}
  exit 0
fi
exit 1`);
    const config = loadConfig({
      URIEL_ANDROID_ADB_PATH: adb,
      URIEL_ANDROID_AVDS: "uriel_qa_1",
      URIEL_DEVICE_IDLE_TTL_SECONDS: "1",
      URIEL_STATE_DIR: root
    });
    const cleanup = new CleanupSupervisor(config);
    await cleanup.ledger.record("job_1", "android-device", "android-device", {
      avd: "uriel_qa_1",
      serial: "emulator-5554"
    });

    expect(await cleanup.cleanupJob("job_1", "job completed")).toContainEqual(
      expect.objectContaining({ action: "retained", resourceId: "android-device" })
    );
    await cleanup.claimAndroidDevice("uriel_qa_1");
    expect(await cleanup.ledger.active("job_1")).toEqual([]);

    await cleanup.ledger.record("job_2", "android-device", "android-device", {
      avd: "uriel_qa_1",
      serial: "emulator-5554"
    });
    await cleanup.cleanupJob("job_2", "job completed");
    await waitForFile(killLog, 3_000);
    await waitForNoActive(cleanup.ledger, "job_2", 2_000);

    expect(await readFile(killLog, "utf8")).toContain("emulator-5554");
    expect(await cleanup.ledger.active("job_2")).toEqual([]);
  });

  it("refuses paths and device identities outside the worker ownership boundary", async () => {
    const root = await temporaryDirectory();
    const outside = join(root, "interactive", "job_1-feature");
    const linkedOutside = join(root, "interactive", "job_2-feature");
    await mkdir(outside, { recursive: true });
    await mkdir(linkedOutside, { recursive: true });
    const config = loadConfig({
      URIEL_ANDROID_AVDS: "uriel_qa_1",
      URIEL_STATE_DIR: root,
      URIEL_WORKTREES_DIR: join(root, "worktrees")
    });
    const cleanup = new CleanupSupervisor(config);
    await mkdir(config.worktreesDir, { recursive: true });
    await symlink(join(root, "interactive"), join(config.worktreesDir, "linked"));
    await cleanup.ledger.record("job_1", "worktree", "worktree", { path: outside });
    await cleanup.ledger.record("job_1", "android-device", "android-device", {
      avd: "dungeonqa_pool_1",
      serial: "emulator-5554"
    });
    await cleanup.ledger.record("job_2", "worktree", "worktree", {
      path: join(config.worktreesDir, "linked", "job_2-feature")
    });

    const actions = await cleanup.cleanupJob("job_1", "job cancelled");

    expect(actions.filter(({ action }) => action === "skipped")).toHaveLength(2);
    expect((await stat(outside)).isDirectory()).toBe(true);
    expect((await stat(linkedOutside)).isDirectory()).toBe(true);
    expect(ownedPath(config.worktreesDir, outside, "job_1")).toBe(false);
    expect(await cleanup.cleanupJob("job_2", "job cancelled")).toContainEqual(
      expect.objectContaining({ action: "skipped", resourceId: "worktree" })
    );
  });

  it("reconciles crash leftovers and expires retained artifacts", async () => {
    const root = await temporaryDirectory();
    const config = loadConfig({
      URIEL_ARTIFACT_RETENTION_DAYS: "1",
      URIEL_ARTIFACTS_DIR: join(root, "artifacts"),
      URIEL_STATE_DIR: root,
      URIEL_WORKTREES_DIR: join(root, "worktrees")
    });
    const cleanup = new CleanupSupervisor(config);
    const worktree = join(config.worktreesDir, "job_1-crashed");
    const artifacts = join(config.artifactsDir, "job_1");
    await mkdir(worktree, { recursive: true });
    await mkdir(artifacts, { recursive: true });
    await cleanup.ledger.record("job_1", "worktree", "worktree", { path: worktree });
    await cleanup.ledger.record("job_1", "artifacts", "artifacts", { path: artifacts });

    await cleanup.reconcileStartup();

    await expect(stat(worktree)).rejects.toThrow();
    expect((await stat(artifacts)).isDirectory()).toBe(true);
    expect(await cleanup.ledger.active("job_1")).toEqual([]);
    await cleanup.applyRetention(Date.now() + 2 * 86_400_000);
    await expect(stat(artifacts)).rejects.toThrow();
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "uriel-cleanup-"));
  temporaryDirectories.push(path);
  return path;
}

async function executable(path: string, body: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function ps(pid: number, field: string): Promise<string> {
  const { runCommand } = await import("../apps/worker/src/shell.ts");
  const result = await runCommand("ps", ["-p", String(pid), "-o", field]);
  return result.stdout.trim();
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForNoActive(
  ledger: ResourceLedger,
  jobId: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await ledger.active(jobId)).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${jobId} cleanup`);
}
