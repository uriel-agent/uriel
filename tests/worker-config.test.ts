import { describe, expect, it } from "vitest";

import { loadConfig } from "../apps/worker/src/config.ts";

describe("worker config", () => {
  it("parses framework knobs from environment", () => {
    const config = loadConfig({
      URIEL_ALLOWED_REPOS: "uriel-agent/uriel,https://github.com/acme/app",
      URIEL_ANDROID_BOOT_TIMEOUT_SECONDS: "420",
      URIEL_ANDROID_EMULATOR_PATH: "/opt/android/emulator",
      URIEL_ANDROID_SERIAL: "emulator-5556",
      URIEL_CALLBACK_SECRET: "callback-secret",
      URIEL_CALLBACK_TIMEOUT_SECONDS: "90",
      URIEL_ENABLE_ANDROID_QA: "false",
      URIEL_ENABLE_BROWSER_QA: "false",
      URIEL_MAX_CONCURRENT_JOBS: "3",
      URIEL_STATE_DIR: "/tmp/uriel"
    });

    expect(config.allowedRepos).toEqual([
      "uriel-agent/uriel",
      "https://github.com/acme/app"
    ]);
    expect(config.androidBootTimeoutMs).toBe(420_000);
    expect(config.androidEmulatorPath).toBe("/opt/android/emulator");
    expect(config.androidSerial).toBe("emulator-5556");
    expect(config.callbackSecret).toBe("callback-secret");
    expect(config.callbackTimeoutMs).toBe(90_000);
    expect(config.enableAndroidQa).toBe(false);
    expect(config.enableBrowserQa).toBe(false);
    expect(config.maxConcurrentJobs).toBe(3);
  });

  it("parses harness knobs from environment", () => {
    const config = loadConfig({
      URIEL_ADAPTER_HARNESS: "claude-code",
      URIEL_CLAUDE_MODEL: "claude-opus-4-5",
      URIEL_CODEX_EFFORT: "high",
      URIEL_CODEX_MODEL: "gpt-5.6-sol"
    });

    expect(config.harnessAdapter).toBe("claude-code");
    expect(config.claudeModel).toBe("claude-opus-4-5");
    expect(config.codexEffort).toBe("high");
    expect(config.codexModel).toBe("gpt-5.6-sol");
  });

  it("parses the harness timeout with a 45-minute default", () => {
    expect(loadConfig({}).harnessTimeoutMinutes).toBe(45);
    expect(loadConfig({ URIEL_HARNESS_TIMEOUT_MINUTES: "120" }).harnessTimeoutMinutes).toBe(120);
    expect(loadConfig({ URIEL_HARNESS_TIMEOUT_MINUTES: "junk" }).harnessTimeoutMinutes).toBe(45);
    expect(loadConfig({ URIEL_HARNESS_TIMEOUT_MINUTES: "-5" }).harnessTimeoutMinutes).toBe(1);
  });

  it("uses conservative callback and Android boot timeout defaults", () => {
    expect(loadConfig({}).callbackTimeoutMs).toBe(60_000);
    expect(loadConfig({}).androidBootTimeoutMs).toBe(300_000);
    expect(
      loadConfig({ URIEL_CALLBACK_TIMEOUT_SECONDS: "junk" }).callbackTimeoutMs
    ).toBe(60_000);
    expect(
      loadConfig({ URIEL_ANDROID_BOOT_TIMEOUT_SECONDS: "0" })
        .androidBootTimeoutMs
    ).toBe(300_000);
  });
});
