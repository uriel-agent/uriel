# Hetzner + Tailscale Host

A complete host flake for a Hetzner machine running the Uriel worker with the
Claude Code harness. Nothing listens on the public interface; SSH and the
worker API are reachable over the tailnet only. Works on a cloud VPS (browser
QA and agent jobs) or an auction/dedicated bare-metal server, which adds
Android-emulator QA — Hetzner Cloud has no KVM on any tier, so Android QA
requires bare metal.

## 1. Prepare

Edit before deploying:

- `configuration.nix`: replace the root SSH key and the `allowedRepos`
  allowlist.
- `disko.nix`: set the disk device. Cloud VPS = `/dev/sda`, auction/dedicated
  NVMe = `/dev/nvme0n1`.

After first boot, create the two secret files on the target:

```bash
# Tailscale pre-auth key.
echo 'tskey-auth-...' > /run/secrets/tailscale-authkey

cat > /run/secrets/uriel-worker.env <<'EOF'
URIEL_WORKER_TOKEN=...
GH_TOKEN=...
# Or CLAUDE_CODE_OAUTH_TOKEN=... minted with `claude setup-token`.
ANTHROPIC_API_KEY=...
EOF
```

Production setups should manage these with `sops-nix` or `agenix` per
[NixOS Secrets](../../docs/nixos-secrets.md); static files keep this example
dependency-light. `/run` is a tmpfs, so recreate the files after a reboot or
switch to a secret manager.

## 2. Deploy

From a working machine, with the server booted into the NixOS installer ISO or
Hetzner rescue system (cloud VPS and dedicated servers alike):

```bash
nix run github:nix-community/nixos-anywhere -- \
  --flake .#uriel-box \
  --generate-hardware-config nixos-generate-config ./hardware-configuration.nix \
  --target-host root@<server-ip>
```

The kexec phase needs at least 1 GB of RAM on the target.

## 3. Submit Jobs

From any machine on the tailnet:

```bash
URIEL_WORKER_URL=http://uriel-box:8788 URIEL_WORKER_TOKEN=... \
  nix run github:uriel-agent/uriel#urielctl -- submit \
  --repo https://github.com/acme/app.git \
  --prompt "Fix the failing registration test" \
  --harness claude-code \
  --qa browser
```

## 4. Interactive Sessions

The worker handles fire-and-forget jobs. To steer a live Claude Code session
from the Claude mobile app, run `claude remote-control` on the box in tmux
under a regular user. It needs a full `claude /login` (claude.ai OAuth; the
inference-only `claude setup-token` credential works for the worker harness
but not for Remote Control) and outbound HTTPS only.

## 5. Update

```bash
nixos-rebuild switch --flake .#uriel-box --target-host root@uriel-box
```
