import { realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import type { JsonValue } from "../../../packages/core/src/index.ts";
import { isWorkerOwnedAndroidAvd } from "./android-ownership.ts";
import { listAttachedAndroidAvds, resolveAndroidTools } from "./android-tooling.ts";
import type { WorkerConfig } from "./config.ts";
import { ResourceLedger, type WorkerResourceRecord } from "./resource-ledger.ts";
import { runCommand } from "./shell.ts";

export interface CleanupAction {
  action: "deleted" | "killed" | "released" | "retained" | "skipped";
  detail: string;
  resourceId: string;
}

export class CleanupSupervisor {
  readonly ledger: ResourceLedger;
  private readonly idleDevices = new Map<string, {
    resource: WorkerResourceRecord;
    timer: NodeJS.Timeout;
  }>();

  constructor(private readonly config: WorkerConfig) {
    this.ledger = new ResourceLedger(config);
  }

  async cleanupJob(jobId: string, reason: string): Promise<CleanupAction[]> {
    const actions: CleanupAction[] = [];
    const resources = (await this.ledger.active(jobId)).reverse();
    for (const resource of resources) {
      let action: CleanupAction;
      try {
        action = resource.kind === "android-device" && reason === "job completed"
          ? this.scheduleIdleDeviceReap(resource)
          : await this.cleanupResource(resource, reason);
      } catch (error) {
        action = skipped(resource, `cleanup error: ${errorMessage(error)}`);
      }
      actions.push(action);
    }
    return actions;
  }

  async claimAndroidDevice(avd: string): Promise<void> {
    const scheduled = this.idleDevices.get(avd);
    if (!scheduled) return;
    clearTimeout(scheduled.timer);
    this.idleDevices.delete(avd);
    await this.ledger.release(scheduled.resource.jobId, scheduled.resource.id);
  }

  async reconcileStartup(): Promise<CleanupAction[]> {
    const actions: CleanupAction[] = [];
    for (const resource of (await this.ledger.active()).reverse()) {
      actions.push(await this.cleanupResource(resource, "worker restart"));
    }
    actions.push(...await this.applyRetention());
    return actions;
  }

  async applyRetention(now = Date.now()): Promise<CleanupAction[]> {
    const actions: CleanupAction[] = [];
    for (const ledger of await this.ledger.readAll()) {
      for (const resource of ledger.resources) {
        if (resource.kind !== "artifacts" || resource.status !== "released") continue;
        const releasedAt = Date.parse(resource.releasedAt ?? resource.updatedAt);
        if (now - releasedAt < this.config.artifactRetentionDays * 86_400_000) continue;
        const path = metadataString(resource, "path");
        if (!path || await pathOwnership(this.config.artifactsDir, path, resource.jobId) === "unowned") {
          actions.push(skipped(resource, "artifact path ownership could not be proven"));
          continue;
        }
        await rm(path, { force: true, recursive: true });
        actions.push({ action: "deleted", detail: path, resourceId: resource.id });
      }
      const lastUpdate = Math.max(0, ...ledger.resources.map((resource) => Date.parse(resource.updatedAt)));
      if (
        ledger.resources.length > 0 &&
        ledger.resources.every((resource) => resource.status === "released") &&
        now - lastUpdate >= this.config.ledgerRetentionDays * 86_400_000
      ) {
        await this.ledger.remove(ledger.jobId);
      }
    }
    return actions;
  }

  private async cleanupResource(resource: WorkerResourceRecord, reason: string): Promise<CleanupAction> {
    if (resource.owner !== "uriel-worker") return skipped(resource, "resource owner is not Uriel");
    switch (resource.kind) {
      case "harness-process":
        return this.stopHarness(resource);
      case "android-device":
        return this.stopAndroidDevice(resource);
      case "worktree":
        return this.removeOwnedDirectory(resource, this.config.worktreesDir);
      case "artifacts":
        await this.ledger.release(resource.jobId, resource.id);
        return {
          action: "retained",
          detail: `retained by ${this.config.artifactRetentionDays}-day policy after ${reason}`,
          resourceId: resource.id
        };
      case "android-lease":
      case "package-marker":
        await this.ledger.release(resource.jobId, resource.id);
        return { action: "released", detail: reason, resourceId: resource.id };
    }
  }

  private async stopHarness(resource: WorkerResourceRecord): Promise<CleanupAction> {
    const pid = metadataNumber(resource, "pid");
    const expectedCommand = metadataString(resource, "command");
    const expectedStart = metadataString(resource, "processStartedAt");
    const processGroup = resource.metadata.processGroup === true;
    if (!pid || !expectedCommand) return skipped(resource, "process identity is incomplete");
    const command = await processCommand(pid);
    if (!command) {
      if (processGroup && await trackedProcessExists(pid, true)) {
        return skipped(resource, `process-group ${pid} remains without its journaled leader`);
      }
      await this.ledger.release(resource.jobId, resource.id);
      return { action: "released", detail: "process already exited", resourceId: resource.id };
    }
    if (!commandIncludesExecutable(command, expectedCommand)) {
      return skipped(resource, `PID ${pid} no longer matches ${expectedCommand}`);
    }
    if (expectedStart && await processStart(pid) !== expectedStart) {
      return skipped(resource, `PID ${pid} start time no longer matches the journal`);
    }
    try {
      killTrackedProcess(pid, processGroup, "SIGTERM");
    } catch {
      // A process that exited after the ownership check is already clean.
    }
    const deadline = Date.now() + this.config.cleanupGraceSeconds * 1_000;
    let remaining = await trackedProcessExists(pid, processGroup);
    while (remaining && Date.now() < deadline) {
      await wait(Math.min(200, Math.max(1, deadline - Date.now())));
      remaining = await trackedProcessExists(pid, processGroup);
    }
    if (remaining) {
      const currentCommand = await processCommand(pid);
      const currentStart = await processStart(pid);
      if (currentCommand && (
        !commandIncludesExecutable(currentCommand, expectedCommand) ||
        (expectedStart && currentStart !== expectedStart)
      )) {
        return skipped(resource, `PID ${pid} changed identity before force-kill`);
      }
      killTrackedProcess(pid, processGroup, "SIGKILL");
      await wait(100);
      if (await trackedProcessExists(pid, processGroup)) {
        return skipped(resource, `${expectedCommand} pid ${pid} survived SIGKILL`);
      }
    }
    await this.ledger.release(resource.jobId, resource.id);
    return { action: "killed", detail: `${expectedCommand} pid ${pid}`, resourceId: resource.id };
  }

  private scheduleIdleDeviceReap(resource: WorkerResourceRecord): CleanupAction {
    const avd = metadataString(resource, "avd");
    if (!avd || !isWorkerOwnedAndroidAvd(this.config, avd)) {
      return skipped(resource, "Android ownership metadata is incomplete or not worker-owned");
    }
    const existing = this.idleDevices.get(avd);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.idleDevices.delete(avd);
      void this.stopAndroidDevice(resource).catch((error) => {
        console.error(`Idle Android cleanup failed for ${avd}: ${errorMessage(error)}`);
      });
    }, this.config.deviceIdleTtlSeconds * 1_000);
    timer.unref();
    this.idleDevices.set(avd, { resource, timer });
    return {
      action: "retained",
      detail: `idle reap scheduled in ${this.config.deviceIdleTtlSeconds} seconds`,
      resourceId: resource.id
    };
  }

  private async stopAndroidDevice(resource: WorkerResourceRecord): Promise<CleanupAction> {
    const avd = metadataString(resource, "avd");
    let serial = metadataString(resource, "serial");
    if (!avd || !isWorkerOwnedAndroidAvd(this.config, avd)) {
      return skipped(resource, "Android ownership metadata is incomplete or not worker-owned");
    }
    const adb = (await resolveAndroidTools(this.config)).adb;
    if (!adb) return skipped(resource, "adb is unavailable for ownership recheck");
    let actualAvd = serial ? await androidAvdName(adb.command, serial) : undefined;
    if (actualAvd !== avd) {
      const attached = await listAttachedAndroidAvds(adb.command);
      const binding = attached.avds.find((candidate) => candidate.avd === avd);
      if (!binding) {
        if (attached.error) return skipped(resource, `adb ownership recheck failed: ${attached.error}`);
        await this.ledger.release(resource.jobId, resource.id);
        return { action: "released", detail: `${avd} is already stopped`, resourceId: resource.id };
      }
      serial = binding.serial;
      actualAvd = await androidAvdName(adb.command, serial);
    }
    if (!serial || actualAvd !== avd) {
      return skipped(resource, `serial ${serial} did not re-prove AVD ${avd}`);
    }
    const killed = await runCommand(adb.command, ["-s", serial, "emu", "kill"], {
      timeoutMs: 30_000
    });
    if (killed.code !== 0) {
      return skipped(resource, `adb could not stop ${avd} at ${serial}`);
    }
    const deadline = Date.now() + this.config.cleanupGraceSeconds * 1_000;
    while (Date.now() < deadline) {
      const remaining = await androidAvdName(adb.command, serial);
      if (remaining !== avd) break;
      await wait(Math.min(200, Math.max(1, deadline - Date.now())));
    }
    if (await androidAvdName(adb.command, serial) === avd) {
      return skipped(resource, `${avd} at ${serial} survived the cleanup window`);
    }
    await this.ledger.release(resource.jobId, resource.id);
    return { action: "killed", detail: `${avd} at ${serial}`, resourceId: resource.id };
  }

  private async removeOwnedDirectory(
    resource: WorkerResourceRecord,
    root: string
  ): Promise<CleanupAction> {
    const path = metadataString(resource, "path");
    if (!path) {
      return skipped(resource, "directory ownership could not be proven");
    }
    const ownership = await pathOwnership(root, path, resource.jobId);
    if (ownership === "unowned") return skipped(resource, "directory ownership could not be proven");
    if (ownership === "missing") {
      await this.ledger.release(resource.jobId, resource.id);
      return { action: "released", detail: "directory already absent", resourceId: resource.id };
    }
    const cacheDir = metadataString(resource, "cacheDir");
    if (resource.kind === "worktree" && cacheDir && await pathWithinRoot(this.config.reposDir, cacheDir)) {
      await runCommand("git", ["-C", cacheDir, "worktree", "remove", "--force", path], {
        timeoutMs: 30_000
      });
    }
    await rm(path, { force: true, recursive: true });
    await this.ledger.release(resource.jobId, resource.id);
    return { action: "deleted", detail: path, resourceId: resource.id };
  }
}

