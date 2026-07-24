interface PendingJob {
  jobId: string;
  run(): Promise<void>;
}

export class JobScheduler {
  private active = 0;
  private readonly pending: PendingJob[] = [];

  constructor(
    private readonly maxConcurrentJobs: number,
    private readonly onError: (error: unknown) => void = () => undefined
  ) {}

  enqueue(jobId: string, run: () => Promise<void>): void {
    this.pending.push({ jobId, run });
    this.drain();
  }

  cancel(jobId: string): boolean {
    const index = this.pending.findIndex((job) => job.jobId === jobId);
    if (index === -1) return false;
    this.pending.splice(index, 1);
    return true;
  }

  private drain(): void {
    while (this.active < this.maxConcurrentJobs && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) return;
      this.active += 1;
      void job.run()
        .catch(this.onError)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
