import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { JsonValue } from "../../../packages/core/src/index.ts";
import type { WorkerConfig } from "./config.ts";

export type WorkerResourceKind =
  | "android-device"
  | "android-lease"
  | "artifacts"
  | "harness-process"
  | "package-marker"
  | "worktree";

export interface WorkerResourceRecord {
  createdAt: string;
  id: string;
  jobId: string;
  kind: WorkerResourceKind;
  metadata: { [key: string]: JsonValue };
  owner: "uriel-worker";
  releasedAt?: string;
  status: "active" | "released";
  updatedAt: string;
}

interface JobResourceLedger {
  jobId: string;
  resources: WorkerResourceRecord[];
  version: 1;
}

const locks = new Map<string, Promise<void>>();

export class ResourceLedger {
  readonly directory: string;

  constructor(config: WorkerConfig) {
    this.directory = join(config.stateDir, "resources");
  }

  async record(
    jobId: string,
    id: string,
    kind: WorkerResourceKind,
    metadata: { [key: string]: JsonValue }
  ): Promise<WorkerResourceRecord> {
    let result: WorkerResourceRecord | undefined;
    await this.update(jobId, (ledger) => {
      const now = new Date().toISOString();
      const existing = ledger.resources.find((resource) => resource.id === id);
      result = {
        createdAt: existing?.createdAt ?? now,
        id,
        jobId,
        kind,
        metadata,
        owner: "uriel-worker",
        status: "active",
        updatedAt: now
      };
      ledger.resources = [
        ...ledger.resources.filter((resource) => resource.id !== id),
        result
      ];
    });
    if (!result) throw new Error(`Failed to journal resource ${id}.`);
    return result;
  }

  async release(jobId: string, id: string): Promise<WorkerResourceRecord | undefined> {
    let result: WorkerResourceRecord | undefined;
    await this.update(jobId, (ledger) => {
      const existing = ledger.resources.find((resource) => resource.id === id);
      if (!existing) return;
      if (existing.status === "released") {
        result = existing;
        return;
      }
      const now = new Date().toISOString();
      result = { ...existing, releasedAt: now, status: "released", updatedAt: now };
      ledger.resources = ledger.resources.map((resource) => resource.id === id ? result! : resource);
    });
    return result;
  }

  async resources(jobId: string): Promise<WorkerResourceRecord[]> {
    return (await this.read(jobId)).resources;
  }

  async active(jobId?: string): Promise<WorkerResourceRecord[]> {
    const ledgers = jobId ? [await this.read(jobId)] : await this.readAll();
    return ledgers.flatMap((ledger) => ledger.resources.filter((resource) => resource.status === "active"));
  }

  async readAll(): Promise<JobResourceLedger[]> {
    await mkdir(this.directory, { recursive: true });
    const names = await readdir(this.directory);
    return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      try {
        return parseLedger(await readFile(join(this.directory, name), "utf8"));
      } catch (error) {
        console.error(`Ignoring unreadable resource ledger ${name}: ${errorMessage(error)}`);
        return { jobId: name.replace(/\.json$/u, ""), resources: [], version: 1 as const };
      }
    }));
  }

  async remove(jobId: string): Promise<void> {
    await rm(this.path(jobId), { force: true });
  }

  private async read(jobId: string): Promise<JobResourceLedger> {
    try {
      return parseLedger(await readFile(this.path(jobId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { jobId, resources: [], version: 1 };
    }
  }

  private async update(jobId: string, mutate: (ledger: JobResourceLedger) => void): Promise<void> {
    const path = this.path(jobId);
    const previous = locks.get(path) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const ledger = await this.read(jobId);
      mutate(ledger);
      await mkdir(this.directory, { recursive: true });
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
      await rename(temporary, path);
    });
    locks.set(path, current);
    try {
      await current;
    } finally {
      if (locks.get(path) === current) locks.delete(path);
    }
  }

  private path(jobId: string): string {
    if (!/^[A-Za-z0-9._-]+$/u.test(jobId)) throw new Error(`Invalid job id for resource ledger: ${jobId}`);
    return join(this.directory, `${jobId}.json`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseLedger(input: string): JobResourceLedger {
  const parsed = JSON.parse(input) as JobResourceLedger;
  if (parsed.version !== 1 || typeof parsed.jobId !== "string" || !Array.isArray(parsed.resources)) {
    throw new Error("Invalid resource ledger.");
  }
  return parsed;
}
