import { describe, expect, it } from "vitest";

import { JobScheduler } from "../apps/worker/src/scheduler.ts";

describe("job scheduler", () => {
  it("removes a queued job when it is cancelled", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstFinished = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondRan = false;
    const scheduler = new JobScheduler(1);

    scheduler.enqueue({ id: "first", run: () => firstFinished });
    scheduler.enqueue({
      id: "second",
      run: async () => {
        secondRan = true;
      }
    });

    expect(scheduler.snapshot()).toEqual({
      active: 1,
      pending: ["second"]
    });
    expect(scheduler.cancel("second")).toBe(true);
    expect(scheduler.snapshot()).toEqual({ active: 1, pending: [] });

    releaseFirst?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondRan).toBe(false);
  });

  it("honors the configured concurrency limit", async () => {
    const releases: Array<() => void> = [];
    const scheduler = new JobScheduler(2);

    for (const id of ["one", "two", "three"]) {
      scheduler.enqueue({
        id,
        run: () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          })
      });
    }

    expect(scheduler.snapshot()).toEqual({
      active: 2,
      pending: ["three"]
    });
    releases.shift()?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(scheduler.snapshot()).toEqual({ active: 2, pending: [] });
    for (const release of releases) {
      release();
    }
  });
});
