import { describe, expect, it } from "vitest";

import { runCommand } from "../apps/worker/src/shell.ts";

describe("bounded shell commands", () => {
  it("rejects a spawn failure without waiting for the timeout", async () => {
    const startedAt = Date.now();
    await expect(runCommand("uriel-command-that-does-not-exist", [], { timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("preserves normal stdout, stderr, and exit status", async () => {
    const result = await runCommand(process.execPath, [
      "-e",
      "process.stdout.write('out'); process.stderr.write('err'); process.exit(7)"
    ], { timeoutMs: 5_000 });

    expect(result.code).toBe(7);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
  });

  it.skipIf(process.platform === "win32")(
    "kills the full process group and settles when a descendant inherits stdio",
    async () => {
      const script = [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e',",
        "  `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`",
        "], { stdio: ['ignore', 'inherit', 'inherit'] });",
        "console.log(child.pid);",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);"
      ].join("\n");

      const startedAt = Date.now();
      const result = await runCommand(process.execPath, ["-e", script], { timeoutMs: 100 });
      const descendantPid = Number.parseInt(result.stdout.trim(), 10);

      expect(result.code).toBe(124);
      expect(result.durationMs).toBeGreaterThanOrEqual(1_000);
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      await expectProcessToExit(descendantPid);
    },
    5_000
  );

  it.skipIf(process.platform === "win32")(
    "settles after the kill grace when a detached descendant keeps the pipes open",
    async () => {
      const script = [
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e',",
        "  `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`",
        "], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] });",
        "console.log(child.pid);",
        "setInterval(() => {}, 1000);"
      ].join("\n");

      const startedAt = Date.now();
      const result = await runCommand(process.execPath, ["-e", script], { timeoutMs: 100 });
      const escapedPid = Number.parseInt(result.stdout.trim(), 10);

      try {
        expect(result.code).toBe(124);
        expect(result.durationMs).toBeGreaterThanOrEqual(1_000);
        expect(Date.now() - startedAt).toBeLessThan(3_000);
        expect(processExists(escapedPid)).toBe(true);
      } finally {
        if (Number.isSafeInteger(escapedPid)) process.kill(-escapedPid, "SIGKILL");
      }
      await expectProcessToExit(escapedPid);
    },
    5_000
  );
});

async function expectProcessToExit(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(processExists(pid)).toBe(false);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
