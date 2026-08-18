{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.uriel-smoke;
  smokeScript = pkgs.writeShellScript "uriel-readiness-smoke" ''
    set -eu
    if [ -n "''${URIEL_WORKER_TOKEN:-}" ]; then
      code="$(printf 'header = "Authorization: Bearer %s"\n' "$URIEL_WORKER_TOKEN" \
        | ${pkgs.curl}/bin/curl --config - --silent --show-error --output /dev/null \
            --write-out '%{http_code}' --request POST ${lib.escapeShellArg "${cfg.workerUrl}/smoke"})"
    else
      code="$(${pkgs.curl}/bin/curl --silent --show-error --output /dev/null \
        --write-out '%{http_code}' --request POST ${lib.escapeShellArg "${cfg.workerUrl}/smoke"})"
    fi
    case "$code" in
      202|409) exit 0 ;;
      *) echo "Uriel smoke request returned HTTP $code" >&2; exit 1 ;;
    esac
  '';
in
{
  options.services.uriel-smoke = {
    enable = lib.mkEnableOption "scheduled Uriel cold-boot readiness smoke";

    workerUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:8788";
      description = "Base URL of the local Uriel worker.";
    };

    interval = lib.mkOption {
      type = lib.types.str;
      default = "6h";
      description = "systemd OnUnitActiveSec interval for readiness smoke requests.";
    };

    randomizedDelay = lib.mkOption {
      type = lib.types.str;
      default = "15m";
      description = "Randomized delay that avoids synchronized smoke load.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "Optional environment file containing URIEL_WORKER_TOKEN.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.uriel-readiness-smoke = {
      description = "Request an exclusive Uriel cold-boot readiness smoke";
      after = [ "uriel-worker.service" ];
      requires = [ "uriel-worker.service" ];
      serviceConfig = {
        ExecStart = smokeScript;
        Type = "oneshot";
      }
      // lib.optionalAttrs (cfg.environmentFile != null) {
        EnvironmentFile = cfg.environmentFile;
      };
    };

    systemd.timers.uriel-readiness-smoke = {
      description = "Schedule Uriel cold-boot readiness smoke";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "10m";
        OnUnitActiveSec = cfg.interval;
        RandomizedDelaySec = cfg.randomizedDelay;
        Persistent = true;
      };
    };
  };
}
