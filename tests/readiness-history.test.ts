import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ReadinessHistory } from "../apps/worker/src/readiness-history.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("ReadinessHistory", () => {
  it("computes time-weighted readiness while excluding real work", async () => {
    const history = await createHistory({ maxGapMs: 60_000 });
    const start = Date.parse("2026-08-18T00:00:00.000Z");
    await history.record(probe("ready"), iso(start));
    await history.record(probe("not-ready"), iso(start + 30_000));
    await history.record(probe("degraded", "job-load"), iso(start + 60_000));
    await history.record(probe("ready"), iso(start + 90_000));

    const summary = await history.summary(120_000, start + 120_000);

    expect(summary).toMatchObject({
      coveredSeconds: 120,
      coveragePercentage: 100,
      degradedSamples: 1,
      degradedSeconds: 30,
      excludedSamples: 1,
      excludedSeconds: 30,
      longestGapSeconds: 30,
      readyPercentage: 66.667,
      readySamples: 2,
      readySeconds: 60,
      sampleCount: 4,
      unobservedSeconds: 0
    });
  });

  it("reports unobserved time after the maximum carry gap", async () => {
    const history = await createHistory({ maxGapMs: 45_000 });
    const start = Date.parse("2026-08-18T00:00:00.000Z");
    await history.record(probe("ready"), iso(start));

    const summary = await history.summary(120_000, start + 120_000);

    expect(summary).toMatchObject({
      coveredSeconds: 45,
      coveragePercentage: 37.5,
      longestGapSeconds: 120,
      readyPercentage: 100,
      unobservedSeconds: 75
    });
  });

  it("survives restart, prunes retention and sample count, and tolerates a malformed tail", async () => {
    const directory = await temporaryDirectory();
    const filePath = join(directory, "history.jsonl");
    const options = {
      compactEvery: 1,
      filePath,
      maxGapMs: 60_000,
      maxSamples: 3,
      retentionMs: 180_000
    };
    const start = Date.parse("2026-08-18T00:00:00.000Z");
    const first = new ReadinessHistory(options);
    for (let index = 0; index < 5; index += 1) {
      await first.record(probe("ready"), iso(start + index * 60_000));
    }
    await writeFile(filePath, `${await readFile(filePath, "utf8")}{malformed`, "utf8");

    const restarted = new ReadinessHistory(options);
    await restarted.init(start + 4 * 60_000);
    const summary = await restarted.summary(180_000, start + 4 * 60_000);
    const persisted = (await readFile(filePath, "utf8")).trim().split("\n");

    expect(summary.sampleCount).toBe(3);
    expect(summary.firstSampleAt).toBe(iso(start + 2 * 60_000));
    expect(persisted).toHaveLength(3);
    expect(() => JSON.parse(persisted.at(-1)!)).not.toThrow();
  });

  it("bounds persisted diagnostic detail", async () => {
    const history = await createHistory({ compactEvery: 1 });
    await history.record({
      actionable: false,
      causes: Array.from({ length: 12 }, () => "x".repeat(400)),
      excludedReason: "y".repeat(200),
      status: "degraded"
    }, "2026-08-18T00:00:00.000Z");

    const sample = JSON.parse(await readFile(historyFile(history), "utf8")) as {
      causes: string[];
      excludedReason: string;
    };
    expect(sample.causes).toHaveLength(8);
    expect(sample.causes.every((cause) => cause.length === 240)).toBe(true);
    expect(sample.excludedReason).toHaveLength(100);
  });
});

async function createHistory(overrides: Partial<ConstructorParameters<typeof ReadinessHistory>[0]> = {}) {
  const directory = await temporaryDirectory();
  const filePath = join(directory, "history.jsonl");
  const history = new ReadinessHistory({
    filePath,
    maxGapMs: 90_000,
    maxSamples: 25_000,
    retentionMs: 7 * 24 * 60 * 60 * 1_000,
    ...overrides
  });
  Object.defineProperty(history, "__testFilePath", { value: filePath });
  return history;
}

function historyFile(history: ReadinessHistory): string {
  return (history as ReadinessHistory & { __testFilePath: string }).__testFilePath;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "uriel-readiness-history-"));
  temporaryDirectories.push(directory);
  return directory;
}

function probe(status: "degraded" | "not-ready" | "ready", excludedReason?: string) {
  return {
    actionable: !excludedReason,
    causes: status === "ready" ? [] : [status],
    ...(excludedReason ? { excludedReason } : {}),
    status
  };
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
