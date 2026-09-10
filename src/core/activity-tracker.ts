import { isRecord } from "./guards.ts";
import { jpiBackgroundRunningIds, TASKS_CHANNEL } from "./bus-contracts.ts";
import type { EventBus } from "../pi/index.ts";

const GRACE_MS = 250;

export type ActivitySubagent = {
  id: string;
  state: "working";
  startedAt: number;
  agentType?: string;
  description?: string;
};

export type ActivitySnapshot = {
  state: "working" | "blocked" | "done";
  /** True only while "working" is caused solely by detached work: foreground idle, no prompt open. */
  monitoring: boolean;
  subagents: ActivitySubagent[];
};

export type Scheduler = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
};

export type ActivityTrackerDependencies = {
  events: EventBus;
  onChange: (snapshot: ActivitySnapshot) => void;
  now?: () => number;
  scheduler?: Scheduler;
};

export interface ActivityTracker {
  start(): void;
  setForeground(active: boolean): void;
  startPrompt(): void;
  endPrompt(): void;
  dispose(): void;
}

const defaultScheduler: Scheduler = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function subagent(data: unknown, now: () => number): ActivitySubagent | undefined {
  if (!isRecord(data) || typeof data.id !== "string" || !data.id) return undefined;
  const startedAt =
    typeof data.startedAt === "number" && Number.isFinite(data.startedAt) ? data.startedAt : now();
  return {
    id: data.id,
    state: "working",
    startedAt,
    ...(typeof data.type === "string" && data.type ? { agentType: data.type } : {}),
    ...(typeof data.description === "string" && data.description
      ? { description: data.description }
      : {}),
  };
}

function eventId(data: unknown): string | undefined {
  return isRecord(data) && typeof data.id === "string" && data.id ? data.id : undefined;
}

class ActivityTrackerImpl implements ActivityTracker {
  private unsubscribers: Array<() => void> = [];
  private subagents = new Map<string, ActivitySubagent>();
  private backgroundIds = new Set<string>();
  private foreground = false;
  private prompts = 0;
  private graceTimer: unknown;
  private lastSnapshot?: string;
  private disposed = false;

  constructor(
    private readonly dependencies: Required<
      Pick<ActivityTrackerDependencies, "events" | "onChange" | "now" | "scheduler">
    >,
  ) {}

  start(): void {
    this.unsubscribers = [
      this.dependencies.events.on("subagents:started", (data) => this.startSubagent(data)),
      this.dependencies.events.on("subagents:completed", (data) => this.finishSubagent(data)),
      this.dependencies.events.on("subagents:failed", (data) => this.finishSubagent(data)),
      this.dependencies.events.on(TASKS_CHANNEL, (data) => this.setBackground(data)),
    ];
    this.publish({ state: "done", monitoring: false, subagents: [] });
  }

  setForeground(active: boolean): void {
    if (this.disposed) return;
    if (active) this.cancelGrace();
    this.foreground = active;
    this.publishCurrent();
  }

  startPrompt(): void {
    if (this.disposed) return;
    this.cancelGrace();
    this.prompts += 1;
    this.publishCurrent();
  }

  endPrompt(): void {
    if (this.disposed) return;
    if (this.prompts > 0) this.prompts -= 1;
    this.publishCurrent();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelGrace();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }

  private startSubagent(data: unknown): void {
    if (this.disposed) return;
    const next = subagent(data, this.dependencies.now);
    if (!next || this.subagents.has(next.id)) return;
    this.cancelGrace();
    this.subagents.set(next.id, next);
    this.publishCurrent();
  }

  private finishSubagent(data: unknown): void {
    if (this.disposed) return;
    const id = eventId(data);
    if (!id || !this.subagents.has(id)) return;
    const hadDetached = this.hasDetached();
    this.subagents.delete(id);
    this.afterDetachedChange(hadDetached);
  }

  private setBackground(data: unknown): void {
    if (this.disposed) return;
    const ids = jpiBackgroundRunningIds(data);
    if (ids === undefined) return;
    const hadDetached = this.hasDetached();
    this.backgroundIds = ids;
    if (this.hasDetached()) this.cancelGrace();
    this.afterDetachedChange(hadDetached);
  }

  private afterDetachedChange(hadDetached: boolean): void {
    if (hadDetached && !this.hasDetached() && !this.foreground && this.prompts === 0) {
      this.graceTimer = this.dependencies.scheduler.setTimeout(() => {
        this.graceTimer = undefined;
        if (!this.disposed && !this.foreground && this.prompts === 0 && !this.hasDetached()) {
          this.publishCurrent();
        }
      }, GRACE_MS);
      return;
    }
    this.publishCurrent();
  }

  private cancelGrace(): void {
    if (this.graceTimer === undefined) return;
    this.dependencies.scheduler.clearTimeout(this.graceTimer);
    this.graceTimer = undefined;
  }

  private hasDetached(): boolean {
    return this.subagents.size > 0 || this.backgroundIds.size > 0;
  }

  private publishCurrent(): void {
    if (this.disposed || this.graceTimer !== undefined) return;
    const subagents = [...this.subagents.values()];
    if (this.prompts > 0) {
      this.publish({ state: "blocked", monitoring: false, subagents });
      return;
    }
    if (this.foreground) {
      this.publish({ state: "working", monitoring: false, subagents });
      return;
    }
    if (this.hasDetached()) {
      this.publish({ state: "working", monitoring: true, subagents });
      return;
    }
    this.publish({ state: "done", monitoring: false, subagents: [] });
  }

  private publish(snapshot: ActivitySnapshot): void {
    const encoded = JSON.stringify(snapshot);
    if (encoded === this.lastSnapshot) return;
    this.lastSnapshot = encoded;
    this.dependencies.onChange(snapshot);
  }
}

export function createActivityTracker(dependencies: ActivityTrackerDependencies): ActivityTracker {
  return new ActivityTrackerImpl({
    events: dependencies.events,
    onChange: dependencies.onChange,
    now: dependencies.now ?? Date.now,
    scheduler: dependencies.scheduler ?? defaultScheduler,
  });
}
