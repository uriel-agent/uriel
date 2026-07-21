# Uriel

Uriel is an open-source, organization-agnostic remote coding and QA framework
for GitHub-hosted Nix projects. It runs as a local-first NixOS worker and
treats `flake.nix`, `direnv`, and repo-local `justfile`s as the source of truth
for how a project builds, tests, and runs.

The point is simple: remote coding agents should understand Nix. Uriel supplies
a reproducible NixOS host, fresh Git worktrees, Nix/direnv-aware command
execution, Android/browser QA capture, local artifacts, and PR creation.
Each job also emits an `evidence.json` manifest for command results, discovered
repo contract data, QA summaries, artifacts, and PR links.

Uriel core does not assume any company, issue tracker, secret manager, hosted
coordination service, or chat platform. Those concerns live behind optional
adapters or outside the worker API.

## Architecture

- `apps/worker`: local HTTP worker daemon for jobs, state, artifacts, and QA.
- `apps/cli`: `urielctl` for submitting and inspecting jobs.
- `packages/core`: shared job schemas, branch naming, profile rule matching,
  adapter contracts, and webhook signature helpers for future integrations.
- `nix/modules`: NixOS and Home Manager modules.

No hosted coordination service is required. The worker stores JSON job state under
`/var/lib/uriel/jobs`, artifacts under `/var/lib/uriel/artifacts`, bare repo
caches under `/var/lib/uriel/repos`, and job worktrees under
`/var/lib/uriel/worktrees`.

## Status

Implemented v1 surfaces:

- `GET /health`
- `GET /jobs`
- `POST /jobs`
- `GET /jobs/:id`
- `GET /jobs/:id/events`
- `GET /jobs/:id/artifacts/:name`
- `POST /jobs/:id/approve/:step-id`
- `POST /jobs/:id/cancel`
- `urielctl submit/status/approve/cancel`, including `submit --kind`, `--ref`,
  `--checks-file`, and `--callback-url`
- checklist verification jobs and signed job-completion webhooks
- `uriel-worker serve/run`
- NixOS module `services.uriel-worker`
- Home Manager module `programs.uriel`

## Quick Start

```bash
nix develop --command pnpm install
nix develop --command pnpm check
```

Run a worker locally:

```bash
export URIEL_WORKER_TOKEN=dev-token
nix run .#uriel-worker -- serve --host 127.0.0.1 --port 8788
```

Submit a job:

```bash
export URIEL_WORKER_URL=http://127.0.0.1:8788
export URIEL_WORKER_TOKEN=dev-token

nix run .#urielctl -- submit \
  --repo https://github.com/acme/mobile-app.git \
  --prompt "Fix the failing mobile registration test" \
  --issue APP-1234 \
  --repo-bootstrap direnv \
  --qa both
```

Submit a checklist verification job against an exact ref:

```json
[
  {
    "id": "home.visible",
    "text": "The home page renders without an error.",
    "context": "Capture a screenshot after the page finishes loading."
  }
]
```

```bash
nix run .#urielctl -- submit \
  --repo https://github.com/example/application.git \
  --prompt "Verify the release candidate" \
  --kind verify \
  --ref 0123456789abcdef0123456789abcdef01234567 \
  --checks-file checks.json \
  --callback-url https://consumer.example/hooks/uriel
```

Verify jobs create a worktree at the requested ref, run the harness and QA,
collect per-check verdicts and evidence, and do not push a branch or open a
pull request. `urielctl status <job-id>` prints stored check results after the
job JSON. For each check, the harness captures a before screenshot, a short
during recording, and an after screenshot; static-state checks need only a
screenshot.

## Completion Webhooks

When a job has `callbackUrl`, the worker sends the callback after writing the
final evidence manifest. Completed jobs use `job.completed`; failed jobs use
`job.failed`. Requests include:

- `content-type: application/json`
- `x-uriel-event: job.completed` or `job.failed`
- `x-uriel-job-id: <job-id>`
- `x-uriel-signature: sha256=<hex HMAC>` when
  `URIEL_CALLBACK_SECRET` is configured

The signature is an HMAC-SHA256 over the exact JSON request body. Consumers
should compute the HMAC with the shared secret and compare it in constant
time. The payload has this shape:

