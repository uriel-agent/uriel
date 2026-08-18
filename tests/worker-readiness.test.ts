import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveAndroidTools } from "../apps/worker/src/android-tooling.ts";
import { loadConfig, type WorkerConfig } from "../apps/worker/src/config.ts";
import { handleRequest } from "../apps/worker/src/main.ts";
import { HostCapacityGovernor } from "../apps/worker/src/host-capacity.ts";
import { checkWorkerReadiness } from "../apps/worker/src/worker-readiness.ts";

const servers: Server[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("Android tool resolution", () => {
  it("uses a stable home SDK when the configured SDK root is stale", async () => {
    const root = await temporaryDirectory();
    const sdk = join(root, "Library", "Android", "sdk");
    const adb = await executable(join(sdk, "platform-tools", "adb"), "exit 0");
    const emulator = await executable(join(sdk, "emulator", "emulator"), "exit 0");

    const tools = await resolveAndroidTools(
      loadConfig({}),
      {
        ANDROID_SDK_ROOT: join(root, "garbage-collected-sdk"),
        HOME: root,
        PATH: ""
      },
      "darwin"
    );

    expect(tools.adb).toEqual({ command: adb, source: "sdk-root" });
    expect(tools.emulator).toEqual({ command: emulator, source: "sdk-root" });
  });

  it("reports a broken explicit tool path instead of silently using another binary", async () => {
    const root = await temporaryDirectory();
    const fallback = await executable(join(root, "bin", "adb"), "exit 0");

    const tools = await resolveAndroidTools(
      loadConfig({ URIEL_ANDROID_ADB_PATH: join(root, "missing-adb") }),
      { HOME: root, PATH: join(root, "bin") },
      "darwin"
    );

    expect(fallback).toContain("/bin/adb");
    expect(tools.adb).toBeUndefined();
    expect(tools.adbCandidates).toEqual([join(root, "missing-adb")]);
  });
});

describe("worker readiness", () => {
  it("reports structured host pressure while leaving liveness independent", async () => {
    const config = loadConfig({ URIEL_ENABLE_ANDROID_QA: "false" });
    const decision = await new HostCapacityGovernor(config, async () => ({
      diskAvailableBytes: 1,
      memoryAvailableBytes: 1,
      memoryTotalBytes: 2,
      swapUsedBytes: 64 * 1024 ** 3
    })).evaluate({ activeHeavyJobs: 0, queuedJobs: 2 });

    const readiness = await checkWorkerReadiness(
      config,
      { activeHeavyJobs: 0, queuedJobs: 2 },
      decision
    );

    expect(readiness).toMatchObject({
      capacity: {
        disk: { actualBytes: 1, ok: false },
        memory: { actualBytes: 1, ok: false, totalBytes: 2 },
        status: "pressured",
        worker: { activeHeavyJobs: 0, queuedJobs: 2 }
      },
      ok: false,
      status: "not-ready"
    });
    expect(readiness.checks).toContainEqual(expect.objectContaining({
      id: "host.capacity",
      status: "fail"
    }));
  });

  it("keeps liveness public and makes detailed readiness authenticated", async () => {
    const config = await readyConfig();
    const baseUrl = await startWorker(config);

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: "uriel-worker" });

    const unauthorized = await fetch(`${baseUrl}/ready`);
    expect(unauthorized.status).toBe(401);

    const ready = await fetch(`${baseUrl}/ready`, {
      headers: { authorization: "Bearer test-token" }
    });
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, status: "ready" });
  });

  it("returns authenticated secret-free operational telemetry", async () => {
    const config = await readyConfig();
    config.androidApkUrl = "https://secret.example.test/signed.apk?token=do-not-leak";
    config.androidApkSha256 = "b".repeat(64);
    config.androidAppPackage = "com.example.qa";
    const baseUrl = await startWorker(config);

    expect((await fetch(`${baseUrl}/status`)).status).toBe(401);
    const response = await fetch(`${baseUrl}/status`, {
      headers: { authorization: "Bearer test-token" }
    });
    const body = await response.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      android: { leased: 0, total: 1 },
      provisioning: { configured: true, packageName: "com.example.qa" },
      queue: { activeJobs: 0, queuedJobs: 0 },
      service: "uriel-worker"
    });
    expect(serialized).not.toContain("do-not-leak");
    expect(serialized).not.toContain("b".repeat(64));
    expect(serialized).not.toContain("test-token");
  });

  it("stays usable but reports degraded when every configured AVD is attached and cold boot is unavailable", async () => {
    const config = await readyConfig({ brokenEmulator: true });
    const baseUrl = await startWorker(config);

    const response = await authorizedReady(baseUrl);
    const body = await response.json() as {
      checks: Array<{ id: string; status: string }>;
      status: string;
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks).toContainEqual(expect.objectContaining({
      id: "android.emulator.executable",
      status: "warn"
    }));
  });

  it("returns 503 when an unattached configured AVD cannot be cold-booted", async () => {
    const config = await readyConfig({ attached: false, brokenEmulator: true });
    const baseUrl = await startWorker(config);

    const response = await authorizedReady(baseUrl);
    const body = await response.json() as { status: string };

    expect(response.status).toBe(503);
    expect(body.status).toBe("not-ready");
  });

  it("returns 503 with remediation when adb is unresponsive", async () => {
    const config = await readyConfig({ adbResponsive: false });
    const baseUrl = await startWorker(config);

    const response = await authorizedReady(baseUrl);
    const body = await response.json() as {
      checks: Array<{ id: string; remediation?: string; status: string }>;
    };

    expect(response.status).toBe(503);
    expect(body.checks).toContainEqual(expect.objectContaining({
      id: "android.adb.responsive",
      remediation: expect.stringContaining("adb kill-server"),
      status: "fail"
    }));
  });

  it("returns 503 when a configured AVD is neither attached nor installed", async () => {
    const config = await readyConfig({ attached: false, listedAvd: "different-avd" });
    const baseUrl = await startWorker(config);

    const response = await authorizedReady(baseUrl);
    const body = await response.json() as {
      checks: Array<{ detail: string; id: string; status: string }>;
    };

    expect(response.status).toBe(503);
    expect(body.checks).toContainEqual(expect.objectContaining({
      detail: expect.stringContaining("uriel_qa_1"),
      id: "android.avds",
      status: "fail"
    }));
  });

  it("does not infer cold-boot capability when the emulator acceleration check fails", async () => {
    const config = await readyConfig({ acceleration: false, attached: false });
    const baseUrl = await startWorker(config);

    const response = await authorizedReady(baseUrl);
    const body = await response.json() as {
      checks: Array<{ id: string; status: string }>;
    };

    expect(response.status).toBe(503);
    expect(body.checks).toContainEqual(expect.objectContaining({
      id: "android.emulator.boot-capability",
      status: "fail"
    }));
  });

  it("returns 503 with remediation when APK provisioning is invalid", async () => {
    const config = await readyConfig();
    config.androidApkUrl = "file:///missing/qa.apk";
    config.androidApkSha256 = "a".repeat(64);
    config.androidAppPackage = "com.example.qa";
    const baseUrl = await startWorker(config);

    const response = await authorizedReady(baseUrl);
    const body = await response.json() as {
      checks: Array<{ id: string; remediation?: string; status: string }>;
    };

    expect(response.status).toBe(503);
    expect(body.checks).toContainEqual(expect.objectContaining({
      id: "android.apk.configuration",
      remediation: expect.stringContaining("Publish the pinned APK"),
      status: "fail"
    }));
  });
});

