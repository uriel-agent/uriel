import type { CheckResult, JobCheck } from "./checks.ts";
import type { Job } from "./types.ts";

export interface JobCallbackPayload {
  artifacts: Array<{
    contentType?: string;
    kind: Job["artifacts"][number]["kind"];
    name: string;
    size?: number;
  }>;
  checks: { requested: JobCheck[]; results: CheckResult[] } | null;
  event: "job.completed" | "job.failed";
  job: Pick<
    Job,
    | "branch"
    | "id"
    | "kind"
    | "metadata"
    | "repo"
    | "source"
    | "status"
    | "issue"
    | "ref"
    | "requestedBy"
  >;
  pullRequest: { url: string } | null;
  summary: string;
}

export function buildJobCallbackPayload(
  job: Job,
  summary: string
): JobCallbackPayload {
  return {
    artifacts: job.artifacts.map((artifact) => ({
      ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
      kind: artifact.kind,
      name: artifact.name,
      ...(artifact.size !== undefined ? { size: artifact.size } : {})
    })),
    checks: job.checks?.length
      ? { requested: job.checks, results: job.checkResults ?? [] }
      : null,
    event: job.status === "completed" ? "job.completed" : "job.failed",
    job: {
      branch: job.branch,
      id: job.id,
      kind: job.kind,
      metadata: job.metadata,
      repo: job.repo,
      source: job.source,
      status: job.status,
      ...(job.ref ? { ref: job.ref } : {}),
      ...(job.issue ? { issue: job.issue } : {}),
      ...(job.requestedBy ? { requestedBy: job.requestedBy } : {})
    },
    pullRequest: job.pullRequestUrl ? { url: job.pullRequestUrl } : null,
    summary
  };
}
