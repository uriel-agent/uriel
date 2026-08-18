import { describe, expect, it, vi } from "vitest";

import { JobScheduler } from "../apps/worker/src/job-scheduler.ts";

describe("JobScheduler", () => {
  it("removes a queued job when it is cancelled", async () => {
    let finishFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const secondRun = vi.fn(async () => undefined);
    const scheduler = new JobScheduler(1);

    scheduler.enqueue("first", () => first);
    scheduler.enqueue("second", secondRun);

    expect(scheduler.cancel("second")).toBe("queued");
    expect(scheduler.cancel("second")).toBe(false);
    finishFirst?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(secondRun).not.toHaveBeenCalled();
  });

  it("aborts a job that has dequeued and releases its active slot", async () => {
    let observedAbort = false;
    const scheduler = new JobScheduler(1);
    scheduler.enqueue("active", async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          resolve();
        }, { once: true });
      });
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(scheduler.cancel("active")).toBe("active");
    await new Promise((resolve) => setImmediate(resolve));

    expect(observedAbort).toBe(true);
    expect(scheduler.state()).toMatchObject({ activeJobs: 0, queuedJobs: 0 });
    expect(scheduler.cancel("active")).toBe(false);
  });

  it("continues draining after a job failure", async () => {
    const error = new Error("boom");
    const onError = vi.fn();
    const nextRun = vi.fn(async () => undefined);
    const scheduler = new JobScheduler(1, onError);

    scheduler.enqueue("failure", async () => {
      throw error;
    });
    scheduler.enqueue("next", nextRun);
    await new Promise((resolve) => setImmediate(resolve));

    expect(onError).toHaveBeenCalledWith(error);
    expect(nextRun).toHaveBeenCalledOnce();
  });

  it("keeps jobs FIFO while pressure blocks the head and wakes on recovery", async () => {
    let available = false;
    const order: string[] = [];
    const onBlocked = vi.fn();
    const onUnblocked = vi.fn();
    const scheduler = new JobScheduler(2, () => undefined, {
      admission: async () => ({
        admitted: available,
        ...(available ? {} : { reason: "memory reserve" })
      }),
      onBlocked,
      onUnblocked,
      retryDelayMs: 5
    });

    scheduler.enqueue("first", async () => { order.push("first"); });
    scheduler.enqueue("second", async () => { order.push("second"); });
    await wait(10);

    expect(order).toEqual([]);
    expect(scheduler.state()).toMatchObject({
      blocked: { jobId: "first", reason: "memory reserve" },
      queuedJobs: 2
    });
    expect(onBlocked).toHaveBeenCalledOnce();

    available = true;
    await wait(20);

    expect(order).toEqual(["first", "second"]);
    expect(onUnblocked).toHaveBeenCalledOnce();
    expect(scheduler.state()).toMatchObject({ activeJobs: 0, queuedJobs: 0 });
  });

  it("treats admission probe failures as temporary pressure", async () => {
    let attempts = 0;
    const run = vi.fn(async () => undefined);
    const onBlocked = vi.fn();
    const scheduler = new JobScheduler(1, () => undefined, {
      admission: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("probe unavailable");
        return { admitted: true };
      },
      onBlocked,
      retryDelayMs: 5
    });

    scheduler.enqueue("job", run);
    await wait(20);

    expect(onBlocked).toHaveBeenCalledWith("job", expect.objectContaining({
      admitted: false,
      reason: "capacity admission check failed: probe unavailable"
    }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("still retries when blocked-event reporting fails", async () => {
    let available = false;
    const run = vi.fn(async () => undefined);
    const onError = vi.fn();
    const scheduler = new JobScheduler(1, onError, {
      admission: async () => ({ admitted: available, reason: "disk reserve" }),
      onBlocked: async () => { throw new Error("event store unavailable"); },
      retryDelayMs: 5
    });

    scheduler.enqueue("job", run);
    await wait(10);
    available = true;
    await wait(20);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "event store unavailable"
    }));
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not lose a wakeup during an in-flight admission probe", async () => {
    let releaseProbe: (() => void) | undefined;
    const probe = new Promise<void>((resolve) => { releaseProbe = resolve; });
    let firstProbe = true;
    const run = vi.fn(async () => undefined);
    const scheduler = new JobScheduler(1, () => undefined, {
      admission: async () => {
        if (firstProbe) {
          firstProbe = false;
          await probe;
          return { admitted: false, reason: "maintenance" };
        }
        return { admitted: true };
      },
      retryDelayMs: 60_000
    });

    scheduler.enqueue("job", run);
    await new Promise((resolve) => setImmediate(resolve));
    scheduler.wake();
    releaseProbe?.();
    await wait(20);

    expect(run).toHaveBeenCalledOnce();
  });
});

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
