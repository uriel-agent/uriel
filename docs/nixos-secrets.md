# NixOS Secrets

Uriel does not manage runtime secrets itself. The worker is a systemd service,
so NixOS should provide secret material before the service starts.

The recommended interface is an environment file:

```bash
URIEL_WORKER_TOKEN=...
URIEL_CALLBACK_SECRET=...
GH_TOKEN=...
OPENCODE_MODEL=...
```

Adapter-specific credentials can live in the same file, but they are not part
of the core worker contract.

Then wire it into the module:

```nix
{
  services.uriel-worker = {
    enable = true;
    environmentFiles = [
      "/run/secrets/uriel-worker.env"
    ];
  };
}
```

## sops-nix

With `sops-nix`, keep encrypted secrets in your infra repo and expose a
runtime file:

```nix
{
  sops.secrets.uriel-worker-env = {
    owner = "uriel";
    group = "uriel";
    mode = "0400";
    sopsFile = ./secrets/uriel-worker.env;
    format = "dotenv";
  };

  services.uriel-worker.environmentFiles = [
    config.sops.secrets.uriel-worker-env.path
  ];
}
```

## agenix

With `agenix`, decrypt an environment file into `/run/agenix` and pass the
resulting path to Uriel:

```nix
{
  age.secrets.uriel-worker-env = {
    file = ./secrets/uriel-worker-env.age;
    owner = "uriel";
    group = "uriel";
    mode = "0400";
  };

  services.uriel-worker.environmentFiles = [
    config.age.secrets.uriel-worker-env.path
  ];
}
```

## Why This Shape

Secrets stay outside the Nix store, outside the target repository, and outside
Uriel profile logic. Uriel consumes normal environment variables; NixOS decides
how those variables are decrypted, permissioned, rotated, and audited.