async function pathOwnership(
  root: string,
  target: string,
  jobId: string
): Promise<"missing" | "owned" | "unowned"> {
  if (!ownedPath(root, target, jobId)) return "unowned";
  try {
    const [actualRoot, actualTarget] = await Promise.all([realpath(root), realpath(target)]);
    return ownedPath(actualRoot, actualTarget, jobId) ? "owned" : "unowned";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unowned";
  }
}

async function pathWithinRoot(root: string, target: string): Promise<boolean> {
  try {
    const [actualRoot, actualTarget] = await Promise.all([realpath(root), realpath(target)]);
    const within = relative(actualRoot, actualTarget);
    return within !== "" && !within.startsWith("..") && !isAbsolute(within);
  } catch {
    return false;
  }
}

export function ownedPath(root: string, target: string, jobId: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const within = relative(resolvedRoot, resolvedTarget);
  const isWithinRoot = within !== "" && !within.startsWith("..") && !isAbsolute(within);
  const hasOwnedName = basename(resolvedTarget).startsWith(`${jobId}-`) ||
    resolvedTarget === resolve(root, jobId);
  return isWithinRoot && hasOwnedName;
}

function metadataString(resource: WorkerResourceRecord, key: string): string | undefined {
  const value: JsonValue | undefined = resource.metadata[key];
  return typeof value === "string" ? value : undefined;
}

