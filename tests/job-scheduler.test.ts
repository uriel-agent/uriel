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

    expect(scheduler.cancel("second")).toBe(true);
    expect(scheduler.cancel("second")).toBe(false);
    finishFirst?.();
    await new Promise((resolve) => setImmediate(resolve));

    expect(secondRun).not.toHaveBeenCalled();
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
});
