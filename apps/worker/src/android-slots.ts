export interface AndroidSlotLease {
  avd?: string;
  release(): void;
}

export interface AndroidSlotState {
  available: number;
  leased: number;
  total: number;
  waiting: number;
}

type Waiter = (lease: AndroidSlotLease) => void;
type Slot = { avd?: string };

/**
 * Assigns one Android target to one job for the whole job lifetime.
 *
 * An empty AVD list has no capacity. Uriel never creates an implicit attached-
 * device slot because that could bind a physical or interactive QA device.
 */
export class AndroidSlotPool {
  private readonly available: Slot[];
  private readonly slotCount: number;
  private readonly waiters: Waiter[] = [];

  constructor(avds: string[]) {
    const uniqueAvds = [...new Set(avds)];
    this.available = uniqueAvds.map((avd) => ({ avd }));
    this.slotCount = this.available.length;
  }

  acquire(): Promise<AndroidSlotLease> {
    if (this.slotCount === 0) {
      return Promise.reject(
        new Error("Android QA has no dedicated worker-owned AVD slots configured.")
      );
    }
    const slot = this.available.shift();
    if (slot) {
      return Promise.resolve(this.createLease(slot));
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  state(): AndroidSlotState {
    return {
      available: this.available.length,
      leased: this.slotCount - this.available.length,
      total: this.slotCount,
      waiting: this.waiters.length
    };
  }

  private createLease(slot: Slot): AndroidSlotLease {
    let released = false;
    return {
      avd: slot.avd,
      release: () => {
        if (released) return;
        released = true;
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(this.createLease(slot));
          return;
        }
        this.available.push(slot);
      }
    };
  }
}