function metadataNumber(resource: WorkerResourceRecord, key: string): number | undefined {
  const value: JsonValue | undefined = resource.metadata[key];
  return typeof value === "number" ? value : undefined;
}

async function processCommand(pid: number): Promise<string | undefined> {
  const result = await runCommand("ps", ["-p", String(pid), "-o", "command="], { timeoutMs: 5_000 });
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

async function processStart(pid: number): Promise<string | undefined> {
  const result = await runCommand("ps", ["-p", String(pid), "-o", "lstart="], { timeoutMs: 5_000 });
  return result.code === 0 ? result.stdout.trim() || undefined : undefined;
}

async function androidAvdName(adb: string, serial: string): Promise<string | undefined> {
  const result = await runCommand(adb, ["-s", serial, "emu", "avd", "name"], {
    timeoutMs: 5_000
  });
  return result.code === 0
    ? result.stdout.split(/\r?\n/u).map((line) => line.trim())
      .find((line) => line && line !== "OK")
    : undefined;
}

function killTrackedProcess(pid: number, group: boolean, signal: NodeJS.Signals): void {
  try {
    process.kill(group && process.platform !== "win32" ? -pid : pid, signal);
  } catch {
    // The tracked process already exited.
  }
}

async function trackedProcessExists(pid: number, group: boolean): Promise<boolean> {
  try {
    process.kill(group && process.platform !== "win32" ? -pid : pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandIncludesExecutable(actual: string, expected: string): boolean {
  const executable = basename(expected);
  return actual.split(/\s+/u).some((part) => basename(part) === executable);
}

function skipped(resource: WorkerResourceRecord, detail: string): CleanupAction {
  return { action: "skipped", detail, resourceId: resource.id };
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
