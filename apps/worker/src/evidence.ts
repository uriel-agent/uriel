import {
  createEvidenceManifest,
  createRepoContract,
  type Artifact,
  type EvidenceCommand,
  type Job,
  type RepoContract
} from "../../../packages/core/src/index.ts";
import type { JobReporter } from "./reporter.ts";
import type { CommandResult, RunCommandOptions } from "./shell.ts";

export class EvidenceRecorder {
  private commands: EvidenceCommand[] = [];
  private pullRequestUrl: string | undefined;
  private qaSummaries: string[] = [];
  private repoContract: RepoContract = createRepoContract();

  recordAgentsFile(path: string): void {
    this.repoContract = createRepoContract({
      ...this.repoContract,
      agentsFile: path
    });
  }

  recordFlake(): void {
    this.repoContract = createRepoContract({
      ...this.repoContract,
      hasFlake: true
    });
  }

  recordJustfile(recipes: string[]): void {
    this.repoContract = createRepoContract({
      ...this.repoContract,
      hasJustfile: true,
      justRecipes: recipes
    });
  }

  recordCommand(
    command: string,
    args: string[],
    result: CommandResult,
    options: RunCommandOptions = {}
  ): void {
    this.commands.push({
      args,
      command,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      durationMs: result.durationMs,
      exitCode: result.code,
      ...(result.stderr ? { stderrTail: tail(result.stderr) } : {}),
      ...(result.stdout ? { stdoutTail: tail(result.stdout) } : {})
    });
  }

  recordPullRequest(url: string): void {
    this.pullRequestUrl = url;
  }

  recordQaSummary(summary: string): void {
    this.qaSummaries.push(summary);
  }

  async write(
    job: Job,
    artifacts: Artifact[],
    reporter: JobReporter,
    summary: string
  ): Promise<void> {
    const manifest = createEvidenceManifest({
      artifacts,
      ...(job.checks?.length
        ? {
            checks: {
              requested: job.checks,
              results: job.checkResults ?? []
            }
          }
        : {}),
      commands: this.commands,
      job,
      ...(this.pullRequestUrl ? { pullRequest: { url: this.pullRequestUrl } } : {}),
      qaSummaries: this.qaSummaries,
      repoContract: this.repoContract,
      summary
    });
    await reporter.uploadArtifact(
      "evidence.json",
      JSON.stringify(manifest, null, 2),
      "application/json"
    );
  }
}

function tail(value: string): string {
  return value.slice(-4000);
}
