export interface AndroidSlotLease {
  avd?: string;
  release(): void;
}

type Waiter = (lease: AndroidSlotLease) => void;
type Slot = { avd?: string };

/**
 * Assigns one Android target to one job for the whole job lifetime.
 *
 * An empty AVD list deliberately becomes one attached-device slot. This keeps
 * backwards compatibility while preventing concurrent jobs from sharing an
 * implicitly selected adb device.
 */
export class AndroidSlotPool {
  private readonly available: Slot[];
  private readonly waiters: Waiter[] = [];

  constructor(avds: string[]) {
    const uniqueAvds = [...new Set(avds)];
    this.available = uniqueAvds.length > 0
      ? uniqueAvds.map((avd) => ({ avd }))
      : [{}];
  }

  acquire(): Promise<AndroidSlotLease> {
    const slot = this.available.shift();
    if (slot) {
      return Promise.resolve(this.createLease(slot));
    }

    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
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