async function readyConfig(
  options: {
    acceleration?: boolean;
    adbResponsive?: boolean;
    attached?: boolean;
    brokenEmulator?: boolean;
    listedAvd?: string;
  } = {}
): Promise<WorkerConfig> {
  const root = await temporaryDirectory();
  const attached = options.attached ?? true;
  const adb = await executable(
    join(root, "bin", "adb"),
    `if [ "\${1:-}" = "devices" ]; then
  ${options.adbResponsive === false ? 'echo "adb server unavailable" >&2\n  exit 23' : ""}
  echo "List of devices attached"
  ${attached ? 'echo "emulator-5554 device product:sdk model:Pixel"' : ":"}
  exit 0
fi
if [ "\${1:-}" = "-s" ] && [ "\${3:-}" = "emu" ]; then
  echo uriel_qa_1
  echo OK
  exit 0
fi
exit 1`
  );
  const emulator = options.brokenEmulator
    ? join(root, "bin", "missing-emulator")
    : await executable(
      join(root, "bin", "emulator"),
      `if [ "\${1:-}" = "-list-avds" ]; then echo ${options.listedAvd ?? "uriel_qa_1"}; exit 0; fi
if [ "\${1:-}" = "-accel-check" ]; then
  ${options.acceleration === false ? 'echo "acceleration unavailable" >&2\n  exit 1' : 'echo "accel: usable"\n  exit 0'}
fi
exit 1`
    );
  return loadConfig({
    HOME: root,
    PATH: "",
    URIEL_ANDROID_ADB_PATH: adb,
    URIEL_ANDROID_AVDS: "uriel_qa_1",
    URIEL_ANDROID_EMULATOR_PATH: emulator,
    URIEL_STATE_DIR: root,
    URIEL_WORKER_TOKEN: "test-token"
  });
}

async function executable(path: string, body: string): Promise<string> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/sh\nset -eu\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "uriel-readiness-"));
  temporaryDirectories.push(path);
  return path;
}

async function startWorker(config: WorkerConfig): Promise<string> {
  const server = createServer((request, response) => {
    void handleRequest(request, response, config);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

async function authorizedReady(baseUrl: string): Promise<Response> {
  return fetch(`${baseUrl}/ready`, {
    headers: { authorization: "Bearer test-token" }
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
