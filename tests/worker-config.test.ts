import { describe, expect, it } from "vitest";

import { loadConfig } from "../apps/worker/src/config.ts";

describe("worker config", () => {
  it("parses framework knobs from environment", () => {
    const config = loadConfig({
      URIEL_ALLOWED_REPOS: "uriel-agent/uriel,https://github.com/acme/app",
      URIEL_CALLBACK_SECRET: "callback-secret",
      URIEL_CALLBACK_TIMEOUT_SECONDS: "90",
      URIEL_ENABLE_ANDROID_QA: "false",
      URIEL_ENABLE_BROWSER_QA: "false",
      URIEL_ANDROID_AVDS: "qa-1, qa-2,qa-1",
      URIEL_ANDROID_APK_SHA256: "a".repeat(64),
      URIEL_ANDROID_APK_URL: "https://example.test/app.apk",
      URIEL_ANDROID_APP_PACKAGE: "com.example.qa",
      URIEL_ANDROID_BOOT_TIMEOUT_SECONDS: "420",
      URIEL_MAX_CONCURRENT_JOBS: "3",
      URIEL_STATE_DIR: "/tmp/uriel"
    });

    expect(config.allowedRepos).toEqual([
      "uriel-agent/uriel",
      "https://github.com/acme/app"
    ]);
    expect(config.callbackSecret).toBe("callback-secret");
    expect(config.callbackTimeoutSeconds).toBe(90);
    expect(config.enableAndroidQa).toBe(false);
    expect(config.enableBrowserQa).toBe(false);
    expect(config.androidAvds).toEqual(["qa-1", "qa-2", "qa-1"]);
    expect(config.androidAvd).toBe("qa-1");
    expect(config.androidApkSha256).toBe("a".repeat(64));
    expect(config.androidApkUrl).toBe("https://example.test/app.apk");
    expect(config.androidAppPackage).toBe("com.example.qa");
    expect(config.androidBootTimeoutSeconds).toBe(420);
    expect(config.maxConcurrentJobs).toBe(3);
  });

  it("keeps the single Android AVD as a backwards-compatible slot", () => {
    const config = loadConfig({ URIEL_ANDROID_AVD: "legacy-avd" });

    expect(config.androidAvd).toBe("legacy-avd");
    expect(config.androidAvds).toEqual(["legacy-avd"]);
    expect(config.androidBootTimeoutSeconds).toBe(300);
    expect(config.callbackTimeoutSeconds).toBe(60);
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
});
