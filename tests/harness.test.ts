import { describe, expect, it } from "vitest";

import { buildHarnessInvocation, isHarnessId } from "../packages/core/src/index.ts";

describe("harness invocations", () => {
  const request = {
    branch: "codex/fix-tests",
    prompt: "Fix the failing tests",
    worktree: "/var/lib/uriel/worktrees/job-fix-tests"
  };

  it("builds the opencode invocation", () => {
    expect(buildHarnessInvocation("opencode", request)).toEqual({
      args: [
        "run",
        "--format",
        "json",
        "--title",
        "codex/fix-tests",
        "--dir",
        "/var/lib/uriel/worktrees/job-fix-tests",
        "Fix the failing tests"
      ],
      command: "opencode",
      transcriptArtifact: "opencode-transcript.jsonl"
    });
  });

  it("passes the model to opencode when configured", () => {
    expect(
      buildHarnessInvocation("opencode", { ...request, model: "openai/gpt-5" })
    ).toEqual({
      args: [
        "run",
        "--format",
        "json",
        "--title",
        "codex/fix-tests",
        "--dir",
        "/var/lib/uriel/worktrees/job-fix-tests",
        "--model",
        "openai/gpt-5",
        "Fix the failing tests"
      ],
      command: "opencode",
      transcriptArtifact: "opencode-transcript.jsonl"
    });
  });

  it("builds the claude-code invocation", () => {
    expect(buildHarnessInvocation("claude-code", request)).toEqual({
      args: [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "Fix the failing tests"
      ],
      command: "claude",
      transcriptArtifact: "claude-code-transcript.jsonl"
    });
  });

  it("passes the model to claude-code when configured", () => {
    expect(
      buildHarnessInvocation("claude-code", { ...request, model: "claude-opus-4-5" })
    ).toEqual({
      args: [
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--model",
        "claude-opus-4-5",
        "Fix the failing tests"
      ],
      command: "claude",
      transcriptArtifact: "claude-code-transcript.jsonl"
    });
  });

  it("builds the codex invocation with model and effort", () => {
    expect(
      buildHarnessInvocation("codex", {
        ...request,
        effort: "high",
        model: "gpt-5.6-sol"
      })
    ).toEqual({
      args: [
        "exec",
        "--yolo",
        "-m",
        "gpt-5.6-sol",
        "-c",
        'model_reasoning_effort="high"',
        "Fix the failing tests"
      ],
      command: "codex",
      transcriptArtifact: "codex-transcript.jsonl"
    });
  });

  it("omits the codex effort flag when effort is not configured", () => {
    const invocation = buildHarnessInvocation("codex", request);

    expect(invocation.args).toEqual([
      "exec",
      "--yolo",
      "Fix the failing tests"
    ]);
    expect(invocation.args).not.toContain("-c");
  });

  it("accepts known harness ids and rejects unknown ones", () => {
    expect(isHarnessId("claude-code")).toBe(true);
    expect(isHarnessId("codex")).toBe(true);
    expect(isHarnessId("opencode")).toBe(true);
    expect(isHarnessId("unknown")).toBe(false);
  });
});
