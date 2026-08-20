import {
  validateJobChecks,
  type CheckResult,
  type JobCheck
} from "./checks.ts";

export const qaModes = ["none", "browser", "android", "ios", "both", "all"] as const;
export type QaMode = (typeof qaModes)[number];

export const jobKinds = ["change", "verify"] as const;
export type JobKind = (typeof jobKinds)[number];

export const jobStatuses = [
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled"
] as const;
export type JobStatus = (typeof jobStatuses)[number];

export type JobSource = string;

export type RepoProfile = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CreateJobRequest {
  callbackUrl?: string;
  checks?: JobCheck[];
  kind?: JobKind;
  repo: string;
  prompt: string;
  profile?: RepoProfile;
  issue?: string;
  qa?: QaMode;
  source?: JobSource;
  requestedBy?: string;
  ref?: string;
  metadata?: Record<string, JsonValue>;
}

export interface Artifact {
  contentType?: string;
  createdAt: string;
  kind: "log" | "screenshot" | "trace" | "video" | "transcript" | "other";
  name: string;
  size?: number;
  url?: string;
}

export interface ApprovalRequest {
  createdAt: string;
  description: string;
  stepId: string;
}

export interface JobEvent {
  at: string;
  data?: JsonValue;
  id: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  type:
    | "accepted"
    | "artifact"
    | "approval"
    | "command"
    | "dispatch"
    | "job"
    | "qa"
    | "repo"
    | "worker";
}

export interface Job {
  approvals: ApprovalRequest[];
  artifacts: Artifact[];
  branch: string;
  callbackDeliveredAt?: string;
  callbackSummary?: string;
  callbackUrl?: string;
  checkResults?: CheckResult[];
  checks?: JobCheck[];
  createdAt: string;
  events: JobEvent[];
  id: string;
  issue?: string;
  kind: JobKind;
  metadata: Record<string, JsonValue>;
  profile: RepoProfile;
  prompt: string;
  pullRequestUrl?: string;
  qa: QaMode;
  ref?: string;
  repo: string;
  requestedBy?: string;
  source: JobSource;
  status: JobStatus;
  updatedAt: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateCreateJobRequest(
  input: unknown
): ValidationResult<CreateJobRequest> {
  if (!isRecord(input)) {
    return { ok: false, error: "Expected a JSON object." };
  }

  const repo = readString(input, "repo");
  if (!repo || !isGitHubUrl(repo)) {
    return {
      ok: false,
      error: "repo must be an HTTPS or SSH GitHub repository URL."
    };
  }

  const prompt = readString(input, "prompt");
  if (!prompt || prompt.trim().length < 3) {
    return { ok: false, error: "prompt must be at least 3 characters." };
  }

  const kind = input.kind === undefined ? "change" : input.kind;
  if (typeof kind !== "string" || !jobKinds.includes(kind as JobKind)) {
    return { ok: false, error: "kind must be change or verify." };
  }

  let ref: string | undefined;
  if (input.ref !== undefined) {
    if (typeof input.ref !== "string") {
      return { ok: false, error: "ref must be a string." };
    }
    ref = input.ref.trim();
    if (
      ref.length < 1 ||
      ref.length > 255 ||
      /[\s\u0000-\u001f\u007f]/u.test(ref) ||
      ref.startsWith("-")
    ) {
      return {
        ok: false,
        error: "ref must be 1 to 255 characters, contain no whitespace or control characters, and not start with a hyphen."
      };
    }
  }

  let checks: JobCheck[] | undefined;
  if (input.checks !== undefined) {
    const validation = validateJobChecks(input.checks);
    if (!validation.ok) {
      return validation;
    }
    checks = validation.value;
  }

  let callbackUrl: string | undefined;
  if (input.callbackUrl !== undefined) {
    if (typeof input.callbackUrl !== "string" || input.callbackUrl.length > 2048) {
      return { ok: false, error: "callbackUrl must be an HTTP(S) URL no longer than 2048 characters." };
    }
    try {
      const parsed = new URL(input.callbackUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Invalid callback URL protocol.");
      }
      callbackUrl = parsed.toString();
    } catch {
      return { ok: false, error: "callbackUrl must be an HTTP(S) URL no longer than 2048 characters." };
    }
  }

  const qa = normalizeQaMode(input.qa);
  const source = normalizeJobSource(input.source);
  const profile = readOptionalString(input, "profile");
  const issue = readOptionalString(input, "issue");
  const requestedBy = readOptionalString(input, "requestedBy");
  const metadata = normalizeMetadata(input.metadata);

  return {
    ok: true,
    value: {
      ...(callbackUrl ? { callbackUrl } : {}),
      ...(checks ? { checks } : {}),
      kind: kind as JobKind,
      repo: repo.trim(),
      prompt: prompt.trim(),
      ...(profile ? { profile } : {}),
      ...(issue ? { issue } : {}),
      qa,
      source,
      ...(ref ? { ref } : {}),
      ...(requestedBy ? { requestedBy } : {}),
      metadata
    }
  };
}

export function createJobEvent(
  type: JobEvent["type"],
  level: JobEvent["level"],
  message: string,
  data?: JsonValue
): JobEvent {
  return {
    at: new Date().toISOString(),
    id: createId("evt"),
    level,
    message,
    type,
    ...(data === undefined ? {} : { data })
  };
}

export function createId(prefix = "job"): string {
  const cryptoSource = globalThis.crypto;
  if (cryptoSource?.randomUUID) {
    return `${prefix}_${cryptoSource.randomUUID()}`;
  }

  const bytes = new Uint8Array(16);
  cryptoSource?.getRandomValues(bytes);
  const fallback = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `${prefix}_${fallback}`;
}

export function isGitHubUrl(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\.git)?$/u.test(trimmed) ||
    /^git@github\.com:[^/\s]+\/[^/\s]+(?:\.git)?$/u.test(trimmed)
  );
}

export function normalizeQaMode(input: unknown): QaMode {
  if (typeof input === "string" && qaModes.includes(input as QaMode)) {
    return input as QaMode;
  }
  return "none";
}

export function normalizeJobSource(input: unknown): JobSource {
  if (typeof input === "string") {
    const source = input.trim();
    if (/^[a-z0-9][a-z0-9._/-]{0,79}$/iu.test(source)) {
      return source;
    }
  }
  return "api";
}

export function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function readString(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function readOptionalString(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = readString(input, key)?.trim();
  return value ? value : undefined;
}

function normalizeMetadata(input: unknown): Record<string, JsonValue> {
  if (!isRecord(input)) {
    return {};
  }

  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (isJsonValue(value)) {
      output[key] = value;
    }
  }
  return output;
}

function isJsonValue(input: unknown): input is JsonValue {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "number" ||
    typeof input === "boolean"
  ) {
    return true;
  }

  if (Array.isArray(input)) {
    return input.every(isJsonValue);
  }

  if (isRecord(input)) {
    return Object.values(input).every(isJsonValue);
  }

  return false;
}