```json
{
  "event": "job.completed",
  "job": {
    "id": "job_123",
    "kind": "verify",
    "repo": "https://github.com/example/application.git",
    "branch": "codex/verify-release",
    "source": "api",
    "status": "completed",
    "ref": "0123456789abcdef0123456789abcdef01234567",
    "metadata": {}
  },
  "summary": "Job completed.",
  "checks": {
    "requested": [{ "id": "home.visible", "text": "The home page renders without an error." }],
    "results": [{ "id": "home.visible", "verdict": "pass", "artifacts": ["home.png"] }]
  },
  "artifacts": [{ "name": "home.png", "kind": "screenshot", "contentType": "image/png", "size": 12345 }],
  "pullRequest": null
}
```

The worker makes three attempts. Each attempt has a 10-second timeout; retries
wait 5 seconds and then 30 seconds. Callback failures are recorded as worker
events and never change the job outcome. Without `URIEL_CALLBACK_SECRET`, the
worker emits one warning and sends the callback without a signature.

## NixOS Worker

The worker is designed for a generic x86_64 NixOS host with KVM enabled.
The worker boots its configured AVD only where hardware virtualization is
available (`/dev/kvm` on Linux, or macOS); otherwise Android QA runs against
an already-attached device and is skipped with a diagnostic when none is
attached.

```nix
{
  inputs.uriel.url = "github:uriel-agent/uriel";

  outputs = { self, nixpkgs, uriel, ... }: {
    nixosConfigurations.worker = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        uriel.nixosModules.uriel-worker
        ./hardware-configuration.nix
        {
          services.uriel-worker = {
            enable = true;
            environmentFiles = [ "/run/secrets/uriel-worker.env" ];
          };
        }
      ];
    };
  };
}
```

## Secrets

Uriel does not manage secrets. The NixOS host supplies environment variables to
the worker through systemd environment files, typically generated by
`sops-nix`, `agenix`, or another host-managed secret mechanism.

Common variables:

- `URIEL_WORKER_TOKEN`
- `URIEL_CALLBACK_SECRET`
- `URIEL_ALLOWED_REPOS`
- `GH_TOKEN`
- `OPENCODE_MODEL`
- `URIEL_ADAPTER_HARNESS`
- `URIEL_CLAUDE_MODEL`
- `URIEL_CODEX_MODEL`
- `URIEL_CODEX_EFFORT`
- `URIEL_MAX_CONCURRENT_JOBS`
- `URIEL_ENABLE_BROWSER_QA`
- `URIEL_ENABLE_ANDROID_QA`
- `URIEL_ADAPTER_REPO_BOOTSTRAP`
- `URIEL_BROWSER_URL`
- `URIEL_ANDROID_AVD`

The `claude-code` harness authenticates through the environment file: set
`ANTHROPIC_API_KEY`, or a long-lived subscription token minted with
`claude setup-token` (`CLAUDE_CODE_OAUTH_TOKEN`).
`URIEL_CODEX_MODEL` and `URIEL_CODEX_EFFORT` optionally select the model and
reasoning effort used by the `codex` harness.

Optional issue tracker adapters can use generic adapter variables such as
`URIEL_ADAPTER_ISSUE_TRACKER`, `URIEL_ADAPTER_ISSUE_TRACKER_API_KEY`,
`URIEL_ADAPTER_ISSUE_TRACKER_TEAM_KEY`, and
`URIEL_ADAPTER_ISSUE_TRACKER_IN_PROGRESS_STATE`.

The NixOS module exposes matching framework knobs for repo allowlists,
concurrency, artifact retention, QA enablement, extra packages, and environment
files.

## Profiles And Adapters

Uriel core treats `profile` as an opaque string. A profile is an adopter-owned
bundle of adapter choices, not a hardcoded repository identity.

Adapter dimensions:

- Harness: OpenCode (default), Claude Code, or Codex; Hermes can be added as
  an optional harness
- Issue tracker: optional adapter selected by name; no default
- Repo bootstrap: optional, currently `direnv`
- QA capability: `browser`, `android`, or both
- Artifact storage: local worker filesystem by default
- Ingress/orchestration: local HTTP by default; Hermes or bots can sit outside
  Uriel core

See [Adapter Contracts](docs/adapters.md) for the provider-neutral interfaces.
See [Repo Contract And Evidence](docs/repo-contract.md) for the Nix-first
discovery and evidence manifest format.
## License

Apache-2.0.
