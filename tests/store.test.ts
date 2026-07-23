import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../apps/worker/src/config.ts";
import { LocalJobStore } from "../apps/worker/src/store.ts";
import type { Job } from "../packages/core/src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true })
    )
  );
});

describe("local job store recovery", () => {
  it("marks running jobs failed while preserving terminal jobs", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "uriel-store-test-"));
    temporaryDirectories.push(stateDir);
    const store = new LocalJobStore(
      loadConfig({ URIEL_STATE_DIR: stateDir })
    );
    await store.putJob(createJob("running", "running"));
    await store.putJob(createJob("completed", "completed"));

    const recovered = await store.failRunningJobs("Worker restarted.");

    expect(recovered.map((job) => job.id)).toEqual(["running"]);
    expect((await store.getJob("running"))?.status).toBe("failed");
    expect((await store.getJob("running"))?.events.at(-1)?.message).toBe(
      "Worker restarted."
    );
    expect((await store.getJob("completed"))?.status).toBe("completed");
  });
});

function createJob(id: string, status: Job["status"]): Job {
  return {
    approvals: [],
    artifacts: [],
    branch: `codex/${id}`,
    createdAt: "2026-07-23T00:00:00.000Z",
    events: [],
    id,
    kind: "verify",
    metadata: {},
    profile: "generic",
    prompt: "Verify the app",
    qa: "none",
    repo: "https://github.com/example/app.git",
    source: "api",
    status,
    updatedAt: "2026-07-23T00:00:00.000Z"
  };
}
