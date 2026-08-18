import { readFile, statfs } from "node:fs/promises";
import { freemem, totalmem } from "node:os";

import type { WorkerConfig } from "./config.ts";
import { runCommand } from "./shell.ts";

const MEBIBYTE = 1024 * 1024;

export interface HostMetrics {
  diskAvailableBytes?: number;
  memoryAvailableBytes?: number;
  memoryTotalBytes?: number;
  swapUsedBytes?: number;
}

export interface WorkerCapacityUsage {
  activeHeavyJobs: number;
  queuedJobs: number;
}

export interface HostCapacityResource {
  actualBytes: number | null;
  limitBytes: number;
  ok: boolean | null;
}

export interface HostCapacitySnapshot {
  disk: HostCapacityResource;
  measuredAt: string;
  memory: HostCapacityResource & { totalBytes: number | null };
  missingReadings: string[];
  status: "available" | "degraded" | "pressured";
  swap: HostCapacityResource;
  worker: WorkerCapacityUsage & { maxHeavyJobs: number };
}

export interface HostCapacityDecision {
  admitted: boolean;
  reason?: string;
  snapshot: HostCapacitySnapshot;
}

type MetricsReader = (stateDir: string) => Promise<HostMetrics>;

export class HostCapacityGovernor {
  constructor(
    private readonly config: WorkerConfig,
    private readonly readMetrics: MetricsReader = readHostMetrics
  ) {}

  async evaluate(
    usage: WorkerCapacityUsage,
    options: { enforceWorkerLimit?: boolean } = {}
  ): Promise<HostCapacityDecision> {
    const metrics = await this.readMetrics(this.config.stateDir);
    const memory = resource(
      metrics.memoryAvailableBytes,
      this.config.capacityMinFreeMemoryMb * MEBIBYTE,
      (actual, limit) => actual >= limit
    );
    const swap = resource(
      metrics.swapUsedBytes,
      this.config.capacityMaxSwapUsedMb * MEBIBYTE,
      (actual, limit) => actual <= limit
    );
    const disk = resource(
      metrics.diskAvailableBytes,
      this.config.capacityMinFreeDiskMb * MEBIBYTE,
      (actual, limit) => actual >= limit
    );
    const missingReadings = [
      ...(memory.ok === null ? ["memory"] : []),
      ...(swap.ok === null ? ["swap"] : []),
      ...(disk.ok === null ? ["disk"] : [])
    ];
    const reasons = [
      ...(memory.ok === false
        ? [`available RAM ${formatMiB(memory.actualBytes)} is below reserve ${formatMiB(memory.limitBytes)}`]
        : []),
      ...(swap.ok === false
        ? [`swap usage ${formatMiB(swap.actualBytes)} exceeds limit ${formatMiB(swap.limitBytes)}`]
        : []),
      ...(disk.ok === false
        ? [`free disk ${formatMiB(disk.actualBytes)} is below reserve ${formatMiB(disk.limitBytes)}`]
        : [])
    ];
    const enforceWorkerLimit = options.enforceWorkerLimit ?? true;
    if (enforceWorkerLimit && usage.activeHeavyJobs >= this.config.maxHeavyJobs) {
      reasons.push(
        `active heavy jobs ${usage.activeHeavyJobs} reached cap ${this.config.maxHeavyJobs}`
      );
    }
    if (enforceWorkerLimit && missingReadings.length > 0 && usage.activeHeavyJobs >= 1) {
      reasons.push(
        `capacity readings unavailable (${missingReadings.join(", ")}); conservative single-slot policy is active`
      );
    }

    const admitted = reasons.length === 0;
    const snapshot: HostCapacitySnapshot = {
      disk,
      measuredAt: new Date().toISOString(),
      memory: { ...memory, totalBytes: metrics.memoryTotalBytes ?? null },
      missingReadings,
      status: admitted
        ? missingReadings.length > 0 ? "degraded" : "available"
        : "pressured",
      swap,
      worker: { ...usage, maxHeavyJobs: this.config.maxHeavyJobs }
    };
    return {
      admitted,
      ...(admitted ? {} : { reason: reasons.join("; ") }),
      snapshot
    };
  }
}

