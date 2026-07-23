export interface ScheduledJob {
  id: string;
  run: () => Promise<void>;
}

export class JobScheduler {
  private active = 0;
  private readonly maxConcurrentJobs: number;
  private readonly pending: ScheduledJob[] = [];

  constructor(maxConcurrentJobs: number) {
    this.maxConcurrentJobs = Math.max(1, maxConcurrentJobs);
  }

  enqueue(job: ScheduledJob): void {
    this.pending.push(job);
    this.drain();
  }

  cancel(jobId: string): boolean {
    const index = this.pending.findIndex((job) => job.id === jobId);
    if (index === -1) {
      return false;
    }
    this.pending.splice(index, 1);
    return true;
  }

  snapshot(): { active: number; pending: string[] } {
    return {
      active: this.active,
      pending: this.pending.map((job) => job.id)
    };
  }

  private drain(): void {
    while (
      this.active < this.maxConcurrentJobs &&
      this.pending.length > 0
    ) {
      const job = this.pending.shift();
      if (!job) {
        return;
      }
      this.active += 1;
      void job
        .run()
        .catch((error) => {
          console.error(
            error instanceof Error ? error.stack ?? error.message : String(error)
          );
        })
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
