export interface WatchdogSnapshot {
  consecutiveDegraded: number;
  lastAlertAt?: string;
  lastProbeAt?: string;
  lastRecordError?: string;
  lastRecoveryAt?: string;
  lastStatus?: "degraded" | "not-ready" | "ready";
  running: boolean;
}

export interface WatchdogProbe {
  actionable: boolean;
  causes: string[];
  excludedReason?: string;
  status: "degraded" | "not-ready" | "ready";
}

export interface ReadinessWatchdogOptions {
  alert(probe: WatchdogProbe): Promise<void>;
  cooldownMs: number;
  intervalMs: number;
  probe(): Promise<WatchdogProbe>;
  record?(probe: WatchdogProbe, at: string): Promise<void>;
  recover(probe: WatchdogProbe): Promise<void>;
  threshold: number;
}

export class ReadinessWatchdog {
  private consecutiveDegraded = 0;
  private lastAlertAt?: string;
  private lastProbeAt?: string;
  private lastRecordError?: string;
  private lastRecoveryAt?: string;
  private lastStatus?: WatchdogProbe["status"];
  private running = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: ReadinessWatchdogOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(reportError), this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  snapshot(): WatchdogSnapshot {
    return {
      consecutiveDegraded: this.consecutiveDegraded,
      ...(this.lastAlertAt ? { lastAlertAt: this.lastAlertAt } : {}),
      ...(this.lastProbeAt ? { lastProbeAt: this.lastProbeAt } : {}),
      ...(this.lastRecordError ? { lastRecordError: this.lastRecordError } : {}),
      ...(this.lastRecoveryAt ? { lastRecoveryAt: this.lastRecoveryAt } : {}),
      ...(this.lastStatus ? { lastStatus: this.lastStatus } : {}),
      running: Boolean(this.timer)
    };
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const probe = await this.options.probe();
      this.lastProbeAt = new Date(now).toISOString();
      this.lastStatus = probe.status;
      await this.record(probe, this.lastProbeAt);
      if (probe.status === "ready") {
        this.consecutiveDegraded = 0;
        return;
      }
      this.consecutiveDegraded += 1;
      if (!probe.actionable || this.consecutiveDegraded < this.options.threshold) return;
      const lastRecovery = this.lastRecoveryAt ? Date.parse(this.lastRecoveryAt) : 0;
      if (this.lastRecoveryAt && now - lastRecovery < this.options.cooldownMs) return;
      await this.options.recover(probe);
      this.lastRecoveryAt = new Date(now).toISOString();
      const afterRecovery = await this.options.probe();
      const afterRecoveryAt = new Date(Math.max(now + 1, Date.now())).toISOString();
      this.lastProbeAt = afterRecoveryAt;
      this.lastStatus = afterRecovery.status;
      await this.record(afterRecovery, afterRecoveryAt);
      if (afterRecovery.status === "ready") {
        this.consecutiveDegraded = 0;
        return;
      }
      if (!afterRecovery.actionable) return;
      await this.options.alert(afterRecovery);
      this.lastAlertAt = new Date(now).toISOString();
    } finally {
      this.running = false;
    }
  }

  private async record(probe: WatchdogProbe, at: string): Promise<void> {
    if (!this.options.record) return;
    try {
      await this.options.record(probe, at);
      this.lastRecordError = undefined;
    } catch (error) {
      this.lastRecordError = error instanceof Error ? error.message : String(error);
      reportError(error);
    }
  }
}

function reportError(error: unknown): void {
  console.error(`Readiness watchdog failed: ${error instanceof Error ? error.message : String(error)}`);
}
