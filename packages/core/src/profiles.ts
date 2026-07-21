import type { CreateJobRequest, RepoProfile } from "./types.ts";

export interface GitHubRepoRef {
  name: string;
  owner: string;
  slug: string;
}

export interface ProfileRule {
  id: RepoProfile;
  owner?: string;
  repo?: string;
}

export const genericProfileId = "generic";

export function parseGitHubRepo(input: string): GitHubRepoRef | undefined {
  const trimmed = input.trim().replace(/\.git$/u, "");
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/u.exec(trimmed);
  if (https) {
    const owner = https[1];
    const name = https[2];
    if (owner && name) {
      return { owner, name, slug: `${owner}/${name}` };
    }
  }

  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+)$/u.exec(trimmed);
  if (ssh) {
    const owner = ssh[1];
    const name = ssh[2];
    if (owner && name) {
      return { owner, name, slug: `${owner}/${name}` };
    }
  }

  return undefined;
}

export function detectRepoProfile(
  repo: string,
  rules: readonly ProfileRule[] = []
): RepoProfile {
  const parsed = parseGitHubRepo(repo);
  if (!parsed) {
    return genericProfileId;
  }

  const match = rules.find((rule) => {
    const ownerMatches =
      !rule.owner || rule.owner.toLowerCase() === parsed.owner.toLowerCase();
    const repoMatches =
      !rule.repo || rule.repo.toLowerCase() === parsed.name.toLowerCase();
    return ownerMatches && repoMatches;
  });

  return match?.id ?? genericProfileId;
}

export function buildBranchName(
  request: Pick<CreateJobRequest, "issue" | "prompt" | "repo">,
  uniqueSuffix?: string
): string {
  const issuePrefix = request.issue ? slugify(request.issue) : undefined;
  const taskSlug = slugify(request.prompt).split("-").slice(0, 6).join("-");
  const fallback = slugify(parseGitHubRepo(request.repo)?.name ?? "task");
  const parts = [issuePrefix, taskSlug || fallback].filter(Boolean);
  const suffix = uniqueSuffix ? `-${slugify(uniqueSuffix)}` : "";
  return `codex/${parts.join("-")}`.slice(0, 120 - suffix.length) + suffix;
}

export function worktreeSlug(branchName: string): string {
  return branchName.replace(/^codex\//u, "").replace(/[^a-z0-9._-]+/giu, "-");
}

export function repoCacheKey(repo: string): string {
  const parsed = parseGitHubRepo(repo);
  if (parsed) {
    return `${slugify(parsed.owner)}-${slugify(parsed.name)}`;
  }
  return slugify(repo).slice(0, 120);
}

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
}
