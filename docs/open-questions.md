# Open Questions

These are intentionally left out of v1 implementation decisions.

- Whether Hermes should become a first-class harness or remain an optional
  orchestration layer around the worker API.
- Whether to provision first-class NixOS infrastructure modules for providers
  beyond Hetzner. A Hetzner + Tailscale host example now lives under
  `examples/hetzner-tailscale`.
- How much PR evidence should be mirrored into GitHub comments versus kept on
  the worker filesystem.
- Whether Android emulator images should be prebuilt into a host image or
  managed through a worker bootstrap command.
- What adapter registry format should be used for larger organizations:
  environment variables, checked-in profile files, a local SQLite registry, or
  all three.
