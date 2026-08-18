import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";

const commandAbortContext = new AsyncLocalStorage<AbortSignal | null>();

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
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function withCommandAbortSignal<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  return signal ? commandAbortContext.run(signal, operation) : operation();
}

export async function withoutCommandAbortSignal<T>(operation: () => Promise<T>): Promise<T> {
  return commandAbortContext.run(null, operation);
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const contextualSignal = commandAbortContext.getStore();
    const abortSignal = options.signal ?? (contextualSignal === null ? undefined : contextualSignal);
    if (abortSignal?.aborted) {
      resolve({ code: 130, durationMs: 0, stderr: "", stdout: "" });
      return;
    }
    const processGroup = process.platform !== "win32" &&
      (Boolean(options.processGroup) || options.timeoutMs !== undefined || abortSignal !== undefined);
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: processGroup,
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
    let terminationCode: number | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let forceSettle: NodeJS.Timeout | undefined;
    const settle = (code: number, error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      if (forceSettle) clearTimeout(forceSettle);
      abortSignal?.removeEventListener("abort", abort);
      void spawnRegistration.then(
        () => error
          ? reject(error)
          : resolve({ code, durationMs: Date.now() - startedAt, stderr, stdout }),
        reject
      );
    };
    const terminate = (code: number): void => {
      if (settled || terminationCode !== undefined) return;
      terminationCode = code;
      killChild(child, processGroup, "SIGTERM");
      forceKill = setTimeout(() => {
        killChild(child, processGroup, "SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1000);
      forceKill.unref();
      forceSettle = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settle(code);
      }, 1500);
      forceSettle.unref();
    };
    const abort = (): void => terminate(130);
    abortSignal?.addEventListener("abort", abort, { once: true });
    timeout = options.timeoutMs
      ? setTimeout(() => {
          terminate(124);
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
      settle(1, error);
    });
    child.on("close", (code) => {
      settle(terminationCode ?? code ?? 1);
    });
    if (options.input) {
      child.stdin.write(options.input);
    }
    child.stdin.end();
  });
}

function killChild(
  child: import("node:child_process").ChildProcess,
  processGroup: boolean,
  signal: NodeJS.Signals
): void {
  try {
    if (processGroup && child.pid) {
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
