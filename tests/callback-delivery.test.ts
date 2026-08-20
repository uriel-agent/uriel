import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../apps/worker/src/config.ts";
import { JobReporter } from "../apps/worker/src/reporter.ts";
import {
  replayUndeliveredJobCallbacks,
  sendJobCallback
} from "../apps/worker/src/runner.ts";
import { LocalJobStore } from "../apps/worker/src/store.ts";
import { createId, type Job } from "../packages/core/src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true })
    )
  );
});

describe("durable job callback delivery", () => {
  it("replays an exhausted callback on boot and marks it delivered after a 2xx", async () => {
    const { config, store } = await createStore();
    const job = terminalJob();
    await store.putJob(job);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendJobCallback(
      job,
      config,
      new JobReporter({ jobId: job.id, store }),
      "Harness found a regression.",
      { retryDelaysMs: [0, 0, 0] }
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((await store.getJob(job.id))?.callbackDeliveredAt).toBeUndefined();
    expect((await store.getJob(job.id))?.callbackSummary).toBe(
      "Harness found a regression."
    );

    await replayUndeliveredJobCallbacks(config, store);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect((await store.getJob(job.id))?.callbackDeliveredAt).toEqual(
      expect.any(String)
    );
    const replayedPayload = JSON.parse(
      String((fetchMock.mock.calls[3]?.[1] as RequestInit | undefined)?.body)
    ) as { summary: string };
    expect(replayedPayload.summary).toBe("Harness found a regression.");
  });

  it("does not replay a job whose callback was already delivered", async () => {
    const { config, store } = await createStore();
    const job = terminalJob({
      callbackDeliveredAt: "2026-08-20T12:00:00.000Z",
      callbackSummary: "Already delivered."
    });
    await store.putJob(job);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await replayUndeliveredJobCallbacks(config, store);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

async function createStore() {
  const stateDir = await mkdtemp(join(tmpdir(), "uriel-callback-delivery-"));
  temporaryDirectories.push(stateDir);
  const config = loadConfig({
    URIEL_CALLBACK_TIMEOUT_SECONDS: "1",
    URIEL_STATE_DIR: stateDir
  });
  const store = new LocalJobStore(config);
  await store.init();
  return { config, store };
}

function terminalJob(overrides: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    approvals: [],
    artifacts: [],
    branch: "codex/callback-delivery",
    callbackUrl: "https://callbacks.example.test/uriel",
    createdAt: now,
    events: [],
    id: createId("job"),
    kind: "verify",
    metadata: {},
    profile: "generic",
    prompt: "Verify the app.",
    qa: "none",
    repo: "https://github.com/example/app",
    source: "api",
    status: "failed",
    updatedAt: now,
    ...overrides
  };
}
