export interface WorkerConfig {
  androidAvd?: string;
  artifactsDir: string;
  allowedRepos: string[];
  browserUrl?: string;
  claudeModel?: string;
  dryRun: boolean;
  enableAndroidQa: boolean;
  enableBrowserQa: boolean;
  harnessAdapter?: string;
  host: string;
  issueTrackerAdapter?: string;
  issueTrackerApiKey?: string;
  issueTrackerInProgressState?: string;
  issueTrackerTeamKey?: string;
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
  return {
    androidAvd: env.URIEL_ANDROID_AVD,
    allowedRepos: parseCsv(env.URIEL_ALLOWED_REPOS),
    artifactsDir: env.URIEL_ARTIFACTS_DIR ?? `${stateDir}/artifacts`,
    browserUrl: env.URIEL_BROWSER_URL,
    claudeModel: env.URIEL_CLAUDE_MODEL,
    dryRun: env.URIEL_DRY_RUN === "1" || env.URIEL_DRY_RUN === "true",
    enableAndroidQa: env.URIEL_ENABLE_ANDROID_QA !== "false",
    enableBrowserQa: env.URIEL_ENABLE_BROWSER_QA !== "false",
    harnessAdapter: env.URIEL_ADAPTER_HARNESS,
    host: env.URIEL_WORKER_HOST ?? "127.0.0.1",
    issueTrackerAdapter: env.URIEL_ADAPTER_ISSUE_TRACKER,
    issueTrackerApiKey: env.URIEL_ADAPTER_ISSUE_TRACKER_API_KEY,
    issueTrackerInProgressState: env.URIEL_ADAPTER_ISSUE_TRACKER_IN_PROGRESS_STATE,
    issueTrackerTeamKey: env.URIEL_ADAPTER_ISSUE_TRACKER_TEAM_KEY,
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
