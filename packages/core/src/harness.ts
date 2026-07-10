export const harnessIds = ["claude-code", "opencode"] as const;

export type HarnessId = (typeof harnessIds)[number];

export function isHarnessId(value: string): value is HarnessId {
  return (harnessIds as readonly string[]).includes(value);
}

export interface HarnessInvocation {
  args: string[];
  command: string;
  transcriptArtifact: string;
}

export interface HarnessInvocationRequest {
  branch: string;
  model?: string;
  prompt: string;
  worktree: string;
}

export function buildHarnessInvocation(
  harness: HarnessId,
  request: HarnessInvocationRequest
): HarnessInvocation {
  switch (harness) {
    case "claude-code":
      return {
        args: [
          "--print",
          "--output-format",
          "stream-json",
          "--verbose",
          "--dangerously-skip-permissions",
          ...(request.model ? ["--model", request.model] : []),
          request.prompt
        ],
        command: "claude",
        transcriptArtifact: "claude-code-transcript.jsonl"
      };
    case "opencode":
      return {
        args: [
          "run",
          "--format",
          "json",
          "--title",
          request.branch,
          "--dir",
          request.worktree,
          ...(request.model ? ["--model", request.model] : []),
          request.prompt
        ],
        command: "opencode",
        transcriptArtifact: "opencode-transcript.jsonl"
      };
    default:
      return unreachable(harness);
  }
}

function unreachable(value: never): never {
  throw new Error(`Unknown harness: ${String(value)}`);
}
