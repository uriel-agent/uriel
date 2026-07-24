import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  createJobEvent,
  type Artifact,
  type CheckResult,
  type Job,
  type JobEvent,
  type JobStatus
} from "../../../packages/core/src/index.ts";
import type { WorkerConfig } from "./config.ts";

export class LocalJobStore {
  readonly artifactsDir: string;
  private readonly jobsDir: string;

  constructor(config: WorkerConfig) {
    this.jobsDir = join(config.stateDir, "jobs");
    this.artifactsDir = config.artifactsDir;
  }

  async init(): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    await mkdir(this.artifactsDir, { recursive: true });
  }

  async putJob(job: Job): Promise<Job> {
    await this.init();
    await writeJson(this.jobPath(job.id), job);
    return job;
  }

  async getJob(jobId: string): Promise<Job | undefined> {
    try {
      return JSON.parse(await readFile(this.jobPath(jobId), "utf8")) as Job;
    } catch {
      return undefined;
    }
  }

  async listJobs(): Promise<Job[]> {
    await this.init();
    const entries = await readdir(this.jobsDir);
    const jobs = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => this.getJob(entry.replace(/\.json$/u, "")))
    );
    return jobs
      .filter((job): job is Job => Boolean(job))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async failRunningJobsAfterRestart(): Promise<Job[]> {
    const running = (await this.listJobs()).filter((job) => job.status === "running");
    const failed = await Promise.all(
      running.map(async (job) => {
        const next: Job = {
          ...job,
          events: [
            ...job.events,
            createJobEvent(
              "worker",
              "error",
              "Worker restarted while this job was running; marking it failed."
            )
          ].slice(-500),
          status: "failed",
          updatedAt: new Date().toISOString()
        };
        return this.putJob(next);
      })
    );
    return failed;
  }

  async appendEvent(jobId: string, event: JobEvent): Promise<Job | undefined> {
    const job = await this.getJob(jobId);
    if (!job) {
      return undefined;
    }
    const next = {
      ...job,
      events: [...job.events, event].slice(-500),
      updatedAt: new Date().toISOString()
    };
    await this.putJob(next);
    return next;
  }

  async setStatus(jobId: string, status: JobStatus): Promise<Job | undefined> {
    const job = await this.getJob(jobId);
    if (!job) {
      return undefined;
    }
    const next = { ...job, status, updatedAt: new Date().toISOString() };
    await this.putJob(next);
    await this.appendEvent(
      jobId,
      createJobEvent("job", "info", `Status changed to ${status}.`)
    );
    return this.getJob(jobId);
  }

  async setCheckResults(
    jobId: string,
    checkResults: CheckResult[]
  ): Promise<Job | undefined> {
    const job = await this.getJob(jobId);
    if (!job) {
      return undefined;
    }
    const next = {
      ...job,
      checkResults,
      updatedAt: new Date().toISOString()
    };
    await this.putJob(next);
    return next;
  }

  async setPullRequestUrl(
    jobId: string,
    pullRequestUrl: string
  ): Promise<Job | undefined> {
    const job = await this.getJob(jobId);
    if (!job) {
      return undefined;
    }
    const next = {
      ...job,
      pullRequestUrl,
      updatedAt: new Date().toISOString()
    };
    await this.putJob(next);
    return next;
  }

  async addArtifact(jobId: string, artifact: Artifact): Promise<Job | undefined> {
    const job = await this.getJob(jobId);
    if (!job) {
      return undefined;
    }
    const next = {
      ...job,
      artifacts: [...job.artifacts, artifact],
      updatedAt: new Date().toISOString()
    };
    await this.putJob(next);
    await this.appendEvent(
      jobId,
      createJobEvent("artifact", "info", `Captured artifact ${artifact.name}.`, {
        name: artifact.name,
        path: artifact.url ?? null
      })
    );
    return this.getJob(jobId);
  }

  async artifactInfo(jobId: string, name: string): Promise<{ path: string; size: number } | undefined> {
    const path = join(this.artifactsDir, jobId, name);
    try {
      const info = await stat(path);
      if (!info.isFile()) {
        return undefined;
      }
      return { path, size: info.size };
    } catch {
      return undefined;
    }
  }

  private jobPath(jobId: string): string {
    return join(this.jobsDir, `${jobId}.json`);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
