import { describe, expect, it } from "vitest";

import { buildJobCallbackPayload, type Job } from "../packages/core/src/index.ts";

function createJob(overrides: Partial<Job> = {}): Job {
  return {
    approvals: [],
    artifacts: [
      {
        contentType: "image/png",
        createdAt: "2026-07-16T00:00:00.000Z",
        kind: "screenshot",
        name: "screen.png",
        size: 123,
        url: "/private/artifacts/screen.png"
      }
    ],
    branch: "codex/verify-login",
    createdAt: "2026-07-16T00:00:00.000Z",
    events: [],
    id: "job_123",
    kind: "verify",
    metadata: {},
    profile: "generic",
    prompt: "Verify login",
    qa: "browser",
    repo: "https://github.com/example/app.git",
    source: "api",
    status: "completed",
    updatedAt: "2026-07-16T00:01:00.000Z",
    ...overrides
  };
}

describe("job callback payload", () => {
  it("excludes local artifact URLs", () => {
    const payload = buildJobCallbackPayload(createJob(), "Done");
    expect(payload.artifacts[0]).toEqual({
      contentType: "image/png",
      kind: "screenshot",
      name: "screen.png",
      size: 123
    });
    expect(payload.artifacts[0]).not.toHaveProperty("url");
  });

  it("uses null checks when no checks were requested", () => {
    expect(buildJobCallbackPayload(createJob(), "Done").checks).toBeNull();
  });

  it("preserves structured per-check evidence in callbacks", () => {
    const payload = buildJobCallbackPayload(
      createJob({
        checks: [{ id: "home.visible", text: "The home screen is visible." }],
        checkResults: [
          {
            artifacts: ["screen.png"],
            evidence: [
              {
                artifact: "screen.png",
                description: "The home screen is visible after launch.",
                role: "outcome"
              }
            ],
            id: "home.visible",
            verdict: "pass"
          }
        ]
      }),
      "Done"
    );

    expect(payload.checks?.results[0]?.evidence).toEqual([
      {
        artifact: "screen.png",
        description: "The home screen is visible after launch.",
        role: "outcome"
      }
    ]);
  });

  it("maps completed and failed events", () => {
    expect(buildJobCallbackPayload(createJob(), "Done").event).toBe("job.completed");
    expect(
      buildJobCallbackPayload(createJob({ status: "failed" }), "Failed").event
    ).toBe("job.failed");
  });
});