export async function readHostMetrics(stateDir: string): Promise<HostMetrics> {
  const [memory, swapUsedBytes, diskAvailableBytes] = await Promise.all([
    readMemoryMetrics(),
    readSwapUsedBytes(),
    readDiskAvailableBytes(stateDir)
  ]);
  return {
    ...memory,
    ...(swapUsedBytes === undefined ? {} : { swapUsedBytes }),
    ...(diskAvailableBytes === undefined ? {} : { diskAvailableBytes })
  };
}

export function parseMacSwapUsage(output: string): number | undefined {
  const match = /used\s*=\s*([\d.]+)([KMG])/iu.exec(output);
  return match?.[1] && match[2]
    ? Number.parseFloat(match[1]) * unitBytes(match[2])
    : undefined;
}

export function parseLinuxMeminfo(output: string): {
  memoryAvailableBytes?: number;
  memoryTotalBytes?: number;
  swapUsedBytes?: number;
} {
  const values = new Map<string, number>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(MemAvailable|MemTotal|SwapFree|SwapTotal):\s+(\d+)\s+kB$/u.exec(line);
    if (match?.[1] && match[2]) values.set(match[1], Number.parseInt(match[2], 10) * 1024);
  }
  const swapFree = values.get("SwapFree");
  const swapTotal = values.get("SwapTotal");
  return {
    ...(values.get("MemAvailable") === undefined
      ? {}
      : { memoryAvailableBytes: values.get("MemAvailable") }),
    ...(values.get("MemTotal") === undefined
      ? {}
      : { memoryTotalBytes: values.get("MemTotal") }),
    ...(swapFree === undefined || swapTotal === undefined
      ? {}
      : { swapUsedBytes: Math.max(0, swapTotal - swapFree) })
  };
}

async function readMemoryMetrics(): Promise<Pick<HostMetrics, "memoryAvailableBytes" | "memoryTotalBytes">> {
  if (process.platform === "darwin") {
    try {
      const result = await runCommand("memory_pressure", ["-Q"], { timeoutMs: 10_000 });
      const percent = /System-wide memory free percentage:\s*(\d+)%/u.exec(result.stdout)?.[1];
      if (result.code === 0 && percent) {
        const total = totalmem();
        return {
          memoryAvailableBytes: total * Number.parseInt(percent, 10) / 100,
          memoryTotalBytes: total
        };
      }
    } catch {
      return {};
    }
  } else if (process.platform === "linux") {
    try {
      const parsed = parseLinuxMeminfo(await readFile("/proc/meminfo", "utf8"));
      if (parsed.memoryAvailableBytes !== undefined) {
        return parsed;
      }
    } catch {
      // Fall through to the portable reading.
    }
  }
  return { memoryAvailableBytes: freemem(), memoryTotalBytes: totalmem() };
}

async function readSwapUsedBytes(): Promise<number | undefined> {
  if (process.platform === "darwin") {
    try {
      const result = await runCommand("sysctl", ["-n", "vm.swapusage"], { timeoutMs: 10_000 });
      return result.code === 0 ? parseMacSwapUsage(result.stdout) : undefined;
    } catch {
      return undefined;
    }
  }
  if (process.platform === "linux") {
    try {
      return parseLinuxMeminfo(await readFile("/proc/meminfo", "utf8")).swapUsedBytes;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function readDiskAvailableBytes(stateDir: string): Promise<number | undefined> {
  try {
    const value = await statfs(stateDir);
    return value.bavail * value.bsize;
  } catch {
    return undefined;
  }
}

function resource(
  actualBytes: number | undefined,
  limitBytes: number,
  compare: (actual: number, limit: number) => boolean
): HostCapacityResource {
  return {
    actualBytes: actualBytes ?? null,
    limitBytes,
    ok: actualBytes === undefined ? null : compare(actualBytes, limitBytes)
  };
}

function formatMiB(bytes: number | null): string {
  return bytes === null ? "unknown" : `${Math.round(bytes / MEBIBYTE)} MiB`;
}

function unitBytes(unit: string): number {
  if (unit.toUpperCase() === "G") return 1024 ** 3;
  if (unit.toUpperCase() === "M") return MEBIBYTE;
  return 1024;
}
