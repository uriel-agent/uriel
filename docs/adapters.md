# Adapter Contracts

Uriel core exposes provider-neutral adapter contracts in `packages/core`.
Provider-specific behavior should live behind one of these contracts instead
of being wired directly into the worker lifecycle.

## Adapter Kinds

- `harness`: runs the coding agent, such as OpenCode, Claude Code, or Hermes.
- `issueTracker`: finds, creates, or updates external issue records.
- `repoBootstrap`: prepares a fresh worktree, such as `direnv allow`.
- `qa`: captures browser, Android, or other verification evidence.
- `artifactStore`: stores logs, traces, screenshots, videos, and transcripts.
- `notifier`: posts job updates to chat, issue trackers, or other systems.

## Registry

Adapters register by `(kind, id)`.

```ts
import { AdapterRegistry } from "@uriel/core";

const registry = new AdapterRegistry();
registry.register({
  id: "direnv",
  kind: "repoBootstrap",
  async bootstrap(context) {
    await context.emit({
      level: "info",
      message: "Preparing direnv environment.",
      type: "repo"
    });
  }
});
```

Duplicate registrations fail fast. This keeps profile resolution explicit and
prevents two packages from silently claiming the same adapter id.

## Framework Rule

Core may define contracts and generic lifecycle behavior. Provider-specific
code belongs in adapters. The worker can ship built-in adapters for convenience,
but every built-in adapter must remain optional and selected by profile,
metadata, or deployment config.
