import { describe, expect, it } from "vitest";

import { loadConfig } from "../apps/worker/src/config.ts";

describe("worker config", () => {
  it("parses framework knobs from environment", () => {
    const config = loadConfig({
      URIEL_ALLOWED_REPOS: "uriel-agent/uriel,https://github.com/acme/app",
      URIEL_CALLBACK_SECRET: "callback-secret",
      URIEL_ENABLE_ANDROID_QA: "false",
      URIEL_ENABLE_BROWSER_QA: "false",
      URIEL_MAX_CONCURRENT_JOBS: "3",
      URIEL_STATE_DIR: "/tmp/uriel"
    });

    expect(config.allowedRepos).toEqual([
      "uriel-agent/uriel",
      "https://github.com/acme/app"
    ]);
    expect(config.callbackSecret).toBe("callback-secret");
    expect(config.enableAndroidQa).toBe(false);
    expect(config.enableBrowserQa).toBe(false);
    expect(config.maxConcurrentJobs).toBe(3);
  });

  it("parses harness knobs from environment", () => {
    const config = loadConfig({
      URIEL_ADAPTER_HARNESS: "claude-code",
      URIEL_CLAUDE_MODEL: "claude-opus-4-5",
      URIEL_CODEX_EFFORT: "high",
      URIEL_CODEX_MODEL: "gpt-5.6-sol"
    });

    expect(config.harnessAdapter).toBe("claude-code");
    expect(config.claudeModel).toBe("claude-opus-4-5");
    expect(config.codexEffort).toBe("high");
    expect(config.codexModel).toBe("gpt-5.6-sol");
  });
});
