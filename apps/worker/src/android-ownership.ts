import type { WorkerConfig } from "./config.ts";

const INTERACTIVE_AVD_PREFIX = "dungeonqa_pool_";

type AndroidOwnershipConfig = Pick<
  WorkerConfig,
  "androidAvdPrefix" | "androidAvds" | "enableAndroidQa"
>;

export function androidAvdOwnershipErrors(config: AndroidOwnershipConfig): string[] {
  if (!config.enableAndroidQa) return [];

  const errors: string[] = [];
  if (!/^[A-Za-z][A-Za-z0-9._-]*$/u.test(config.androidAvdPrefix)) {
    errors.push("URIEL_ANDROID_AVD_PREFIX must be a non-empty AVD-safe prefix.");
  }
  if (config.androidAvdPrefix.startsWith(INTERACTIVE_AVD_PREFIX)) {
    errors.push(`${INTERACTIVE_AVD_PREFIX}* is reserved for interactive developer QA.`);
  }
  if (config.androidAvds.length === 0) {
    errors.push("Android QA requires at least one dedicated AVD in URIEL_ANDROID_AVDS.");
  }
  for (const avd of [...new Set(config.androidAvds)]) {
    if (avd.startsWith(INTERACTIVE_AVD_PREFIX)) {
      errors.push(
        `AVD ${avd} belongs to the interactive developer pool and cannot be leased by Uriel.`
      );
    } else if (!avd.startsWith(config.androidAvdPrefix)) {
      errors.push(`AVD ${avd} is not worker-owned; expected prefix ${config.androidAvdPrefix}.`);
    }
  }
  return errors;
}

export function isWorkerOwnedAndroidAvd(
  config: AndroidOwnershipConfig,
  avd: string
): boolean {
  return !avd.startsWith(INTERACTIVE_AVD_PREFIX) &&
    avd.startsWith(config.androidAvdPrefix) &&
    config.androidAvds.includes(avd);
}
