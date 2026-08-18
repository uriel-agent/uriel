import { describe, expect, it } from "vitest";

import { AndroidSlotPool } from "../apps/worker/src/android-slots.ts";
import {
  androidAvdOwnershipErrors,
  isWorkerOwnedAndroidAvd
} from "../apps/worker/src/android-ownership.ts";
import { loadConfig } from "../apps/worker/src/config.ts";

describe("AndroidSlotPool", () => {
  it("leases each configured AVD exclusively and wakes a waiter on release", async () => {
    const pool = new AndroidSlotPool(["uriel_qa_1", "uriel_qa_2", "uriel_qa_1"]);
    const first = await pool.acquire();
    const second = await pool.acquire();
    let thirdResolved = false;
    const thirdPromise = pool.acquire().then((lease) => {
      thirdResolved = true;
      return lease;
    });

    expect([first.avd, second.avd]).toEqual(["uriel_qa_1", "uriel_qa_2"]);
    await Promise.resolve();
    expect(thirdResolved).toBe(false);

    first.release();
    const third = await thirdPromise;
    expect(third.avd).toBe("uriel_qa_1");

    first.release();
    second.release();
    third.release();
  });

  it("rejects acquisition when no dedicated AVD pool is configured", async () => {
    const pool = new AndroidSlotPool([]);

    await expect(pool.acquire()).rejects.toThrow("no dedicated worker-owned AVD");
  });
});

describe("Android AVD ownership", () => {
  it("accepts only explicitly configured worker-owned AVDs", () => {
    const config = loadConfig({ URIEL_ANDROID_AVDS: "uriel_qa_1,uriel_qa_2" });

    expect(androidAvdOwnershipErrors(config)).toEqual([]);
    expect(isWorkerOwnedAndroidAvd(config, "uriel_qa_1")).toBe(true);
    expect(isWorkerOwnedAndroidAvd(config, "uriel_unconfigured")).toBe(false);
  });

  it("rejects implicit, interactive, and wrong-prefix AVD configuration", () => {
    expect(androidAvdOwnershipErrors(loadConfig({}))).toContainEqual(
      expect.stringContaining("requires at least one dedicated AVD")
    );
    expect(androidAvdOwnershipErrors(loadConfig({
      URIEL_ANDROID_AVDS: "dungeonqa_pool_1"
    }))).toContainEqual(expect.stringContaining("interactive developer pool"));
    expect(androidAvdOwnershipErrors(loadConfig({
      URIEL_ANDROID_AVDS: "shared_qa_1"
    }))).toContainEqual(expect.stringContaining("not worker-owned"));
  });
});
