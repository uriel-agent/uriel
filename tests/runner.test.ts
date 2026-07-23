import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../apps/worker/src/config.ts";
import type { JobReporter } from "../apps/worker/src/reporter.ts";
import { sendJobCallback } from "../apps/worker/src/runner.ts";
import type { Job } from "../packages/core/src/index.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("job callbacks", () => {
  it("uses the configured timeout for every callback attempt", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("Missing abort signal."));
              return;
            }
            signals.push(signal);
            signal.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          })
      )
    );
    const reporter = {
      event: vi.fn(async () => undefined),
      getJob: vi.fn(async () => createJob())
    } as unknown as JobReporter;
    const callback = sendJobCallback(
      createJob(),
      loadConfig({ URIEL_CALLBACK_TIMEOUT_SECONDS: "1" }),
      reporter,
      "Done"
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]?.aborted).toBe(true);
    await vi.runAllTimersAsync();
    await callback;

    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

function createJob(): Job {
  return {
    approvals: [],
    artifacts: [],
    branch: "codex/verify-app",
    callbackUrl: "https://example.com/hooks/uriel",
    createdAt: "2026-07-23T00:00:00.000Z",
    events: [],
    id: "job_callback",
    kind: "verify",
    metadata: {},
    profile: "generic",
    prompt: "Verify the app",
    qa: "none",
    repo: "https://github.com/example/app.git",
    source: "api",
    status: "completed",
    updatedAt: "2026-07-23T00:01:00.000Z"
  };
}
