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
  allowedRepos: string[];
  browserUrl?: string;
  callbackSecret?: string;
  callbackTimeoutSeconds: number;
  claudeModel?: string;
  codexEffort?: string;
  codexModel?: string;
  dryRun: boolean;
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
  port: number;
  repoBootstrapAdapter?: string;
  reposDir: string;
  stateDir: string;
  workerToken?: string;
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
    browserUrl: env.URIEL_BROWSER_URL,
    callbackSecret: env.URIEL_CALLBACK_SECRET,
    callbackTimeoutSeconds: Math.max(
      1,
      Number.parseInt(env.URIEL_CALLBACK_TIMEOUT_SECONDS ?? "60", 10) || 60
    ),
    claudeModel: env.URIEL_CLAUDE_MODEL,
    codexEffort: env.URIEL_CODEX_EFFORT,
    codexModel: env.URIEL_CODEX_MODEL,
    dryRun: env.URIEL_DRY_RUN === "1" || env.URIEL_DRY_RUN === "true",
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
    maxConcurrentJobs: Math.max(1, Number.parseInt(env.URIEL_MAX_CONCURRENT_JOBS ?? "1", 10) || 1),
    opencodeModel: env.OPENCODE_MODEL,
    port: Number.parseInt(env.URIEL_WORKER_PORT ?? "8788", 10),
    repoBootstrapAdapter: env.URIEL_ADAPTER_REPO_BOOTSTRAP,
    reposDir: env.URIEL_REPOS_DIR ?? `${stateDir}/repos`,
    stateDir,
    workerToken: env.URIEL_WORKER_TOKEN,
    worktreesDir: env.URIEL_WORKTREES_DIR ?? `${stateDir}/worktrees`
  };
}

function parseCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
