import { describe, expect, it } from "vitest";

import {
  createEvidenceManifest,
  createRepoContract,
  parseJustRecipes,
  type Job
} from "../packages/core/src/index.ts";

describe("repo contract", () => {
  it("parses recipes from just --list output", () => {
    expect(
      parseJustRecipes(`
Available recipes:
    dev      # Start local development
    qa
    qa-browser target='local'
    test
`)
    ).toEqual(["dev", "qa", "qa-browser", "test"]);
  });

  it("infers Nix-first preferred commands", () => {
    expect(
      createRepoContract({
        hasFlake: true,
        hasJustfile: true,
        justRecipes: ["dev", "qa", "test"]
      }).preferredCommands
    ).toEqual(["nix flake check", "just qa", "just test"]);
  });
});

describe("evidence manifest", () => {
  it("captures stable job, repo, command, and QA fields", () => {
    const job: Job = {
      approvals: [],
      artifacts: [],
      branch: "codex/app-1234-fix-it",
      createdAt: "2026-06-21T00:00:00.000Z",
      events: [],
      id: "job_123",
      issue: "APP-1234",
      kind: "change",
      metadata: {},
      profile: "generic",
      prompt: "Fix it",
      qa: "browser",
      repo: "https://github.com/acme/app.git",
      source: "acme/chatops",
      status: "completed",
      updatedAt: "2026-06-21T00:01:00.000Z"
    };

    const manifest = createEvidenceManifest({
      commands: [
        {
          args: ["flake", "show"],
          command: "nix",
          exitCode: 0
        }
      ],
      job,
      qaSummaries: ["Browser QA completed."],
      repoContract: createRepoContract({ hasFlake: true })
    });

    expect(manifest.schemaVersion).toBe("1");
    expect(manifest.job.source).toBe("acme/chatops");
    expect(manifest.repoContract.preferredCommands).toEqual(["nix flake check"]);
    expect(manifest.commands[0]?.command).toBe("nix");
    expect(manifest.qa.summaries).toEqual(["Browser QA completed."]);
  });

  it("includes requested checks and results when the job has checks", () => {
    const requested = [{ id: "home.visible", text: "The home page is visible." }];
    const results = [{ id: "home.visible", verdict: "pass" as const }];
    const job: Job = {
      approvals: [],
      artifacts: [],
      branch: "codex/verify-home",
      checks: requested,
      createdAt: "2026-07-16T00:00:00.000Z",
      events: [],
      id: "job_verify",
      kind: "verify",
      metadata: {},
      profile: "generic",
      prompt: "Verify home",
      qa: "browser",
      repo: "https://github.com/example/app.git",
      source: "api",
      status: "completed",
      updatedAt: "2026-07-16T00:01:00.000Z"
    };
    const manifest = createEvidenceManifest({
      checks: { requested, results },
      job,
      repoContract: createRepoContract()
    });
    expect(manifest.checks).toEqual({ requested, results });
  });
});
