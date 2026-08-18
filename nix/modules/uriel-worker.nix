self:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.uriel-worker;

  opencodeWrapper = pkgs.writeShellScriptBin "opencode" ''
    exec ${pkgs.nodejs_22}/bin/npx --yes opencode-ai "$@"
  '';

  claudeWrapper = pkgs.writeShellScriptBin "claude" ''
    exec ${pkgs.nodejs_22}/bin/npx --yes @anthropic-ai/claude-code "$@"
  '';

  androidSdk = pkgs.androidenv.composeAndroidPackages {
    cmdLineToolsVersion = "11.0";
    platformToolsVersion = "36.0.0";
    buildToolsVersions = [
      "36.0.0"
      "35.0.0"
    ];
    platformVersions = [
      "36"
      "35"
    ];
    includeEmulator = true;
    includeNDK = true;
    ndkVersions = [ "27.1.12297006" ];
  };

  runtimePath =
    with pkgs;
    [
      bash
      coreutils
      curl
      direnv
      ffmpeg
      gh
      git
      git-lfs
      jq
      just
      nix
      nodejs_22
      pnpm
      rsync
      opencodeWrapper
      claudeWrapper
    ]
    ++ lib.optionals cfg.enableAndroidQa [
      android-tools
      androidSdk.androidsdk
    ]
    ++ lib.optionals cfg.enableBrowserQa [ chromium ]
    ++ lib.optionals (pkgs ? maestro) [ pkgs.maestro ]
    ++ cfg.extraPackages;
