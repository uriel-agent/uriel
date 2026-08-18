import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { WatchdogProbe } from "./watchdog.ts";

export interface ReadinessSample extends WatchdogProbe {
  at: string;
}

export interface AvailabilitySummary {
  coveredSeconds: number;
  coveragePercentage: number;
  degradedSamples: number;
  degradedSeconds: number;
  excludedSamples: number;
  excludedSeconds: number;
  firstSampleAt?: string;
  lastSampleAt?: string;
  longestGapSeconds: number;
  readyPercentage: number | null;
  readySamples: number;
  readySeconds: number;
  sampleCount: number;
  unobservedSeconds: number;
  windowEnd: string;
  windowSeconds: number;
  windowStart: string;
}

export interface ReadinessHistoryOptions {
  compactEvery?: number;
  filePath: string;
  maxGapMs: number;
  maxSamples: number;
  retentionMs: number;
}

export class ReadinessHistory {
  private initialized = false;
  private samples: ReadinessSample[] = [];
  private writesSinceCompaction = 0;

  constructor(private readonly options: ReadinessHistoryOptions) {}

  async init(now = Date.now()): Promise<void> {
    if (this.initialized) return;
    await mkdir(dirname(this.options.filePath), { recursive: true });
    let malformed = false;
    try {
      const raw = await readFile(this.options.filePath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const sample = validSample(JSON.parse(line) as unknown);
          if (sample) this.samples.push(sample);
          else malformed = true;
        } catch {
          malformed = true;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const before = this.samples.length;
    this.prune(now);
    this.initialized = true;
    if (malformed || this.samples.length !== before) await this.compact();
  }

  async record(probe: WatchdogProbe, at = new Date().toISOString()): Promise<void> {
    const timestamp = Date.parse(at);
    if (!Number.isFinite(timestamp)) throw new Error(`Invalid readiness sample timestamp: ${at}`);
    await this.init(timestamp);
    const sample: ReadinessSample = {
      actionable: probe.actionable,
      at: new Date(timestamp).toISOString(),
      causes: probe.causes.slice(0, 8).map((cause) => cause.slice(0, 240)),
      ...(probe.excludedReason ? { excludedReason: probe.excludedReason.slice(0, 100) } : {}),
      status: probe.status
    };
    await appendFile(this.options.filePath, `${JSON.stringify(sample)}\n`, "utf8");
    this.samples.push(sample);
    this.samples.sort((left, right) => left.at.localeCompare(right.at));
    this.prune(timestamp);
    this.writesSinceCompaction += 1;
    if (this.writesSinceCompaction >= (this.options.compactEvery ?? 120)) {
      await this.compact();
    }
  }

  async summary(windowMs: number, now = Date.now()): Promise<AvailabilitySummary> {
    await this.init(now);
    const boundedWindowMs = Math.max(1_000, Math.min(windowMs, this.options.retentionMs));
    const windowStart = now - boundedWindowMs;
    const chronological = this.samples
      .filter((sample) => Date.parse(sample.at) <= now)
      .sort((left, right) => left.at.localeCompare(right.at));
    const prior = [...chronological]
      .reverse()
      .find((sample) => Date.parse(sample.at) < windowStart);
    const within = chronological.filter((sample) => {
      const timestamp = Date.parse(sample.at);
      return timestamp >= windowStart && timestamp <= now;
    });
    const timeline = prior ? [prior, ...within] : within;

    let readyMs = 0;
    let degradedMs = 0;
    let excludedMs = 0;
    for (const [index, sample] of timeline.entries()) {
      const sampleAt = Date.parse(sample.at);
      const nextAt = timeline[index + 1] ? Date.parse(timeline[index + 1]!.at) : now;
      const intervalStart = Math.max(windowStart, sampleAt);
      const intervalEnd = Math.min(now, nextAt, sampleAt + this.options.maxGapMs);
      const duration = Math.max(0, intervalEnd - intervalStart);
      if (sample.excludedReason) excludedMs += duration;
      else if (sample.status === "ready") readyMs += duration;
      else degradedMs += duration;
    }

    const coveredMs = readyMs + degradedMs + excludedMs;
    const measuredMs = readyMs + degradedMs;
    const sampleTimes = within.map((sample) => Date.parse(sample.at));
    const gapBoundaries = [windowStart, ...sampleTimes, now];
    let longestGapMs = 0;
    for (let index = 1; index < gapBoundaries.length; index += 1) {
      longestGapMs = Math.max(longestGapMs, gapBoundaries[index]! - gapBoundaries[index - 1]!);
    }

    return {
      coveredSeconds: seconds(coveredMs),
      coveragePercentage: percentage(coveredMs, boundedWindowMs),
      degradedSamples: within.filter((sample) => !sample.excludedReason && sample.status !== "ready").length,
      degradedSeconds: seconds(degradedMs),
      excludedSamples: within.filter((sample) => Boolean(sample.excludedReason)).length,
      excludedSeconds: seconds(excludedMs),
      ...(within[0] ? { firstSampleAt: within[0].at } : {}),
      ...(within.at(-1) ? { lastSampleAt: within.at(-1)!.at } : {}),
      longestGapSeconds: seconds(longestGapMs),
      readyPercentage: measuredMs > 0 ? percentage(readyMs, measuredMs) : null,
      readySamples: within.filter((sample) => !sample.excludedReason && sample.status === "ready").length,
      readySeconds: seconds(readyMs),
      sampleCount: within.length,
      unobservedSeconds: seconds(Math.max(0, boundedWindowMs - coveredMs)),
      windowEnd: new Date(now).toISOString(),
      windowSeconds: seconds(boundedWindowMs),
      windowStart: new Date(windowStart).toISOString()
    };
  }

  private async compact(): Promise<void> {
    const temporary = `${this.options.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(
      temporary,
      this.samples.map((sample) => JSON.stringify(sample)).join("\n") +
        (this.samples.length > 0 ? "\n" : ""),
      "utf8"
    );
    await rename(temporary, this.options.filePath);
    this.writesSinceCompaction = 0;
  }

  private prune(now: number): void {
    const cutoff = now - this.options.retentionMs;
    this.samples = this.samples
      .filter((sample) => Date.parse(sample.at) >= cutoff)
      .slice(-this.options.maxSamples);
  }
}

function validSample(value: unknown): ReadinessSample | undefined {
  if (!value || typeof value !== "object") return undefined;
  const sample = value as Partial<ReadinessSample>;
  if (
    typeof sample.actionable !== "boolean" ||
    typeof sample.at !== "string" ||
    !Number.isFinite(Date.parse(sample.at)) ||
    !Array.isArray(sample.causes) ||
    !sample.causes.every((cause) => typeof cause === "string") ||
    (sample.status !== "ready" && sample.status !== "degraded" && sample.status !== "not-ready") ||
    (sample.excludedReason !== undefined && typeof sample.excludedReason !== "string")
  ) {
    return undefined;
  }
  return sample as ReadinessSample;
}

function percentage(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 100_000) / 1_000;
}

function seconds(milliseconds: number): number {
  return Math.round(milliseconds / 10) / 100;
}
