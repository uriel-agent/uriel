import { describe, expect, it } from "vitest";

import {
  buildChecksPromptSection,
  parseCheckResults,
  validateJobChecks,
  type JobCheck
} from "../packages/core/src/index.ts";

const checks: JobCheck[] = [
  { id: "login.visible", text: "The login form is visible." },
  {
    context: "Use a signed-out session.",
    id: "login.submit",
    text: "The login form can be submitted."
  }
];

describe("job check validation", () => {
  it("accepts valid checks", () => {
    expect(validateJobChecks(checks)).toEqual({ ok: true, value: checks });
  });

  it("rejects duplicate ids", () => {
    expect(
      validateJobChecks([
        { id: "same", text: "First" },
        { id: "same", text: "Second" }
      ]).ok
    ).toBe(false);
  });

  it("rejects invalid id characters", () => {
    expect(validateJobChecks([{ id: "bad id", text: "Invalid" }]).ok).toBe(false);
  });

  it("rejects more than 100 checks", () => {
    expect(
      validateJobChecks(
        Array.from({ length: 101 }, (_, index) => ({
          id: `check-${index}`,
          text: "Check it"
        }))
      ).ok
    ).toBe(false);
  });

  it("rejects empty text", () => {
    expect(validateJobChecks([{ id: "empty", text: "  " }]).ok).toBe(false);
  });
});

describe("check result parsing", () => {
  it("parses wrapped results", () => {
    const parsed = parseCheckResults(
      JSON.stringify({
        results: [
          { artifacts: ["login.png"], id: "login.visible", notes: "Seen", verdict: "pass" },
          { id: "login.submit", verdict: "fail" }
        ]
      }),
      checks
    );
    expect(parsed.results).toEqual([
      {
        artifacts: ["login.png"],
        id: "login.visible",
        notes: "Seen",
        verdict: "pass"
      },
      { id: "login.submit", verdict: "fail" }
    ]);
    expect(parsed.warnings).toEqual([]);
  });

  it("accepts a bare array", () => {
    const parsed = parseCheckResults(
      JSON.stringify([{ id: "login.visible", verdict: "skipped" }]),
      checks.slice(0, 1)
    );
    expect(parsed.results[0]?.verdict).toBe("skipped");
  });

  it("drops unknown ids with a warning", () => {
    const parsed = parseCheckResults(
      JSON.stringify([{ id: "unknown", verdict: "pass" }]),
      checks
    );
    expect(parsed.warnings[0]).toContain("unknown");
    expect(parsed.results.every((result) => result.verdict === "unsure")).toBe(true);
  });

  it("fills missing checks with unsure", () => {
    const parsed = parseCheckResults(
      JSON.stringify([{ id: "login.visible", verdict: "pass" }]),
      checks
    );
    expect(parsed.results[1]).toEqual({
      id: "login.submit",
      notes: "No result was reported for this check.",
      verdict: "unsure"
    });
  });

  it("turns invalid verdicts into unsure with a warning", () => {
    const parsed = parseCheckResults(
      JSON.stringify([{ id: "login.visible", verdict: "maybe" }]),
      checks.slice(0, 1)
    );
    expect(parsed.results[0]?.verdict).toBe("unsure");
    expect(parsed.warnings[0]).toContain("invalid verdict");
  });

  it("turns non-JSON input into unsure results", () => {
    const parsed = parseCheckResults("not json", checks);
    expect(parsed.results.every((result) => result.verdict === "unsure")).toBe(true);
    expect(parsed.warnings).toHaveLength(1);
  });

  it("drops non-string artifacts", () => {
    const parsed = parseCheckResults(
      JSON.stringify([
        { artifacts: ["evidence.png", 7, null], id: "login.visible", verdict: "pass" }
      ]),
      checks.slice(0, 1)
    );
    expect(parsed.results[0]?.artifacts).toEqual(["evidence.png"]);
  });

  it("orders output by the requested checks", () => {
    const parsed = parseCheckResults(
      JSON.stringify([
        { id: "login.submit", verdict: "fail" },
        { id: "login.visible", verdict: "pass" }
      ]),
      checks
    );
    expect(parsed.results.map((result) => result.id)).toEqual([
      "login.visible",
      "login.submit"
    ]);
  });
});

describe("verification prompt", () => {
  it("contains the checks and output locations", () => {
    const prompt = buildChecksPromptSection(
      checks,
      "/artifacts/check-results.json",
      "/artifacts"
    );
    expect(prompt).toContain("[login.visible]");
    expect(prompt).toContain("[login.submit]");
    expect(prompt).toContain("/artifacts/check-results.json");
    expect(prompt).toContain("/artifacts");
    expect(prompt).toContain("never guess a pass");
  });
});
