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

  it("bounds persisted event logs", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "uriel-store-"));
    temporaryDirectories.push(stateDir);
    const store = new LocalJobStore(loadConfig({
      URIEL_MAX_JOB_EVENTS: "2",
      URIEL_STATE_DIR: stateDir
    }));
    const job = jobWithStatus("queued");
    await store.putJob(job);
    const { createJobEvent } = await import("../packages/core/src/index.ts");

    await store.appendEvent(job.id, createJobEvent("worker", "info", "one"));
    await store.appendEvent(job.id, createJobEvent("worker", "info", "two"));
    await store.appendEvent(job.id, createJobEvent("worker", "info", "three"));

    expect((await store.getJob(job.id))?.events.map(({ message }) => message)).toEqual([
      "two",
      "three"
    ]);
  });

  it("does not let concurrent events resurrect a cancelled job", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "uriel-store-"));
    temporaryDirectories.push(stateDir);
    const store = new LocalJobStore(loadConfig({ URIEL_STATE_DIR: stateDir }));
    const job = jobWithStatus("running");
    await store.putJob(job);
    const { createJobEvent } = await import("../packages/core/src/index.ts");

    await Promise.all([
      store.cancelJob(job.id),
      ...Array.from({ length: 25 }, (_, index) =>
        new LocalJobStore(loadConfig({ URIEL_STATE_DIR: stateDir })).appendEvent(
          job.id,
          createJobEvent("worker", "info", `concurrent-${index}`)
        )
      )
    ]);

    const persisted = await store.getJob(job.id);
    expect(persisted?.status).toBe("cancelled");
    expect(persisted?.events).toHaveLength(26);
  });

  it("keeps cancellation terminal when the runner reports later statuses", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "uriel-store-"));
    temporaryDirectories.push(stateDir);
    const store = new LocalJobStore(loadConfig({ URIEL_STATE_DIR: stateDir }));
    const job = jobWithStatus("running");
    await store.putJob(job);

    await store.cancelJob(job.id);
    await store.setStatus(job.id, "running");
    await store.setStatus(job.id, "failed");
    await store.setStatus(job.id, "completed");

    expect((await store.getJob(job.id))?.status).toBe("cancelled");
  });

  it("bounds terminal scheduled-smoke job history", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "uriel-store-"));
    temporaryDirectories.push(stateDir);
    const store = new LocalJobStore(loadConfig({ URIEL_STATE_DIR: stateDir }));
    for (const index of [1, 2, 3]) {
      const job = jobWithStatus("completed");
      job.id = `smoke_${index}`;
      job.source = "watchdog";
      job.createdAt = `2026-08-18T00:00:0${index}.000Z`;
      await store.putJob(job);
    }

    expect(await store.pruneJobs((job) => job.source === "watchdog", 2)).toEqual(["smoke_1"]);
    expect((await store.listJobs()).map(({ id }) => id)).toEqual(["smoke_3", "smoke_2"]);
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