in
{
  options.services.uriel-worker = {
    enable = lib.mkEnableOption "Uriel NixOS remote coding worker";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.uriel-worker;
      description = "Package providing the uriel-worker executable.";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "uriel";
      description = "System user that runs the worker.";
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "uriel";
      description = "System group that owns worker state.";
    };

    stateDir = lib.mkOption {
      type = lib.types.path;
      default = "/var/lib/uriel";
      description = "Worker state directory.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Worker bind host.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8788;
      description = "Worker bind port.";
    };

    allowedRepos = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "uriel-agent/uriel"
        "https://github.com/acme/app"
      ];
      description = ''
        Optional allowlist for repositories this worker may accept. Entries can
        be GitHub owner/repo slugs or full GitHub repository URLs. An empty list
        allows any GitHub repository URL accepted by the worker API.
      '';
    };

    maxConcurrentJobs = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1;
      description = "Maximum number of jobs the local worker may run at once.";
    };

    maxHeavyJobs = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1;
      description = "Maximum heavy jobs admitted at once, clamped by total jobs and Android slots.";
    };

    capacityMinFreeMemoryMb = lib.mkOption {
      type = lib.types.ints.positive;
      default = 4096;
      description = "Minimum available host memory in MiB required to launch heavy work.";
    };

    capacityMaxSwapUsedMb = lib.mkOption {
      type = lib.types.ints.positive;
      default = 32768;
      description = "Maximum host swap usage in MiB allowed when launching heavy work.";
    };

    capacityMinFreeDiskMb = lib.mkOption {
      type = lib.types.ints.positive;
      default = 20480;
      description = "Minimum free disk space in MiB required to launch heavy work.";
    };

    capacityRetrySeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 15;
      description = "Delay before retrying a job blocked by host resource pressure.";
    };

    callbackTimeoutSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 60;
      description = "Timeout in seconds for each signed completion callback attempt.";
    };

    artifactRetentionDays = lib.mkOption {
      type = lib.types.ints.positive;
      default = 7;
      description = ''
        Cleanup age for local artifacts. Both the worker ownership ledger and
        systemd tmpfiles enforce this bounded retention window.
      '';
    };

    ledgerRetentionDays = lib.mkOption {
      type = lib.types.ints.positive;
      default = 30;
      description = "Retention age for fully released resource journals.";
    };

    maxJobEvents = lib.mkOption {
      type = lib.types.ints.positive;
      default = 500;
      description = "Maximum structured events retained in each job record.";
    };

    cleanupGraceSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 10;
      description = "Grace period between terminating and force-killing an owned process.";
    };

    deviceIdleTtlSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 300;
      description = "Idle time before a released worker-owned Android device is stopped.";
    };

    watchdogIntervalSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 30;
      description = "Interval between internal readiness watchdog probes.";
    };

    watchdogFailureThreshold = lib.mkOption {
      type = lib.types.ints.positive;
      default = 3;
      description = "Consecutive degraded probes required before self-recovery.";
    };

    watchdogCooldownSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 300;
      description = "Minimum delay between bounded watchdog recovery attempts.";
    };

    smokeHistoryLimit = lib.mkOption {
      type = lib.types.ints.positive;
      default = 50;
      description = "Maximum terminal scheduled-smoke job records retained.";
    };

    environmentFiles = lib.mkOption {
      type = lib.types.listOf lib.types.path;
      default = [ ];
      description = ''
        Environment files consumed by systemd before starting the worker.
        Use this with NixOS-native secret tools such as sops-nix or agenix.
        Files should contain KEY=VALUE lines such as URIEL_WORKER_TOKEN=...
        and URIEL_CALLBACK_SECRET=...
      '';
    };

    browserUrl = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional URL for browser QA smoke captures.";
    };

    enableBrowserQa = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to include browser QA tools and allow browser QA jobs.";
    };

    androidAvd = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Deprecated single Android AVD name; use androidAvds for concurrent QA.";
    };

    androidAvds = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        Dedicated worker-owned Android AVD names used as exclusive per-job
        slots. Names must start with androidAvdPrefix. An empty list has no
        Android capacity; physical and implicitly attached devices are never
        selected. androidAvd remains a deprecated single-slot fallback.
      '';
    };

    androidAvdPrefix = lib.mkOption {
      type = lib.types.strMatching "^[A-Za-z][A-Za-z0-9._-]*$";
      default = "uriel_";
      description = ''
        Ownership prefix required on every AVD leased or modified by Uriel.
        Interactive developer pools must use a different prefix.
      '';
    };

    androidBootTimeoutSeconds = lib.mkOption {
      type = lib.types.ints.positive;
      default = 300;
      description = "Maximum time to wait for a cold Android AVD boot.";
    };

    androidApk = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.submodule {
          options = {
            url = lib.mkOption {
              type = lib.types.str;
              description = "HTTP(S) or file URL of the Android QA APK.";
            };
            sha256 = lib.mkOption {
              type = lib.types.strMatching "^[a-f0-9]{64}$";
              description = "Pinned SHA-256 digest of the APK.";
            };
            packageName = lib.mkOption {
              type = lib.types.str;
              description = "Android application package expected after installation.";
            };
          };
        }
      );
      default = null;
      description = ''
        Optional checksum-pinned APK provisioned on each Android slot before
        the coding harness starts.
      '';
    };

    enableAndroidQa = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to include Android QA tools and allow Android QA jobs.";
    };

    extraEnvironment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Additional environment variables for the worker.";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = "Additional packages to add to the worker service PATH.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.${cfg.group} = { };
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      home = cfg.stateDir;
      createHome = true;
      extraGroups = lib.optionals cfg.enableAndroidQa [
        "adbusers"
        "kvm"
        "render"
        "video"
      ];
    };

    programs.adb.enable = cfg.enableAndroidQa;
    users.groups.adbusers = { };
    services.udev.packages = lib.optionals (cfg.enableAndroidQa && pkgs ? android-udev-rules) [
      pkgs.android-udev-rules
    ];

    nix.settings = {
      experimental-features = [
        "nix-command"
        "flakes"
      ];
      trusted-users = [ cfg.user ];
    };

    systemd.tmpfiles.rules = [
      "d ${toString cfg.stateDir} 0750 ${cfg.user} ${cfg.group} - -"
      "d ${toString cfg.stateDir}/repos 0750 ${cfg.user} ${cfg.group} - -"
      "d ${toString cfg.stateDir}/worktrees 0750 ${cfg.user} ${cfg.group} - -"
      "d ${toString cfg.stateDir}/artifacts 0750 ${cfg.user} ${cfg.group} ${toString cfg.artifactRetentionDays}d -"
    ];

    systemd.services.uriel-worker = {
      description = "Uriel remote NixOS coding worker";
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];
      path = runtimePath;
      environment = {
        URIEL_ANDROID_BOOT_TIMEOUT_SECONDS = toString cfg.androidBootTimeoutSeconds;
        URIEL_ANDROID_AVD_PREFIX = cfg.androidAvdPrefix;
        URIEL_ARTIFACT_RETENTION_DAYS = toString cfg.artifactRetentionDays;
        URIEL_ENABLE_ANDROID_QA = if cfg.enableAndroidQa then "true" else "false";
        URIEL_ENABLE_BROWSER_QA = if cfg.enableBrowserQa then "true" else "false";
        URIEL_CAPACITY_MAX_SWAP_USED_MB = toString cfg.capacityMaxSwapUsedMb;
        URIEL_CAPACITY_MIN_FREE_DISK_MB = toString cfg.capacityMinFreeDiskMb;
        URIEL_CAPACITY_MIN_FREE_MEMORY_MB = toString cfg.capacityMinFreeMemoryMb;
        URIEL_CAPACITY_RETRY_SECONDS = toString cfg.capacityRetrySeconds;
        URIEL_CLEANUP_GRACE_SECONDS = toString cfg.cleanupGraceSeconds;
        URIEL_DEVICE_IDLE_TTL_SECONDS = toString cfg.deviceIdleTtlSeconds;
        URIEL_LEDGER_RETENTION_DAYS = toString cfg.ledgerRetentionDays;
        URIEL_MAX_CONCURRENT_JOBS = toString cfg.maxConcurrentJobs;
        URIEL_MAX_HEAVY_JOBS = toString cfg.maxHeavyJobs;
        URIEL_MAX_JOB_EVENTS = toString cfg.maxJobEvents;
        URIEL_SMOKE_HISTORY_LIMIT = toString cfg.smokeHistoryLimit;
        URIEL_WATCHDOG_COOLDOWN_SECONDS = toString cfg.watchdogCooldownSeconds;
        URIEL_WATCHDOG_FAILURE_THRESHOLD = toString cfg.watchdogFailureThreshold;
        URIEL_WATCHDOG_INTERVAL_SECONDS = toString cfg.watchdogIntervalSeconds;
        URIEL_CALLBACK_TIMEOUT_SECONDS = toString cfg.callbackTimeoutSeconds;
        URIEL_STATE_DIR = toString cfg.stateDir;
        URIEL_WORKER_HOST = cfg.host;
        URIEL_WORKER_PORT = toString cfg.port;
      }
      // lib.optionalAttrs cfg.enableAndroidQa {
        ANDROID_HOME = "${androidSdk.androidsdk}/libexec/android-sdk";
        ANDROID_SDK_ROOT = "${androidSdk.androidsdk}/libexec/android-sdk";
      }
      // lib.optionalAttrs (cfg.allowedRepos != [ ]) {
        URIEL_ALLOWED_REPOS = lib.concatStringsSep "," cfg.allowedRepos;
      }
      // lib.optionalAttrs (cfg.browserUrl != null) {
        URIEL_BROWSER_URL = cfg.browserUrl;
      }
      // lib.optionalAttrs (cfg.androidAvd != null) {
        URIEL_ANDROID_AVD = cfg.androidAvd;
      }
      // lib.optionalAttrs (cfg.androidAvds != [ ]) {
        URIEL_ANDROID_AVDS = lib.concatStringsSep "," cfg.androidAvds;
      }
      // lib.optionalAttrs (cfg.androidApk != null) {
        URIEL_ANDROID_APK_URL = cfg.androidApk.url;
        URIEL_ANDROID_APK_SHA256 = cfg.androidApk.sha256;
        URIEL_ANDROID_APP_PACKAGE = cfg.androidApk.packageName;
      }
      // cfg.extraEnvironment;
      serviceConfig = {
        ExecStart = "${cfg.package}/bin/uriel-worker serve --host ${cfg.host} --port ${toString cfg.port}";
        Group = cfg.group;
        Restart = "on-failure";
        RestartSec = "10s";
        StateDirectory = "uriel";
        User = cfg.user;
        WorkingDirectory = cfg.stateDir;
      }
      // lib.optionalAttrs (cfg.environmentFiles != [ ]) {
        EnvironmentFile = cfg.environmentFiles;
      };
    };
  };
}
