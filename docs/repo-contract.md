# Repo Contract And Evidence

Uriel treats repository-provided Nix surfaces as the contract for how to work
inside a project.

## Discovery Order

For every fresh worktree, the worker discovers:

1. `AGENTS.md` instructions.
2. `flake.nix` and `nix flake show --json --no-write-lock-file`.
3. `justfile` or `Justfile` and `just --list`.

The discovered repo contract records:

- whether `AGENTS.md` exists
- whether `flake.nix` exists
- whether a `justfile` exists
- parsed `just` recipes
- preferred commands inferred from those surfaces

## Preferred Commands

The default command preference is Nix-first:

1. `nix flake check`
2. `just qa`
3. `just check`
4. `just test`
5. `just lint`
6. `just qa-browser`
7. `just qa-android`

Future profile adapters may override or extend this list, but the default path
should remain useful for any ordinary Nix flake.

## Evidence Manifest

Every worker job writes an `evidence.json` artifact. It contains:

- job identity, repo URL, branch, profile, source, and status
- discovered repo contract
- command evidence with command, args, cwd, exit code, duration, and output tails
- requested QA mode and QA summaries
- optional `checks` with the requested checklist and per-check results
- artifacts captured before the manifest was written
- draft PR URL when one was created

This manifest is the stable source for future PR comments, chat notifications,
and external artifact publishers.

## Per-Check Evidence Protocol

For each verification check, capture `<check-id>-setup.png` before exercising
the flow, `<check-id>-action.mp4` while exercising it when useful, and
`<check-id>-outcome.png` after it completes. Keep each recording under 60
seconds; a static state needs only a screenshot. Descriptive or numeric
suffixes distinguish materially different observations.

Each result references evidence with an artifact name, a role (`setup`,
`action`, `outcome`, or `diagnostic`), and a concrete description of what the
artifact proves. A pass must retain at least one registered `outcome`
artifact. The worker downgrades a pass without one to `unsure`.

Checks may use only the environment and credentials explicitly provided to the
job. They must not read host credential stores, host tokens, secret-manager
CLIs, or environment files outside the worktree. A check that lacks required
access receives an `unsure` verdict that states what is missing.
