export interface WorkerConfig {
  androidAdbPath?: string;
  androidAvd?: string;
  androidAvdPrefix: string;
  androidAvds: string[];
  androidApkUrl?: string;
  androidApkSha256?: string;
  androidAppPackage?: string;
  androidBootTimeoutSeconds: number;
  androidEmulatorPath?: string;
  artifactsDir: string;
  artifactRetentionDays: number;
  allowedRepos: string[];
  browserUrl?: string;
  callbackSecret?: string;
  callbackTimeoutSeconds: number;
  capacityMaxSwapUsedMb: number;
  capacityMinFreeDiskMb: number;
  capacityMinFreeMemoryMb: number;
  capacityRetrySeconds: number;
  cleanupGraceSeconds: number;
  claudeModel?: string;
  codexEffort?: string;
  codexModel?: string;
  dryRun: boolean;
  deviceIdleTtlSeconds: number;
  enableAndroidQa: boolean;
  enableBrowserQa: boolean;
  enableIosQa: boolean;
  harnessTimeoutMinutes: number;
  harnessAdapter?: string;
  host: string;
  issueTrackerAdapter?: string;
  issueTrackerApiKey?: string;
  issueTrackerInProgressState?: string;
  issueTrackerTeamKey?: string;
  iosBootTimeoutSeconds: number;
  iosSimulatorName?: string;
  iosSimulatorUdid?: string;
  iosSimulatorUdids: string[];
  opencodeModel?: string;
  maxConcurrentJobs: number;
  maxHeavyJobs: number;
  maxJobEvents: number;
  port: number;
  repoBootstrapAdapter?: string;
  readinessHistoryMaxGapSeconds: number;
  readinessHistoryMaxSamples: number;
  readinessHistoryRetentionDays: number;
  reposDir: string;
  ledgerRetentionDays: number;
  stateDir: string;
  smokeHistoryLimit: number;
  workerToken?: string;
  watchdogCooldownSeconds: number;
  watchdogFailureThreshold: number;
  watchdogIntervalSeconds: number;
  worktreesDir: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const stateDir = env.URIEL_STATE_DIR ?? "/var/lib/uriel";
  const androidAvds = parseCsv(env.URIEL_ANDROID_AVDS);
  if (androidAvds.length === 0 && env.URIEL_ANDROID_AVD?.trim()) {
    androidAvds.push(env.URIEL_ANDROID_AVD.trim());
  }
  const iosSimulatorUdids = parseCsv(env.URIEL_IOS_SIMULATOR_UDIDS);
  if (iosSimulatorUdids.length === 0 && env.URIEL_IOS_SIMULATOR_UDID?.trim()) {
    iosSimulatorUdids.push(env.URIEL_IOS_SIMULATOR_UDID.trim());
  }
  const maxConcurrentJobs = positiveInteger(env.URIEL_MAX_CONCURRENT_JOBS, 1);
  const requestedMaxHeavyJobs = positiveInteger(env.URIEL_MAX_HEAVY_JOBS, 1);
  const watchdogIntervalSeconds = positiveInteger(env.URIEL_WATCHDOG_INTERVAL_SECONDS, 30);
  const androidSlotCap = new Set(androidAvds).size || 1;
  return {
    androidAdbPath: env.URIEL_ANDROID_ADB_PATH?.trim() || undefined,
    androidAvd: androidAvds[0],
    androidAvdPrefix: env.URIEL_ANDROID_AVD_PREFIX?.trim() || "uriel_",
    androidAvds,
    androidApkUrl: env.URIEL_ANDROID_APK_URL?.trim() || undefined,
    androidApkSha256: env.URIEL_ANDROID_APK_SHA256?.trim().toLowerCase() || undefined,
    androidAppPackage: env.URIEL_ANDROID_APP_PACKAGE?.trim() || undefined,
    androidBootTimeoutSeconds: Math.max(
      1,
      Number.parseInt(env.URIEL_ANDROID_BOOT_TIMEOUT_SECONDS ?? "300", 10) || 300
    ),
    androidEmulatorPath: env.URIEL_ANDROID_EMULATOR_PATH?.trim() || undefined,
    allowedRepos: parseCsv(env.URIEL_ALLOWED_REPOS),
    artifactsDir: env.URIEL_ARTIFACTS_DIR ?? `${stateDir}/artifacts`,
    artifactRetentionDays: positiveInteger(env.URIEL_ARTIFACT_RETENTION_DAYS, 7),
    browserUrl: env.URIEL_BROWSER_URL,
    callbackSecret: env.URIEL_CALLBACK_SECRET,
    callbackTimeoutSeconds: Math.max(
      1,
      Number.parseInt(env.URIEL_CALLBACK_TIMEOUT_SECONDS ?? "60", 10) || 60
    ),
    capacityMaxSwapUsedMb: positiveInteger(env.URIEL_CAPACITY_MAX_SWAP_USED_MB, 32 * 1024),
    capacityMinFreeDiskMb: positiveInteger(env.URIEL_CAPACITY_MIN_FREE_DISK_MB, 20 * 1024),
    capacityMinFreeMemoryMb: positiveInteger(env.URIEL_CAPACITY_MIN_FREE_MEMORY_MB, 4 * 1024),
    capacityRetrySeconds: positiveInteger(env.URIEL_CAPACITY_RETRY_SECONDS, 15),
    cleanupGraceSeconds: positiveInteger(env.URIEL_CLEANUP_GRACE_SECONDS, 10),
    claudeModel: env.URIEL_CLAUDE_MODEL,
    codexEffort: env.URIEL_CODEX_EFFORT,
    codexModel: env.URIEL_CODEX_MODEL,
    dryRun: env.URIEL_DRY_RUN === "1" || env.URIEL_DRY_RUN === "true",
    deviceIdleTtlSeconds: positiveInteger(env.URIEL_DEVICE_IDLE_TTL_SECONDS, 300),
    enableAndroidQa: env.URIEL_ENABLE_ANDROID_QA !== "false",
    enableBrowserQa: env.URIEL_ENABLE_BROWSER_QA !== "false",
    enableIosQa: env.URIEL_ENABLE_IOS_QA !== "false",
    harnessTimeoutMinutes: Math.max(
      1,
      Number.parseInt(env.URIEL_HARNESS_TIMEOUT_MINUTES ?? "45", 10) || 45
    ),
    harnessAdapter: env.URIEL_ADAPTER_HARNESS,
    host: env.URIEL_WORKER_HOST ?? "127.0.0.1",
    issueTrackerAdapter: env.URIEL_ADAPTER_ISSUE_TRACKER,
    issueTrackerApiKey: env.URIEL_ADAPTER_ISSUE_TRACKER_API_KEY,
    issueTrackerInProgressState: env.URIEL_ADAPTER_ISSUE_TRACKER_IN_PROGRESS_STATE,
    issueTrackerTeamKey: env.URIEL_ADAPTER_ISSUE_TRACKER_TEAM_KEY,
    iosBootTimeoutSeconds: Math.max(
      1,
      Number.parseInt(env.URIEL_IOS_BOOT_TIMEOUT_SECONDS ?? "300", 10) || 300
    ),
    iosSimulatorName: env.URIEL_IOS_SIMULATOR_NAME?.trim() || undefined,
    iosSimulatorUdid: iosSimulatorUdids[0],
    iosSimulatorUdids,
    maxConcurrentJobs,
    maxHeavyJobs: Math.min(requestedMaxHeavyJobs, maxConcurrentJobs, androidSlotCap),
    maxJobEvents: positiveInteger(env.URIEL_MAX_JOB_EVENTS, 500),
    opencodeModel: env.OPENCODE_MODEL,
    port: Number.parseInt(env.URIEL_WORKER_PORT ?? "8788", 10),
    readinessHistoryMaxGapSeconds: positiveInteger(
      env.URIEL_READINESS_HISTORY_MAX_GAP_SECONDS,
      watchdogIntervalSeconds * 3
    ),
    readinessHistoryMaxSamples: positiveInteger(
      env.URIEL_READINESS_HISTORY_MAX_SAMPLES,
      25_000
    ),
    readinessHistoryRetentionDays: positiveInteger(
      env.URIEL_READINESS_HISTORY_RETENTION_DAYS,
      7
    ),
    repoBootstrapAdapter: env.URIEL_ADAPTER_REPO_BOOTSTRAP,
    reposDir: env.URIEL_REPOS_DIR ?? `${stateDir}/repos`,
    ledgerRetentionDays: positiveInteger(env.URIEL_LEDGER_RETENTION_DAYS, 30),
    stateDir,
    smokeHistoryLimit: positiveInteger(env.URIEL_SMOKE_HISTORY_LIMIT, 50),
    workerToken: env.URIEL_WORKER_TOKEN,
    watchdogCooldownSeconds: positiveInteger(env.URIEL_WATCHDOG_COOLDOWN_SECONDS, 300),
    watchdogFailureThreshold: positiveInteger(env.URIEL_WATCHDOG_FAILURE_THRESHOLD, 3),
    watchdogIntervalSeconds,
    worktreesDir: env.URIEL_WORKTREES_DIR ?? `${stateDir}/worktrees`
  };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  return Math.max(1, Number.parseInt(value ?? String(fallback), 10) || fallback);
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
