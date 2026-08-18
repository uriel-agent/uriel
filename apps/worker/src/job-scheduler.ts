interface PendingJob {
  jobId: string;
  run(signal: AbortSignal): Promise<void>;
}

export type SchedulerCancellation = "active" | "queued" | false;

export interface SchedulerAdmissionContext {
  activeJobs: number;
  jobId: string;
  queuedJobs: number;
}

export interface SchedulerAdmissionDecision {
  admitted: boolean;
  reason?: string;
  state?: unknown;
}

export interface JobSchedulerOptions {
  admission?: (
    context: SchedulerAdmissionContext
  ) => Promise<SchedulerAdmissionDecision>;
  onBlocked?: (
    jobId: string,
    decision: SchedulerAdmissionDecision
  ) => Promise<void> | void;
  onUnblocked?: (
    jobId: string,
    decision: SchedulerAdmissionDecision
  ) => Promise<void> | void;
  retryDelayMs?: number;
}

export interface JobSchedulerState {
  activeJobs: number;
  blocked?: { jobId: string; reason: string };
  queuedJobs: number;
}

export class JobScheduler {
  private active = 0;
  private blocked?: { jobId: string; reason: string };
  private draining = false;
  private readonly pending: PendingJob[] = [];
  private readonly activeControllers = new Map<string, AbortController>();
  private retryTimer?: NodeJS.Timeout;
  private wakeRequested = false;

  constructor(
    private readonly maxConcurrentJobs: number,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly options: JobSchedulerOptions = {}
  ) {}

  enqueue(jobId: string, run: (signal: AbortSignal) => Promise<void>): void {
    this.pending.push({ jobId, run });
    this.drain();
  }

  cancel(jobId: string): SchedulerCancellation {
    const index = this.pending.findIndex((job) => job.jobId === jobId);
    if (index !== -1) {
      this.pending.splice(index, 1);
      if (this.blocked?.jobId === jobId) this.blocked = undefined;
      this.drain();
      return "queued";
    }
    const controller = this.activeControllers.get(jobId);
    if (!controller) return false;
    controller.abort();
    return "active";
  }

  state(): JobSchedulerState {
    return {
      activeJobs: this.active,
      ...(this.blocked ? { blocked: this.blocked } : {}),
      queuedJobs: this.pending.length
    };
  }

  wake(): void {
    this.wakeRequested = true;
    this.blocked = undefined;
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drainReady()
      .catch(this.onError)
      .finally(() => {
        this.draining = false;
        if (this.wakeRequested) {
          this.wakeRequested = false;
          this.blocked = undefined;
        }
        if (!this.blocked && this.active < this.maxConcurrentJobs && this.pending.length > 0) {
          this.drain();
        }
      });
  }

  private async drainReady(): Promise<void> {
    while (this.active < this.maxConcurrentJobs && this.pending.length > 0) {
      const job = this.pending[0];
      if (!job) return;
      const decision = await this.admissionDecision(job);
      if (this.pending[0] !== job) continue;
      if (!decision.admitted) {
        const reason = decision.reason ?? "host capacity is temporarily unavailable";
        if (this.blocked?.jobId !== job.jobId || this.blocked.reason !== reason) {
          this.blocked = { jobId: job.jobId, reason };
          this.scheduleRetry();
          await this.notify(() => this.options.onBlocked?.(job.jobId, decision));
        }
        this.scheduleRetry();
        return;
      }
      if (this.blocked?.jobId === job.jobId) {
        this.blocked = undefined;
        await this.notify(() => this.options.onUnblocked?.(job.jobId, decision));
      }
      this.pending.shift();
      this.active += 1;
      const controller = new AbortController();
      this.activeControllers.set(job.jobId, controller);
      void job.run(controller.signal)
        .catch(this.onError)
        .finally(() => {
          this.activeControllers.delete(job.jobId);
          this.active -= 1;
          this.drain();
        });
    }
  }

  private async admissionDecision(job: PendingJob): Promise<SchedulerAdmissionDecision> {
    try {
      return await (this.options.admission?.({
        activeJobs: this.active,
        jobId: job.jobId,
        queuedJobs: this.pending.length
      }) ?? Promise.resolve({ admitted: true }));
    } catch (error) {
      return {
        admitted: false,
        reason: `capacity admission check failed: ${errorMessage(error)}`
      };
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.drain();
    }, this.options.retryDelayMs ?? 15_000);
    this.retryTimer.unref();
  }

  private async notify(callback: () => Promise<void> | void | undefined): Promise<void> {
    try {
      await callback();
    } catch (error) {
      this.onError(error);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
