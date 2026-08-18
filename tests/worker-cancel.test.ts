import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleRequest } from "../apps/worker/src/main.ts";
import { loadConfig } from "../apps/worker/src/config.ts";
import { LocalJobStore } from "../apps/worker/src/store.ts";
import { createId, type Job } from "../packages/core/src/index.ts";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, {
        force: true,
        recursive: true
      })
    )
  );
});

describe("POST /jobs/:id/cancel", () => {
  it.each(["queued", "running"] as const)(
    "cancels a %s job",
    async (status) => {
      const { baseUrl, store } = await startWorker();
      const job = jobWithStatus(status);
      await store.putJob(job);

      const response = await fetch(`${baseUrl}/jobs/${job.id}/cancel`, {
        method: "POST"
      });

      expect(response.status).toBe(200);
      expect((await response.json()) as Job).toMatchObject({
        id: job.id,
        status: "cancelled"
      });
      const persisted = await store.getJob(job.id);
      expect(persisted?.status).toBe("cancelled");
      expect(persisted?.events.at(-1)?.message).toBe(
        "Status changed to cancelled."
      );
    }
  );

  it.each(["completed", "failed", "cancelled"] as const)(
    "rejects cancellation of a %s job without changing its record",
    async (status) => {
      const { baseUrl, store } = await startWorker();
      const job = jobWithStatus(status);
      await store.putJob(job);
      const before = await store.getJob(job.id);

      const response = await fetch(`${baseUrl}/jobs/${job.id}/cancel`, {
        method: "POST"
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: `Cannot cancel job with status "${status}".`
      });
      expect(await store.getJob(job.id)).toEqual(before);
    }
  );

  it("returns 404 for a missing job", async () => {
    const { baseUrl } = await startWorker();

    const response = await fetch(`${baseUrl}/jobs/missing/cancel`, {
      method: "POST"
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Job not found." });
  });
});

describe("POST /jobs Android ownership gate", () => {
  it("rejects an Android job before persistence when no dedicated AVD is configured", async () => {
    const { baseUrl, store } = await startWorker();

    const response = await fetch(`${baseUrl}/jobs`, {
      body: JSON.stringify({
        prompt: "Run Android QA",
        qa: "android",
        repo: "https://github.com/uriel-agent/uriel.git"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("dedicated AVD ownership"),
      reasons: expect.arrayContaining([expect.stringContaining("requires at least one")])
    });
    expect(await store.listJobs()).toEqual([]);
  });
});

async function startWorker(): Promise<{
  baseUrl: string;
  store: LocalJobStore;
}> {
  const stateDir = await mkdtemp(join(tmpdir(), "uriel-worker-cancel-"));
  temporaryDirectories.push(stateDir);
  const config = loadConfig({
    URIEL_ARTIFACTS_DIR: join(stateDir, "artifacts"),
    URIEL_STATE_DIR: stateDir
  });
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
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
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
    ref: "a".repeat(40),
    repo: "https://github.com/example/app",
    requestedBy: "test",
    source: "api",
    status,
    updatedAt: now
  };
}
