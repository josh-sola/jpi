import { jpiBackgroundRunningIds, TASKS_CHANNEL } from "../../src/core/index.ts";
import type { EventBus } from "../../src/pi/index.ts";

export class JpiBackgroundActivityMonitor {
  private unsubscribe?: () => void;
  private disposed = false;
  private events: EventBus;
  private setActive: (active: boolean) => void;

  constructor(events: EventBus, setActive: (active: boolean) => void) {
    this.events = events;
    this.setActive = setActive;
  }

  start(): void {
    this.unsubscribe = this.events.on(TASKS_CHANNEL, (data) => this.apply(data));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
  }

  private apply(data: unknown): void {
    if (this.disposed) return;
    const ids = jpiBackgroundRunningIds(data);
    if (ids === undefined) return;
    this.setActive(ids.size > 0);
  }
}
