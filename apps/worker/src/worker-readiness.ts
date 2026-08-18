import { fileURLToPath } from "node:url";

import { configuredAndroidProvisioning } from "./android-provisioning.ts";
import { androidAvdOwnershipErrors } from "./android-ownership.ts";
import {
  checkAndroidEmulatorAcceleration,
  listAttachedAndroidAvds,
  resolveAndroidTools,
  type AndroidToolResolution
} from "./android-tooling.ts";
import type { WorkerConfig } from "./config.ts";
import { exists, runCommand } from "./shell.ts";

export type ReadinessCheckStatus = "pass" | "warn" | "fail" | "disabled";

export interface ReadinessCheck {
  detail: string;
  id: string;
  remediation?: string;
  status: ReadinessCheckStatus;
}

export interface WorkerReadiness {
  checks: ReadinessCheck[];
  ok: boolean;
  service: "uriel-worker";
  status: "ready" | "degraded" | "not-ready";
}

export async function checkWorkerReadiness(config: WorkerConfig): Promise<WorkerReadiness> {
  const checks: ReadinessCheck[] = [];
  if (!config.enableAndroidQa) {
    checks.push({
      detail: "Android QA is disabled by worker configuration.",
      id: "android.enabled",
      status: "disabled"
    });
    return finish(checks);
  }

  checks.push({
    detail: `Android QA is enabled with ${config.androidAvds.length} reserved AVD slot(s).`,
    id: "android.enabled",
    status: "pass"
  });

  const ownershipErrors = androidAvdOwnershipErrors(config);
  checks.push({
    detail: ownershipErrors.length === 0
      ? `All configured AVDs use the worker-owned ${config.androidAvdPrefix} prefix.`
      : ownershipErrors.join(" "),
    id: "android.avd.ownership",
    remediation: ownershipErrors.length === 0
      ? undefined
      : "Configure dedicated Uriel AVDs and set URIEL_ANDROID_AVDS without interactive or physical targets.",
    status: ownershipErrors.length === 0 ? "pass" : "fail"
  });

  const tools = await resolveAndroidTools(config);
  if (!tools.adb) {
    checks.push(missingToolCheck("adb", tools.adbCandidates, "URIEL_ANDROID_ADB_PATH"));
    await checkProvisioning(config, checks);
    return finish(checks);
  }
  checks.push({
    detail: `${tools.adb.command} (${tools.adb.source})`,
    id: "android.adb.executable",
    status: "pass"
  });

  const attached = await listAttachedAndroidAvds(tools.adb.command);
  if (attached.error) {
    checks.push({
      detail: attached.error,
      id: "android.adb.responsive",
      remediation: "Run `adb kill-server && adb start-server`, then recheck host USB/emulator access.",
      status: "fail"
    });
    await checkProvisioning(config, checks);
    return finish(checks);
  }
  checks.push({
    detail: `adb responded with ${attached.devices.length} attached device(s).`,
    id: "android.adb.responsive",
    status: "pass"
  });

  await checkAvds(config, tools, attached.avds, checks);
  await checkProvisioning(config, checks);
  return finish(checks);
}

