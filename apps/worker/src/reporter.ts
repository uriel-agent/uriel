import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  createJobEvent,
  type Artifact,
  type Job,
  type JobEvent,
  type JobStatus,
  type JsonValue
} from "../../../packages/core/src/index.ts";
import type { LocalJobStore } from "./store.ts";

export interface ReporterOptions {
  jobId: string;
  store: LocalJobStore;
}

export class JobReporter {
  private readonly jobId: string;
  private readonly store: LocalJobStore;

  constructor(options: ReporterOptions) {
    this.jobId = options.jobId;
    this.store = options.store;
  }

  async event(
    type: JobEvent["type"],
    level: JobEvent["level"],
    message: string,
    data?: JsonValue
  ): Promise<void> {
    const event = createJobEvent(type, level, message, data);
    console.log(JSON.stringify(event));
    await this.store.appendEvent(this.jobId, event);
  }

  async status(status: JobStatus): Promise<Job | undefined> {
    return this.store.setStatus(this.jobId, status);
  }

  async getJob(): Promise<Job | undefined> {
    return this.store.getJob(this.jobId);
  }

  async uploadArtifact(
    name: string,
    body: Blob | Buffer | string,
    contentType: string
  ): Promise<void> {
    const artifactPath = join(this.store.artifactsDir, this.jobId, name);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, toWritableBody(body));
    const artifact: Artifact = {
      contentType,
      createdAt: new Date().toISOString(),
      kind: artifactKind(name),
      name,
      url: artifactPath
    };
    await this.store.addArtifact(this.jobId, artifact);
  }

  async registerArtifact(name: string, contentType?: string): Promise<void> {
    const info = await this.store.artifactInfo(this.jobId, name);
    if (!info) {
      throw new Error(`Artifact file does not exist: ${name}.`);
    }
    const artifact: Artifact = {
      ...(contentType ? { contentType } : {}),
      createdAt: new Date().toISOString(),
      kind: artifactKind(name),
      name,
      size: info.size,
      url: info.path
    };
    await this.store.addArtifact(this.jobId, artifact);
  }
}

function toWritableBody(body: Blob | Buffer | string): Buffer | string {
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    return body;
  }

  throw new Error("Blob artifact bodies are not supported in the local worker.");
}

export function artifactKind(name: string): Artifact["kind"] {
  if (/\.(png|jpg|jpeg|webp)$/iu.test(name)) {
    return "screenshot";
  }
  if (/\.(mp4|webm|mov)$/iu.test(name)) {
    return "video";
  }
  if (/\.(zip|trace)$/iu.test(name)) {
    return "trace";
  }
  if (/\.(jsonl?|txt|log)$/iu.test(name)) {
    return "log";
  }
  return "other";
}
