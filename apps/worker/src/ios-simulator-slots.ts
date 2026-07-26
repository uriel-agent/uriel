export interface IosSimulatorSlotLease {
  release(): void;
  udid?: string;
}

type Waiter = (lease: IosSimulatorSlotLease) => void;
type Slot = { udid?: string };

/**
 * Assigns one iOS Simulator target to one job for the whole job lifetime.
 *
 * An empty UDID list becomes one implicit slot so jobs that select a simulator
 * by name, or use the sole booted simulator, cannot share it concurrently.
 */
export class IosSimulatorSlotPool {
  private readonly available: Slot[];
  private readonly waiters: Waiter[] = [];

  constructor(udids: string[]) {
    const uniqueUdids = [...new Set(udids)];
    this.available = uniqueUdids.length > 0
      ? uniqueUdids.map((udid) => ({ udid }))
      : [{}];
  }

  acquire(): Promise<IosSimulatorSlotLease> {
    const slot = this.available.shift();
    if (slot) {
      return Promise.resolve(this.createLease(slot));
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private createLease(slot: Slot): IosSimulatorSlotLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(this.createLease(slot));
          return;
        }
        this.available.push(slot);
      },
      udid: slot.udid
    };
  }
}
