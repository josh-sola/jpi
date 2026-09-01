import { scheduleIds, SCHEDULES_CHANNEL } from "../../src/core/index.ts";
import type { EventBus } from "./helpers.ts";

export class ScheduleActivityMonitor {
  private unsubscribe?: () => void;
  private disposed = false;
  private events: EventBus;
  private setActive: (active: boolean) => void;

  constructor(events: EventBus, setActive: (active: boolean) => void) {
    this.events = events;
    this.setActive = setActive;
  }

  start(): void {
    this.unsubscribe = this.events.on(SCHEDULES_CHANNEL, (data) => this.apply(data));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
  }

  private apply(data: unknown): void {
    if (this.disposed) return;
    const ids = scheduleIds(data);
    if (ids === undefined) return;
    this.setActive(ids.size > 0);
  }
}
