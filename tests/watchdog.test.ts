import { describe, expect, it, vi } from "vitest";

import { ReadinessWatchdog, type WatchdogProbe } from "../apps/worker/src/watchdog.ts";

describe("ReadinessWatchdog", () => {
  it("recovers only after a sustained actionable failure and alerts if it persists", async () => {
    const probe: WatchdogProbe = {
      actionable: true,
      causes: ["android.adb.responsive: adb unavailable"],
      status: "not-ready"
    };
    const recover = vi.fn(async () => undefined);
    const alert = vi.fn(async () => undefined);
    const watchdog = new ReadinessWatchdog({
      alert,
      cooldownMs: 10_000,
      intervalMs: 1_000,
      probe: async () => probe,
      recover,
      threshold: 3
    });

    await watchdog.tick(1_000);
    await watchdog.tick(2_000);
    expect(recover).not.toHaveBeenCalled();
    await watchdog.tick(3_000);

    expect(recover).toHaveBeenCalledOnce();
    expect(alert).toHaveBeenCalledWith(probe);
    expect(watchdog.snapshot()).toMatchObject({
      consecutiveDegraded: 3,
      lastStatus: "not-ready"
    });

    await watchdog.tick(4_000);
    expect(recover).toHaveBeenCalledOnce();
    await watchdog.tick(14_000);
    expect(recover).toHaveBeenCalledTimes(2);
  });

  it("does not recover while degradation is non-actionable", async () => {
    const recover = vi.fn(async () => undefined);
    const alert = vi.fn(async () => undefined);
    const watchdog = new ReadinessWatchdog({
      alert,
      cooldownMs: 1,
      intervalMs: 1_000,
      probe: async () => ({
        actionable: false,
        causes: ["real job active"],
        status: "degraded"
      }),
      recover,
      threshold: 1
    });

    await watchdog.tick(10);

    expect(recover).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it("clears the failure streak when bounded recovery restores readiness", async () => {
    let recovered = false;
    const alert = vi.fn(async () => undefined);
    const watchdog = new ReadinessWatchdog({
      alert,
      cooldownMs: 1,
      intervalMs: 1_000,
      probe: async () => recovered
        ? { actionable: true, causes: [], status: "ready" }
        : { actionable: true, causes: ["disk"], status: "not-ready" },
      recover: async () => { recovered = true; },
      threshold: 1
    });

    await watchdog.tick(10);

    expect(alert).not.toHaveBeenCalled();
    expect(watchdog.snapshot()).toMatchObject({
      consecutiveDegraded: 0,
      lastStatus: "ready"
    });
  });

  it("records both the degraded probe and the post-recovery result", async () => {
    let recovered = false;
    const record = vi.fn(async (_probe: WatchdogProbe, _at: string) => undefined);
    const watchdog = new ReadinessWatchdog({
      alert: vi.fn(async () => undefined),
      cooldownMs: 1,
      intervalMs: 1_000,
      probe: async () => recovered
        ? { actionable: true, causes: [], status: "ready" }
        : { actionable: true, causes: ["adb"], status: "not-ready" },
      record,
      recover: async () => { recovered = true; },
      threshold: 1
    });

    await watchdog.tick(Date.now());

    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0]?.[0]).toMatchObject({ status: "not-ready" });
    expect(record.mock.calls[1]?.[0]).toMatchObject({ status: "ready" });
  });

  it("keeps recovery available when history persistence fails", async () => {
    const recover = vi.fn(async () => undefined);
    const watchdog = new ReadinessWatchdog({
      alert: vi.fn(async () => undefined),
      cooldownMs: 1,
      intervalMs: 1_000,
      probe: async () => ({ actionable: true, causes: ["disk"], status: "not-ready" }),
      record: async () => { throw new Error("history disk full"); },
      recover,
      threshold: 1
    });

    await watchdog.tick(Date.now());

    expect(recover).toHaveBeenCalledOnce();
    expect(watchdog.snapshot().lastRecordError).toBe("history disk full");
  });

  it("aborts and records a bounded fallback when a probe exceeds its deadline", async () => {
    let signal: AbortSignal | undefined;
    const timeoutProbe: WatchdogProbe = {
      actionable: false,
      causes: ["watchdog.probe.timeout: readiness probe exceeded its deadline"],
      excludedReason: "job-load",
      status: "not-ready"
    };
    const record = vi.fn(async (_probe: WatchdogProbe, _at: string) => undefined);
    const watchdog = new ReadinessWatchdog({
      alert: vi.fn(async () => undefined),
      cooldownMs: 1,
      intervalMs: 30,
      probe: async (probeSignal) => {
        signal = probeSignal;
        return new Promise<WatchdogProbe>((_resolve, reject) => {
          probeSignal?.addEventListener("abort", () => reject(new Error("probe aborted")), { once: true });
        });
      },
      probeTimeoutMs: 10,
      record,
      recover: vi.fn(async () => undefined),
      threshold: 1,
      timeoutProbe: () => timeoutProbe
    });

    await watchdog.tick(1_000);

    expect(signal?.aborted).toBe(true);
    expect(record).toHaveBeenCalledWith(timeoutProbe, "1970-01-01T00:00:01.000Z");
    expect(watchdog.snapshot()).toMatchObject({
      consecutiveDegraded: 1,
      lastStatus: "not-ready"
    });
  });
});
