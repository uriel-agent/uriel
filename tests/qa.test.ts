import { describe, expect, it } from "vitest";

import { parseBootedDeviceSerials } from "../apps/worker/src/qa.ts";

describe("Android device targeting", () => {
  it("returns only fully booted adb device serials", () => {
    expect(
      parseBootedDeviceSerials(`List of devices attached
emulator-5554\tdevice
emulator-5556\toffline
R58M1234\tunauthorized
physical-1 device
`)
    ).toEqual(["emulator-5554", "physical-1"]);
  });
});
