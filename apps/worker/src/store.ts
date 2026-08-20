import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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

const terminalJobStatuses = new Set<JobStatus>([
  "cancelled",
  "completed",
  "failed"
]);
const jobLocks = new Map<string, Promise<void>>();

export type ApproveJobStepResult =
  | { outcome: "approved"; job: Job }
  | { outcome: "approval_not_found"; job: Job }
  | { outcome: "terminal"; job: Job };

export function isTerminalJobStatus(status: JobStatus): boolean {
  return terminalJobStatuses.has(status);
}

export class LocalJobStore {
  readonly artifactsDir: string;
  private readonly jobsDir: string;
  private readonly maxJobEvents: number;

  constructor(config: WorkerConfig) {
    this.jobsDir = join(config.stateDir, "jobs");
    this.artifactsDir = config.artifactsDir;
    this.maxJobEvents = config.maxJobEvents;
  }

  async init(): Promise<void> {
    await mkdir(this.jobsDir, { recursive: true });
    await mkdir(this.artifactsDir, { recursive: true });
  }

  async putJob(job: Job): Promise<Job> {
    return this.withLock(job.id, async () => {
      await this.writeJob(job);
      return job;
    });
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
    const failed = await Promise.all(running.map((job) => this.withLock(job.id, async () => {
        const current = await this.getJob(job.id);
        if (current?.status !== "running") return undefined;
        const next: Job = {
          ...current,
          events: [
            ...current.events,
            createJobEvent(
              "worker",
              "error",
              "Worker restarted while this job was running; marking it failed."
            )
          ].slice(-this.maxJobEvents),
          status: "failed",
          updatedAt: new Date().toISOString()
        };
        await this.writeJob(next);
        return next;
      })));
    return failed.filter((job): job is Job => Boolean(job));
  }

  async appendEvent(jobId: string, event: JobEvent): Promise<Job | undefined> {
    return this.withLock(jobId, async () => {
      const job = await this.getJob(jobId);
      if (!job) return undefined;
      const next = {
        ...job,
        events: [...job.events, event].slice(-this.maxJobEvents),
        updatedAt: new Date().toISOString()
      };
      await this.writeJob(next);
      return next;
    });
  }

  async setStatus(jobId: string, status: JobStatus): Promise<Job | undefined> {
    return (await this.transitionStatus(jobId, status))?.job;
  }

  async approveStep(
    jobId: string,
    stepId: string
  ): Promise<ApproveJobStepResult | undefined> {
    return this.withLock(jobId, async () => {
      const job = await this.getJob(jobId);
      if (!job) return undefined;
      if (isTerminalJobStatus(job.status)) {
        return { outcome: "terminal", job };
      }
      if (!job.approvals.some((approval) => approval.stepId === stepId)) {
        return { outcome: "approval_not_found", job };
      }

      const transition = this.buildStatusTransition(job, "queued");
      if (!transition.changed) {
        return { outcome: "terminal", job: transition.job };
      }
      const next: Job = {
        ...transition.job,
        approvals: transition.job.approvals.filter(
          (approval) => approval.stepId !== stepId
        ),
        events: [
          ...transition.job.events,
          createJobEvent("approval", "info", `Approved step ${stepId}.`)
        ].slice(-this.maxJobEvents)
      };
      await this.writeJob(next);
      return { outcome: "approved", job: next };
    });
  }

  async cancelJob(
    jobId: string
  ): Promise<{ changed: boolean; job: Job } | undefined> {
    return this.transitionStatus(jobId, "cancelled");
  }

  private async transitionStatus(
    jobId: string,
    status: JobStatus
  ): Promise<{ changed: boolean; job: Job } | undefined> {
    return this.withLock(jobId, async () => {
      const job = await this.getJob(jobId);
      if (!job) return undefined;
      const transition = this.buildStatusTransition(job, status);
      if (transition.changed) await this.writeJob(transition.job);
      return transition;
    });
  }

  async setCallbackSummary(jobId: string, summary: string): Promise<Job | undefined> {
    return this.withLock(jobId, async () => {
      const job = await this.getJob(jobId);
      if (!job) return undefined;
      if (job.callbackSummary === summary) return job;
      const next = {
        ...job,
        callbackSummary: summary,
        updatedAt: new Date().toISOString()
      };
      await this.writeJob(next);
      return next;
    });
  }

  async markCallbackDelivered(jobId: string): Promise<Job | undefined> {
    return this.withLock(jobId, async () => {
      const job = await this.getJob(jobId);
      if (!job) return undefined;
      if (job.callbackDeliveredAt) return job;
      const now = new Date().toISOString();
      const next = {
        ...job,
        callbackDeliveredAt: now,
        updatedAt: now
      };
      await this.writeJob(next);
      return next;
    });
  }

  async setCheckResults(
    jobId: string,
    checkResults: CheckResult[]
  ): Promise<Job | undefined> {
    return this.withLock(jobId, async () => {
      const job = await this.getJob(jobId);
      if (!job) return undefined;
      const next = { ...job, checkResults, updatedAt: new Date().toISOString() };
      await this.writeJob(next);
      return next;
    });
  }

  async setPullRequestUrl(
    jobId: string,
    pullRequestUrl: string
  ): Promise<Job | undefined> {
    return this.withLock(jobId, async () => {
      const job = await this.getJob(jobId);
      if (!job) return undefined;
      const next = { ...job, pullRequestUrl, updatedAt: new Date().toISOString() };
      await this.writeJob(next);
      return next;
    });
  }

  async addArtifact(jobId: string, artifact: Artifact): Promise<Job | undefined> {
    return this.withLock(jobId, async () => {
      const job = await this.getJob(jobId);
      if (!job) return undefined;
      const now = new Date().toISOString();
      const next: Job = {
        ...job,
        artifacts: [...job.artifacts, artifact],
        events: [
          ...job.events,
          createJobEvent("artifact", "info", `Captured artifact ${artifact.name}.`, {
            name: artifact.name,
            path: artifact.url ?? null
          })
        ].slice(-this.maxJobEvents),
        updatedAt: now
      };
      await this.writeJob(next);
      return next;
    });
  }

  async pruneJobs(predicate: (job: Job) => boolean, keep: number): Promise<string[]> {
    const candidates = (await this.listJobs()).filter(predicate);
    const removed: string[] = [];
    for (const job of candidates.slice(Math.max(0, keep))) {
      await this.withLock(job.id, async () => {
        await rm(this.jobPath(job.id), { force: true });
      });
      removed.push(job.id);
    }
    return removed;
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

  private buildStatusTransition(
    job: Job,
    status: JobStatus
  ): { changed: boolean; job: Job } {
    if (isTerminalJobStatus(job.status)) return { changed: false, job };
    const now = new Date().toISOString();
    return {
      changed: true,
      job: {
        ...job,
        events: [
          ...job.events,
          createJobEvent("job", "info", `Status changed to ${status}.`)
        ].slice(-this.maxJobEvents),
        status,
        updatedAt: now
      }
    };
  }

  private async writeJob(job: Job): Promise<void> {
    await this.init();
    await writeJson(this.jobPath(job.id), job);
  }

  private async withLock<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const path = this.jobPath(jobId);
    const previous = jobLocks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => { release = resolveLock; });
    const chain = previous.then(() => current);
    jobLocks.set(path, chain);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (jobLocks.get(path) === chain) jobLocks.delete(path);
    }
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}