async function checkAvds(
  config: WorkerConfig,
  tools: AndroidToolResolution,
  attachedAvds: Array<{ avd: string; serial: string }>,
  checks: ReadinessCheck[]
): Promise<void> {
  if (config.androidAvds.length === 0) {
    return;
  }

  const attachedNames = new Set(attachedAvds.map(({ avd }) => avd));
  const unattachedNames = config.androidAvds.filter((avd) => !attachedNames.has(avd));

  if (!tools.emulator) {
    checks.push({
      detail: unattachedNames.length === 0
        ? "The emulator executable is unavailable, but every configured AVD is already attached. Cold recovery is unavailable."
        : `The emulator executable is unavailable and these AVDs are not attached: ${unattachedNames.join(", ")}.`,
      id: "android.emulator.executable",
      remediation: "Set URIEL_ANDROID_EMULATOR_PATH to a stable executable or repair ANDROID_SDK_ROOT/ANDROID_HOME.",
      status: unattachedNames.length === 0 ? "warn" : "fail"
    });
    checks.push(avdAttachmentCheck(config.androidAvds, attachedAvds, unattachedNames));
    return;
  }

  checks.push({
    detail: `${tools.emulator.command} (${tools.emulator.source})`,
    id: "android.emulator.executable",
    status: "pass"
  });

  let listResult;
  try {
    listResult = await runCommand(tools.emulator.command, ["-list-avds"], { timeoutMs: 30_000 });
  } catch (error) {
    listResult = { code: 1, stderr: errorMessage(error), stdout: "" };
  }
  const availableAvds = listResult.code === 0
    ? new Set(listResult.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean))
    : new Set<string>();
  const missingAvds = config.androidAvds.filter(
    (avd) => !attachedNames.has(avd) && !availableAvds.has(avd)
  );
  checks.push({
    detail: listResult.code !== 0
      ? `Could not list AVDs: ${(listResult.stderr || listResult.stdout).trim() || `emulator exited ${listResult.code}`}`
      : missingAvds.length > 0
        ? `Configured AVDs are missing: ${missingAvds.join(", ")}.`
        : `All configured AVDs are attached or available: ${config.androidAvds.join(", ")}.`,
    id: "android.avds",
    remediation: listResult.code === 0 && missingAvds.length === 0
      ? undefined
      : "Create the missing dedicated AVDs or update URIEL_ANDROID_AVDS to match the host.",
    status: listResult.code === 0 && missingAvds.length === 0 ? "pass" : "fail"
  });

  const acceleration = await checkAndroidEmulatorAcceleration(tools.emulator.command);
  checks.push({
    detail: acceleration.ok
      ? `The emulator reports usable acceleration: ${acceleration.detail}`
      : unattachedNames.length === 0
        ? `Emulator acceleration is unavailable, but all configured AVDs are currently attached: ${acceleration.detail}`
        : `Emulator acceleration is unavailable and these AVDs require a boot: ${unattachedNames.join(", ")}. ${acceleration.detail}`,
    id: "android.emulator.boot-capability",
    remediation: acceleration.ok
      ? undefined
      : "Run `emulator -accel-check` and repair the host hypervisor/KVM configuration before accepting cold boots.",
    status: acceleration.ok ? "pass" : unattachedNames.length === 0 ? "warn" : "fail"
  });
}

function avdAttachmentCheck(
  configuredAvds: string[],
  attachedAvds: Array<{ avd: string; serial: string }>,
  unattachedNames: string[]
): ReadinessCheck {
  const bindings = attachedAvds
    .filter(({ avd }) => configuredAvds.includes(avd))
    .map(({ avd, serial }) => `${avd}=${serial}`);
  return {
    detail: unattachedNames.length === 0
      ? `All configured AVDs are attached (${bindings.join(", ")}).`
      : `Configured AVDs not attached: ${unattachedNames.join(", ")}.`,
    id: "android.avds",
    remediation: unattachedNames.length === 0
      ? undefined
      : "Restore the emulator executable so the worker can cold-boot its missing AVDs.",
    status: unattachedNames.length === 0 ? "pass" : "fail"
  };
}

async function checkProvisioning(
  config: WorkerConfig,
  checks: ReadinessCheck[]
): Promise<void> {
  try {
    const provisioning = configuredAndroidProvisioning(config);
    if (!provisioning) {
      checks.push({
        detail: "Pinned APK provisioning is not configured; jobs may provision the app through their harness.",
        id: "android.apk.configuration",
        status: "pass"
      });
      return;
    }
    if (new URL(provisioning.url).protocol === "file:") {
      const apkPath = fileURLToPath(provisioning.url);
      if (!(await exists(apkPath))) {
        checks.push({
          detail: `Configured APK does not exist: ${apkPath}`,
          id: "android.apk.configuration",
          remediation: "Publish the pinned APK or update URIEL_ANDROID_APK_URL and its SHA-256 together.",
          status: "fail"
        });
        return;
      }
    }
    checks.push({
      detail: `Pinned APK configuration is valid for ${provisioning.packageName}.`,
      id: "android.apk.configuration",
      status: "pass"
    });
  } catch (error) {
    checks.push({
      detail: errorMessage(error),
      id: "android.apk.configuration",
      remediation: "Set URL, SHA-256, and package together, or remove all three provisioning variables.",
      status: "fail"
    });
  }
}

function missingToolCheck(
  tool: "adb" | "emulator",
  candidates: string[],
  configurationName: string
): ReadinessCheck {
  return {
    detail: `${tool} is not executable. Checked: ${candidates.length > 0 ? candidates.join(", ") : "no SDK roots or PATH entries"}.`,
    id: `android.${tool}.executable`,
    remediation: `Set ${configurationName} to a stable executable or repair ANDROID_SDK_ROOT/ANDROID_HOME.`,
    status: "fail"
  };
}

function finish(checks: ReadinessCheck[]): WorkerReadiness {
  const failed = checks.some((check) => check.status === "fail");
  const warned = checks.some((check) => check.status === "warn");
  return {
    checks,
    ok: !failed,
    service: "uriel-worker",
    status: failed ? "not-ready" : warned ? "degraded" : "ready"
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
