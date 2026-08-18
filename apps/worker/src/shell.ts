import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface CommandResult {
  code: number;
  durationMs: number;
  stderr: string;
  stdout: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  onSpawn?: (pid: number) => Promise<void> | void;
  processGroup?: boolean;
  timeoutMs?: number;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: Boolean(options.processGroup && process.platform !== "win32"),
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let spawnRegistration: Promise<void> = Promise.resolve();
    if (child.pid && options.onSpawn) {
      spawnRegistration = Promise.resolve(options.onSpawn(child.pid));
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          killChild(child, options.processGroup, "SIGTERM");
          setTimeout(() => killChild(child, options.processGroup, "SIGKILL"), 1000).unref();
        }, options.timeoutMs)
      : undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      void spawnRegistration.then(
        () => resolve({ code: code ?? 1, durationMs: Date.now() - startedAt, stderr, stdout }),
        reject
      );
    });
    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

function killChild(
  child: import("node:child_process").ChildProcess,
  processGroup: boolean | undefined,
  signal: NodeJS.Signals
): void {
  try {
    if (processGroup && process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process already exited.
  }
}

export async function runChecked(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.code}\n${result.stderr}`
    );
  }
  return result;
}

export async function commandExists(command: string): Promise<boolean> {
  const result = await runCommand("sh", ["-lc", `command -v ${quote(command)}`]);
  return result.code === 0;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

export function quote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}
