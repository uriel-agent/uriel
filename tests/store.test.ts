import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createId, type Job } from "../packages/core/src/index.ts";
import { loadConfig } from "../apps/worker/src/config.ts";
import { LocalJobStore } from "../apps/worker/src/store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    force: true,
    recursive: true
  })));
});

describe("LocalJobStore restart recovery", () => {
  it("marks only running jobs failed and records why", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "uriel-store-"));
    temporaryDirectories.push(stateDir);
    const store = new LocalJobStore(loadConfig({ URIEL_STATE_DIR: stateDir }));
    const running = jobWithStatus("running");
    const queued = jobWithStatus("queued");
    await store.putJob(running);
    await store.putJob(queued);

    const failed = await store.failRunningJobsAfterRestart();

    expect(failed.map((job) => job.id)).toEqual([running.id]);
    expect((await store.getJob(running.id))?.status).toBe("failed");
    expect((await store.getJob(running.id))?.events.at(-1)?.message).toContain(
      "Worker restarted"
    );
    expect((await store.getJob(queued.id))?.status).toBe("queued");
  });
});

function jobWithStatus(status: Job["status"]): Job {
  const now = new Date().toISOString();
  return {
    approvals: [],
    artifacts: [],
    branch: `codex/${status}`,
    createdAt: now,
    events: [],
    id: createId("job"),
    kind: "verify",
    metadata: {},
    profile: "generic",
    prompt: "Verify the app.",
    qa: "android",
    ref: "a".repeat(40),
    repo: "https://github.com/example/app",
    requestedBy: "test",
    source: "api",
    status,
    updatedAt: now
  };
}
