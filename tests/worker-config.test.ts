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
      URIEL_ANDROID_ADB_PATH: "/opt/android/platform-tools/adb",
      URIEL_ANDROID_AVD_PREFIX: "worker_",
      URIEL_ANDROID_AVDS: "worker_1, worker_2,worker_1",
      URIEL_ANDROID_APK_FINGERPRINT: "A".repeat(40),
      URIEL_ANDROID_APK_SHA256: "a".repeat(64),
      URIEL_ANDROID_APK_URL: "https://example.test/app.apk",
      URIEL_ANDROID_APP_PACKAGE: "com.example.qa",
      URIEL_ANDROID_COMPAT_FILE: "config/android-compat.json",
      URIEL_ANDROID_BOOT_TIMEOUT_SECONDS: "420",
      URIEL_ANDROID_EMULATOR_PATH: "/opt/android/emulator/emulator",
      URIEL_ARTIFACT_RETENTION_DAYS: "5",
      URIEL_CAPACITY_ENFORCE_SWAP: "true",
      URIEL_CAPACITY_MAX_SWAP_USED_MB: "8192",
      URIEL_CAPACITY_MIN_FREE_DISK_MB: "10240",
      URIEL_CAPACITY_MIN_FREE_MEMORY_MB: "3072",
      URIEL_CAPACITY_RETRY_SECONDS: "9",
      URIEL_CLEANUP_GRACE_SECONDS: "3",
      URIEL_DEVICE_IDLE_TTL_SECONDS: "120",
      URIEL_LEDGER_RETENTION_DAYS: "14",
      URIEL_MAX_CONCURRENT_JOBS: "3",
      URIEL_MAX_HEAVY_JOBS: "3",
      URIEL_MAX_JOB_EVENTS: "250",
      URIEL_READINESS_HISTORY_MAX_GAP_SECONDS: "120",
      URIEL_READINESS_HISTORY_MAX_SAMPLES: "30000",
      URIEL_READINESS_HISTORY_RETENTION_DAYS: "10",
      URIEL_SMOKE_HISTORY_LIMIT: "25",
      URIEL_WATCHDOG_COOLDOWN_SECONDS: "600",
      URIEL_WATCHDOG_FAILURE_THRESHOLD: "4",
      URIEL_WATCHDOG_INTERVAL_SECONDS: "45",
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
    expect(config.androidAdbPath).toBe("/opt/android/platform-tools/adb");
    expect(config.androidAvdPrefix).toBe("worker_");
    expect(config.androidAvds).toEqual(["worker_1", "worker_2", "worker_1"]);
    expect(config.androidAvd).toBe("worker_1");
    expect(config.androidApkFingerprint).toBe("a".repeat(40));
    expect(config.androidApkSha256).toBe("a".repeat(64));
    expect(config.androidApkUrl).toBe("https://example.test/app.apk");
    expect(config.androidAppPackage).toBe("com.example.qa");
    expect(config.androidCompatFile).toBe("config/android-compat.json");
    expect(config.androidBootTimeoutSeconds).toBe(420);
    expect(config.androidEmulatorPath).toBe("/opt/android/emulator/emulator");
    expect(config.artifactRetentionDays).toBe(5);
    expect(config.capacityEnforceSwap).toBe(true);
    expect(config.capacityMaxSwapUsedMb).toBe(8192);
    expect(config.capacityMinFreeDiskMb).toBe(10240);
    expect(config.capacityMinFreeMemoryMb).toBe(3072);
    expect(config.capacityRetrySeconds).toBe(9);
    expect(config.cleanupGraceSeconds).toBe(3);
    expect(config.deviceIdleTtlSeconds).toBe(120);
    expect(config.ledgerRetentionDays).toBe(14);
    expect(config.maxConcurrentJobs).toBe(3);
    expect(config.maxHeavyJobs).toBe(2);
    expect(config.maxJobEvents).toBe(250);
    expect(config.readinessHistoryMaxGapSeconds).toBe(120);
    expect(config.readinessHistoryMaxSamples).toBe(30_000);
    expect(config.readinessHistoryRetentionDays).toBe(10);
    expect(config.smokeHistoryLimit).toBe(25);
    expect(config.watchdogCooldownSeconds).toBe(600);
    expect(config.watchdogFailureThreshold).toBe(4);
    expect(config.watchdogIntervalSeconds).toBe(45);
  });

  it("defaults swap enforcement by platform and accepts an explicit override", () => {
    expect(loadConfig({}).capacityEnforceSwap).toBe(process.platform !== "darwin");
    expect(loadConfig({ URIEL_CAPACITY_ENFORCE_SWAP: "true" }).capacityEnforceSwap).toBe(true);
    expect(loadConfig({ URIEL_CAPACITY_ENFORCE_SWAP: "false" }).capacityEnforceSwap).toBe(false);
    expect(loadConfig({ URIEL_CAPACITY_ENFORCE_SWAP: "0" }).capacityEnforceSwap).toBe(false);
  });

  it("sizes readiness history for seven days of watchdog probes by default", () => {
    const config = loadConfig({ URIEL_WATCHDOG_INTERVAL_SECONDS: "20" });

    expect(config.readinessHistoryMaxGapSeconds).toBe(60);
    expect(config.readinessHistoryMaxSamples).toBe(25_000);
    expect(config.readinessHistoryRetentionDays).toBe(7);
  });

  it("clamps heavy concurrency to total jobs and dedicated Android slots", () => {
    expect(loadConfig({
      URIEL_ANDROID_AVDS: "uriel_1,uriel_2",
      URIEL_MAX_CONCURRENT_JOBS: "5",
      URIEL_MAX_HEAVY_JOBS: "4"
    }).maxHeavyJobs).toBe(2);
    expect(loadConfig({
      URIEL_ANDROID_AVDS: "uriel_1,uriel_2",
      URIEL_MAX_CONCURRENT_JOBS: "1",
      URIEL_MAX_HEAVY_JOBS: "4"
    }).maxHeavyJobs).toBe(1);
  });

  it("keeps the single Android AVD as a backwards-compatible slot", () => {
    const config = loadConfig({ URIEL_ANDROID_AVD: "uriel_legacy" });

    expect(config.androidAvd).toBe("uriel_legacy");
    expect(config.androidAvdPrefix).toBe("uriel_");
    expect(config.androidAvds).toEqual(["uriel_legacy"]);
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
