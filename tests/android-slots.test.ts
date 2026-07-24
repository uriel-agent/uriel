import { describe, expect, it } from "vitest";

import { AndroidSlotPool } from "../apps/worker/src/android-slots.ts";

describe("AndroidSlotPool", () => {
  it("leases each configured AVD exclusively and wakes a waiter on release", async () => {
    const pool = new AndroidSlotPool(["qa-1", "qa-2", "qa-1"]);
    const first = await pool.acquire();
    const second = await pool.acquire();
    let thirdResolved = false;
    const thirdPromise = pool.acquire().then((lease) => {
      thirdResolved = true;
      return lease;
    });

    expect([first.avd, second.avd]).toEqual(["qa-1", "qa-2"]);
    await Promise.resolve();
    expect(thirdResolved).toBe(false);

    first.release();
    const third = await thirdPromise;
    expect(third.avd).toBe("qa-1");

    first.release();
    second.release();
    third.release();
  });

  it("serializes attached-device jobs when no AVD pool is configured", async () => {
    const pool = new AndroidSlotPool([]);
    const first = await pool.acquire();
    let secondResolved = false;
    const secondPromise = pool.acquire().then((lease) => {
      secondResolved = true;
      return lease;
    });

    expect(first.avd).toBeUndefined();
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    first.release();
    const second = await secondPromise;
    expect(second.avd).toBeUndefined();
    second.release();
  });
});
