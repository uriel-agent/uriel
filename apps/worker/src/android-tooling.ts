import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { WorkerConfig } from "./config.ts";
import { runCommand } from "./shell.ts";

export type AndroidToolSource = "configured" | "sdk-root" | "path";

export interface ResolvedAndroidTool {
  command: string;
  source: AndroidToolSource;
}

export interface AndroidToolResolution {
  adb?: ResolvedAndroidTool;
  adbCandidates: string[];
  emulator?: ResolvedAndroidTool;
  emulatorCandidates: string[];
}

export interface AttachedAndroidAvd {
  avd: string;
  serial: string;
}

export interface AndroidEmulatorAcceleration {
  detail: string;
  ok: boolean;
}

type AndroidToolConfig = Pick<
  WorkerConfig,
  "androidAdbPath" | "androidEmulatorPath"
>;

export async function resolveAndroidTools(
  config: AndroidToolConfig,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<AndroidToolResolution> {
  const roots = sdkRoots(env, platform);
  const [adb, emulator] = await Promise.all([
    resolveTool(config.androidAdbPath, roots.map((root) => join(root, "platform-tools", "adb")), "adb", env),
    resolveTool(config.androidEmulatorPath, roots.map((root) => join(root, "emulator", "emulator")), "emulator", env)
  ]);
  return {
    adb: adb.tool,
    adbCandidates: adb.candidates,
    emulator: emulator.tool,
    emulatorCandidates: emulator.candidates
  };
}

export async function listAttachedAndroidAvds(
  adbCommand: string
): Promise<{ avds: AttachedAndroidAvd[]; devices: string[]; error?: string }> {
  let devicesResult;
  try {
    devicesResult = await runCommand(adbCommand, ["devices"], { timeoutMs: 30_000 });
  } catch (error) {
    return { avds: [], devices: [], error: errorMessage(error) };
  }
  if (devicesResult.code !== 0) {
    return {
      avds: [],
      devices: [],
      error: (devicesResult.stderr || devicesResult.stdout).trim() || `adb exited ${devicesResult.code}`
    };
  }

  const devices = parseAdbDeviceSerials(devicesResult.stdout);
  const avds: AttachedAndroidAvd[] = [];
  for (const serial of devices) {
    const result = await runCommand(
      adbCommand,
      ["-s", serial, "emu", "avd", "name"],
      { timeoutMs: 5_000 }
    );
    if (result.code !== 0) continue;
    const avd = result.stdout
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line && line !== "OK");
    if (avd) avds.push({ avd, serial });
  }
  return { avds, devices };
}

export async function checkAndroidEmulatorAcceleration(
  emulatorCommand: string
): Promise<AndroidEmulatorAcceleration> {
  try {
    const result = await runCommand(emulatorCommand, ["-accel-check"], { timeoutMs: 30_000 });
    const detail = (result.stdout || result.stderr).trim();
    return {
      detail: detail || `emulator -accel-check exited ${result.code}`,
      ok: result.code === 0
    };
  } catch (error) {
    return { detail: errorMessage(error), ok: false };
  }
}

export function parseAdbDeviceSerials(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => /^(\S+)\s+device(?:\s|$)/u.exec(line)?.[1])
    .filter((serial): serial is string => Boolean(serial));
}

async function resolveTool(
  configuredPath: string | undefined,
  sdkCandidates: string[],
  commandName: string,
  env: NodeJS.ProcessEnv
): Promise<{ candidates: string[]; tool?: ResolvedAndroidTool }> {
  if (configuredPath) {
    return {
      candidates: [configuredPath],
      tool: await isExecutable(configuredPath)
        ? { command: configuredPath, source: "configured" }
        : undefined
    };
  }

  const candidates = unique(sdkCandidates);
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return { candidates, tool: { command: candidate, source: "sdk-root" } };
    }
  }

  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, commandName);
    if (!candidates.includes(candidate)) candidates.push(candidate);
    if (await isExecutable(candidate)) {
      return { candidates, tool: { command: candidate, source: "path" } };
    }
  }
  return { candidates };
}

function sdkRoots(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const home = env.HOME?.trim();
  return unique([
    env.ANDROID_SDK_ROOT?.trim(),
    env.ANDROID_HOME?.trim(),
    platform === "darwin" && home ? join(home, "Library", "Android", "sdk") : undefined,
    platform === "linux" && home ? join(home, "Android", "Sdk") : undefined
  ].filter((root): root is string => Boolean(root)));
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
