import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../apps/worker/src/config.ts";
import { handleRequest } from "../apps/worker/src/main.ts";
import { LocalJobStore } from "../apps/worker/src/store.ts";
import { createId, type Job } from "../packages/core/src/index.ts";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { force: true, recursive: true })
    )
  );
});

describe("POST /jobs/:id/approve/:stepId", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "rejects approval of a %s job without changing its record",
    async (status) => {
      const { baseUrl, store } = await startWorker();
      const job = jobWithStatus(status);
      job.approvals = [pendingApproval()];
      await store.putJob(job);
      const before = await store.getJob(job.id);

      const response = await fetch(`${baseUrl}/jobs/${job.id}/approve/deploy`, {
        method: "POST"
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: `Cannot approve a step on job with status "${status}".`
      });
      expect(await store.getJob(job.id)).toEqual(before);
    }
  );

  it("rejects an unknown approval without queuing the job", async () => {
    const { baseUrl, store } = await startWorker();
    const job = jobWithStatus("waiting_approval");
    job.approvals = [pendingApproval()];
    await store.putJob(job);
    const before = await store.getJob(job.id);

    const response = await fetch(`${baseUrl}/jobs/${job.id}/approve/unknown`, {
      method: "POST"
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Pending approval unknown not found."
    });
    expect(await store.getJob(job.id)).toEqual(before);
  });

  it("queues a legitimate pending approval through the guarded transition", async () => {
    const { baseUrl, store } = await startWorker();
    const job = jobWithStatus("waiting_approval");
    job.approvals = [pendingApproval()];
    await store.putJob(job);

    const response = await fetch(`${baseUrl}/jobs/${job.id}/approve/deploy`, {
      method: "POST"
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as Job).toMatchObject({
      approvals: [],
      id: job.id,
      status: "queued"
    });
    const persisted = await store.getJob(job.id);
    expect(persisted?.events.slice(-2).map(({ message }) => message)).toEqual([
      "Status changed to queued.",
      "Approved step deploy."
    ]);
  });
});

async function startWorker(): Promise<{
  baseUrl: string;
  store: LocalJobStore;
}> {
  const stateDir = await mkdtemp(join(tmpdir(), "uriel-worker-approve-"));
  temporaryDirectories.push(stateDir);
  const config = loadConfig({ URIEL_STATE_DIR: stateDir });
  const store = new LocalJobStore(config);
  await store.init();
  const server = createServer((request, response) => {
    void handleRequest(request, response, config);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Worker test server did not bind to a TCP port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    store
  };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function pendingApproval() {
  return {
    createdAt: new Date().toISOString(),
    description: "Continue deployment",
    stepId: "deploy"
  };
}

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
    qa: "none",
    repo: "https://github.com/example/app",
    source: "api",
    status,
    updatedAt: now
  };
}
