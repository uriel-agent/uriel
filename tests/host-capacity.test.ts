import { describe, expect, it } from "vitest";

import { loadConfig } from "../apps/worker/src/config.ts";
import {
  HostCapacityGovernor,
  parseLinuxMeminfo,
  parseMacSwapUsage
} from "../apps/worker/src/host-capacity.ts";

const MIB = 1024 * 1024;

describe("HostCapacityGovernor", () => {
  it("reports structured pressure across RAM, swap, and disk", async () => {
    const governor = new HostCapacityGovernor(config(), async () => ({
      diskAvailableBytes: 1_000 * MIB,
      memoryAvailableBytes: 512 * MIB,
      memoryTotalBytes: 16_384 * MIB,
      swapUsedBytes: 9_000 * MIB
    }));

    const decision = await governor.evaluate({ activeHeavyJobs: 0, queuedJobs: 3 });

    expect(decision.admitted).toBe(false);
    expect(decision.reason).toContain("available RAM 512 MiB is below reserve 4096 MiB");
    expect(decision.reason).toContain("swap usage 9000 MiB exceeds limit 8192 MiB");
    expect(decision.reason).toContain("free disk 1000 MiB is below reserve 20480 MiB");
    expect(decision.snapshot).toMatchObject({
      missingReadings: [],
      status: "pressured",
      worker: { activeHeavyJobs: 0, maxHeavyJobs: 1, queuedJobs: 3 }
    });
  });

  it("admits after resources recover", async () => {
    let availableMemory = 512 * MIB;
    const governor = new HostCapacityGovernor(config(), async () => ({
      diskAvailableBytes: 40_000 * MIB,
      memoryAvailableBytes: availableMemory,
      memoryTotalBytes: 16_384 * MIB,
      swapUsedBytes: 1_000 * MIB
    }));

    expect((await governor.evaluate({ activeHeavyJobs: 0, queuedJobs: 1 })).admitted).toBe(false);
    availableMemory = 8_000 * MIB;
    expect(await governor.evaluate({ activeHeavyJobs: 0, queuedJobs: 1 })).toMatchObject({
      admitted: true,
      snapshot: { status: "available" }
    });
  });

  it("keeps sticky swap diagnostic-only when enforcement is disabled", async () => {
    const workerConfig = config();
    workerConfig.capacityEnforceSwap = false;
    const governor = new HostCapacityGovernor(workerConfig, async () => ({
      diskAvailableBytes: 40_000 * MIB,
      memoryAvailableBytes: 8_000 * MIB,
      memoryTotalBytes: 16_384 * MIB,
      swapUsedBytes: 9_000 * MIB
    }));

    const decision = await governor.evaluate({ activeHeavyJobs: 0, queuedJobs: 0 });

    expect(decision).toMatchObject({
      admitted: true,
      snapshot: {
        status: "available",
        swap: { enforced: false, ok: false }
      }
    });
    expect(decision.reason).toBeUndefined();
  });

  it("does not degrade when a diagnostic-only swap reading is unavailable", async () => {
    const workerConfig = config();
    workerConfig.capacityEnforceSwap = false;
    const governor = new HostCapacityGovernor(workerConfig, async () => ({
      diskAvailableBytes: 40_000 * MIB,
      memoryAvailableBytes: 8_000 * MIB,
      memoryTotalBytes: 16_384 * MIB
    }));

    expect(await governor.evaluate({ activeHeavyJobs: 0, queuedJobs: 0 })).toMatchObject({
      admitted: true,
      snapshot: {
        missingReadings: [],
        status: "available",
        swap: { actualBytes: null, enforced: false, ok: null }
      }
    });
  });

  it("uses a conservative single slot when readings are missing", async () => {
    const governor = new HostCapacityGovernor(config(), async () => ({}));

    const idle = await governor.evaluate({ activeHeavyJobs: 0, queuedJobs: 1 });
    const busy = await governor.evaluate({ activeHeavyJobs: 1, queuedJobs: 1 });

    expect(idle).toMatchObject({
      admitted: true,
      snapshot: { missingReadings: ["memory", "swap", "disk"], status: "degraded" }
    });
    expect(busy.admitted).toBe(false);
    expect(busy.reason).toContain("conservative single-slot policy");
    expect(await governor.evaluate(
      { activeHeavyJobs: 1, queuedJobs: 1 },
      { enforceWorkerLimit: false }
    )).toMatchObject({ admitted: true, snapshot: { status: "degraded" } });
  });

  it("parses macOS swap and Linux memory metrics", () => {
    expect(parseMacSwapUsage("total = 32768.00M  used = 30210.25M  free = 2557.75M")).toBe(
      30210.25 * MIB
    );
    expect(parseLinuxMeminfo([
      "MemTotal:       16000000 kB",
      "MemAvailable:    8000000 kB",
      "SwapTotal:       4000000 kB",
      "SwapFree:        1000000 kB"
    ].join("\n"))).toEqual({
      memoryAvailableBytes: 8_000_000 * 1024,
      memoryTotalBytes: 16_000_000 * 1024,
      swapUsedBytes: 3_000_000 * 1024
    });
  });
});

function config() {
  return loadConfig({
    URIEL_CAPACITY_ENFORCE_SWAP: "true",
    URIEL_CAPACITY_MAX_SWAP_USED_MB: "8192",
    URIEL_CAPACITY_MIN_FREE_DISK_MB: "20480",
    URIEL_CAPACITY_MIN_FREE_MEMORY_MB: "4096"
  });
}
