import { isRecord, type ValidationResult } from "./types.ts";

export const checkVerdicts = ["pass", "fail", "unsure", "skipped"] as const;
export type CheckVerdict = (typeof checkVerdicts)[number];

export interface JobCheck {
  context?: string;
  id: string;
  text: string;
}

export interface CheckResult {
  artifacts?: string[];
  id: string;
  notes?: string;
  verdict: CheckVerdict;
}

export function validateJobChecks(input: unknown): ValidationResult<JobCheck[]> {
  if (!Array.isArray(input)) {
    return { ok: false, error: "checks must be an array." };
  }
  if (input.length < 1 || input.length > 100) {
    return { ok: false, error: "checks must contain between 1 and 100 entries." };
  }

  const checks: JobCheck[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of input.entries()) {
    if (!isRecord(entry)) {
      return { ok: false, error: `checks[${index}] must be an object.` };
    }

    const id = entry.id;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(id)) {
      return {
        ok: false,
        error: `checks[${index}].id must be 1 to 64 letters, numbers, periods, underscores, or hyphens and start with a letter or number.`
      };
    }
    if (ids.has(id)) {
      return { ok: false, error: `checks contains duplicate id "${id}".` };
    }

    const text = entry.text;
    if (typeof text !== "string" || text.trim().length === 0 || text.length > 2000) {
      return {
        ok: false,
        error: `checks[${index}].text must be a non-empty string no longer than 2000 characters.`
      };
    }

    const context = entry.context;
    if (context !== undefined && (typeof context !== "string" || context.length > 4000)) {
      return {
        ok: false,
        error: `checks[${index}].context must be a string no longer than 4000 characters.`
      };
    }

    ids.add(id);
    checks.push({
      id,
      text,
      ...(typeof context === "string" ? { context } : {})
    });
  }

  return { ok: true, value: checks };
}

export function parseCheckResults(
  raw: string,
  checks: JobCheck[]
): { results: CheckResult[]; warnings: string[] } {
  let entries: unknown[];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      entries = parsed;
    } else if (isRecord(parsed) && Array.isArray(parsed.results)) {
      entries = parsed.results;
    } else {
      throw new Error("Invalid check results shape.");
    }
  } catch {
    return {
      results: checks.map(missingResult),
      warnings: ["Could not parse check results JSON; all checks were marked unsure."]
    };
  }

  const checkIds = new Set(checks.map((check) => check.id));
  const parsedResults = new Map<string, CheckResult>();
  const warnings: string[] = [];
  for (const [index, entry] of entries.entries()) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !checkIds.has(entry.id)) {
      const id = isRecord(entry) && typeof entry.id === "string" ? entry.id : `(entry ${index})`;
      warnings.push(`Dropped check result with unknown id "${id}".`);
      continue;
    }

    const id = entry.id;
    const verdict = checkVerdicts.includes(entry.verdict as CheckVerdict)
      ? (entry.verdict as CheckVerdict)
      : "unsure";
    if (verdict === "unsure" && entry.verdict !== "unsure") {
      warnings.push(`Check result "${id}" had an invalid verdict and was marked unsure.`);
    }

    let notes: string | undefined;
    if (typeof entry.notes === "string") {
      notes = entry.notes.slice(0, 4000);
      if (entry.notes.length > 4000) {
        warnings.push(`Truncated notes for check result "${id}" to 4000 characters.`);
      }
    } else if (entry.notes !== undefined) {
      warnings.push(`Dropped non-string notes for check result "${id}".`);
    }

    let artifacts: string[] | undefined;
    if (Array.isArray(entry.artifacts)) {
      artifacts = entry.artifacts
        .filter((artifact): artifact is string => typeof artifact === "string")
        .slice(0, 20);
      if (artifacts.length !== entry.artifacts.length) {
        warnings.push(`Dropped invalid or excess artifacts for check result "${id}".`);
      }
    } else if (entry.artifacts !== undefined) {
      warnings.push(`Dropped invalid artifacts for check result "${id}".`);
    }

    parsedResults.set(id, {
      id,
      verdict,
      ...(notes !== undefined ? { notes } : {}),
      ...(artifacts !== undefined ? { artifacts } : {})
    });
  }

  return {
    results: checks.map((check) => parsedResults.get(check.id) ?? missingResult(check)),
    warnings
  };
}

export function buildChecksPromptSection(
  checks: JobCheck[],
  resultsPath: string,
  evidenceDir: string
): string {
  return [
    "## Verification checks",
    "",
    `This job includes ${checks.length} verification check(s). For each check, exercise the application or repository as needed, capture evidence, and record a verdict.`,
    "",
    `- Evidence protocol, per check: capture a screenshot of the relevant state BEFORE exercising the flow, a screen recording WHILE exercising it, and a screenshot of the resulting state AFTER. Name files "<check-id>-before.png", "<check-id>-during.mp4", "<check-id>-after.png" (add numeric suffixes for extras). Save everything under: ${evidenceDir}`,
    "- Keep recordings short (under 60 seconds each); a static state needs only a screenshot.",
    `- When finished, write JSON to ${resultsPath} shaped as {"results":[{"id":"...","verdict":"...","notes":"...","artifacts":["file-name.png"]}]}`,
    "- Verdicts:",
    '  - "pass": you directly observed the described outcome and captured evidence showing it.',
    '  - "fail": you directly observed the outcome NOT holding; capture evidence of the failure.',
    '  - "unsure": you could not reach the required state, the outcome is subjective, or you have any doubt. Unsure is a first-class outcome that escalates to a human reviewer — never guess a pass.',
    '  - "skipped": the check does not apply to this job.',
    '- Scope guardrail: use ONLY the environment and credentials this job explicitly provides. Never read host credential stores or secret-manager CLIs (doppler, vault, aws, gcloud, op, keychain), env files outside the worktree, or tokens belonging to the host machine. If a check needs access you do not have, verdict it "unsure" and state exactly what is missing.',
    "- notes: 1-3 sentences on what you did and what you observed.",
    "- artifacts: names of files you saved under the evidence directory that support the verdict.",
    "",
    "Checks:",
    ...checks.flatMap((check) => [
      `- [${check.id}] ${check.text}`,
      ...(check.context !== undefined ? [`  Context: ${check.context}`] : [])
    ])
  ].join("\n");
}

function missingResult(check: JobCheck): CheckResult {
  return {
    id: check.id,
    notes: "No result was reported for this check.",
    verdict: "unsure"
  };
}
