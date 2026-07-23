import { isRecord, type ValidationResult } from "./types.ts";

export const checkVerdicts = ["pass", "fail", "unsure", "skipped"] as const;
export type CheckVerdict = (typeof checkVerdicts)[number];
export const checkEvidenceRoles = ["setup", "action", "outcome", "diagnostic"] as const;
export type CheckEvidenceRole = (typeof checkEvidenceRoles)[number];

export interface CheckEvidence {
  artifact: string;
  description: string;
  role: CheckEvidenceRole;
}

export interface JobCheck {
  context?: string;
  id: string;
  text: string;
}

export interface CheckResult {
  artifacts?: string[];
  evidence?: CheckEvidence[];
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

    let evidence: CheckEvidence[] | undefined;
    if (Array.isArray(entry.evidence)) {
      evidence = [];
      for (const [evidenceIndex, item] of entry.evidence.slice(0, 20).entries()) {
        if (
          !isRecord(item) ||
          typeof item.artifact !== "string" ||
          item.artifact.trim().length === 0 ||
          typeof item.description !== "string" ||
          item.description.trim().length === 0 ||
          !checkEvidenceRoles.includes(item.role as CheckEvidenceRole)
        ) {
          warnings.push(`Dropped invalid evidence ${evidenceIndex} for check result "${id}".`);
          continue;
        }
        evidence.push({
          artifact: item.artifact,
          description: item.description.trim().slice(0, 500),
          role: item.role as CheckEvidenceRole
        });
      }
      if (entry.evidence.length > 20) {
        warnings.push(`Dropped excess evidence for check result "${id}".`);
      }
    } else if (entry.evidence !== undefined) {
      warnings.push(`Dropped invalid evidence for check result "${id}".`);
    }

    const referencedArtifacts = [
      ...(artifacts ?? []),
      ...(evidence ?? []).map((item) => item.artifact)
    ].filter((artifact, artifactIndex, allArtifacts) => allArtifacts.indexOf(artifact) === artifactIndex);

    parsedResults.set(id, {
      id,
      verdict,
      ...(notes !== undefined ? { notes } : {}),
      ...(artifacts !== undefined || evidence !== undefined
        ? { artifacts: referencedArtifacts.slice(0, 20) }
        : {}),
      ...(evidence !== undefined ? { evidence } : {})
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
    `- Evidence protocol, per check: capture the relevant setup state, the action when useful, and the resulting state. Name files "<check-id>-setup.png", "<check-id>-action.mp4", and "<check-id>-outcome.png" (add descriptive or numeric suffixes for materially distinct observations). Save everything under: ${evidenceDir}`,
    "- Keep recordings short (under 60 seconds each); a static state needs only a screenshot.",
    "- For every referenced artifact, provide a role and a concrete description of what a reviewer can see: setup (precondition only), action (interaction in progress), outcome (observed result), or diagnostic (logs/tests/supporting detail).",
    "- A setup capture never proves a pass by itself. A pass must reference at least one successfully captured outcome artifact. If the check makes several materially distinct claims, capture and describe evidence for each; otherwise use unsure.",
    `- When finished, write JSON to ${resultsPath} shaped as {"results":[{"id":"...","verdict":"...","notes":"...","evidence":[{"artifact":"file-name.png","role":"outcome","description":"What this artifact visibly proves"}]}]}`,
    "- Verdicts:",
    '  - "pass": you directly observed the described outcome and captured evidence showing it.',
    '  - "fail": you directly observed the outcome NOT holding; capture evidence of the failure.',
    '  - "unsure": you could not reach the required state, the outcome is subjective, or you have any doubt. Unsure is a first-class outcome that escalates to a human reviewer — never guess a pass.',
    '  - "skipped": the check does not apply to this job.',
    '- Scope guardrail: use ONLY the environment, credentials, and tooling this job\'s prompt explicitly provides or sanctions. Beyond that sanctioned scope, never read host credential stores or secret-manager CLIs (doppler, vault, aws, gcloud, op, keychain), env files outside the worktree, or tokens belonging to the host machine. If a check needs access you do not have, verdict it "unsure" and state exactly what is missing.',
    "- notes: 1-3 sentences on what you did and what you observed.",
    "- evidence: structured references to files you saved under the evidence directory. Artifact names are derived from this list for callback compatibility.",
    "",
    "Checks:",
    ...checks.flatMap((check) => [
      `- [${check.id}] ${check.text}`,
      ...(check.context !== undefined ? [`  Context: ${check.context}`] : [])
    ])
  ].join("\n");
}

export function enforceCheckResultEvidence(result: CheckResult): CheckResult {
  if (result.verdict !== "pass" || result.evidence?.some((item) => item.role === "outcome")) {
    return result;
  }

  const reason = "Reported pass was downgraded to unsure because no captured outcome evidence proved the result.";
  return {
    ...result,
    notes: result.notes?.trim() ? `${result.notes.trim()} ${reason}` : reason,
    verdict: "unsure"
  };
}

function missingResult(check: JobCheck): CheckResult {
  return {
    id: check.id,
    notes: "No result was reported for this check.",
    verdict: "unsure"
  };
}
