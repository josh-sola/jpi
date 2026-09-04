import { ActivityTitle, type TitleMode } from "./activity.ts";
import { BackgroundActivityMonitor } from "./background.ts";
import {
  loadWorktreeName,
  sessionIndicator,
  type EventBus,
  type ExecCommand,
  type Scheduler,
} from "./helpers.ts";
import { JpiBackgroundActivityMonitor } from "./jpi-background.ts";
import { ScheduleActivityMonitor } from "./schedule.ts";

const LEGACY_BACKGROUND_PROVIDER = "pi-background-tasks";
const JPI_BACKGROUND_PROVIDER = "jpi-background";

// tmux drops one of two renames landing in the same ~500ms throttle window
// (see helpers.ts), so re-assert a couple more times to win the race against
// core's post-session_start title write.
const STARTUP_REASSERT_DELAYS_MS = [600, 1200];

export type TitleContext = {
  mode: string;
  cwd: string;
  ui: { setTitle(title: string): void };
};

type Dependencies = {
  exec: ExecCommand;
  events: EventBus;
  getSessionName(): string | undefined;
  scheduler: Scheduler;
  createRequestId(): string;
  generation: number;
  mode: TitleMode;
};

function eventId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const id = (data as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : undefined;
}

export class TitleController {
  private worktreeName?: string | undefined;
  private unsubscribers: Array<() => void> = [];
  private startupTimers: unknown[] = [];
  private worktreeLookup = new AbortController();
  private disposed = false;
  private activity: ActivityTitle;
  private background: BackgroundActivityMonitor;
  private jpiBackground: JpiBackgroundActivityMonitor;
  private schedule: ScheduleActivityMonitor;
  private dependencies: Dependencies;
  private context: TitleContext;

  constructor(dependencies: Dependencies, context: TitleContext) {
    this.dependencies = dependencies;
    this.context = context;
    this.activity = new ActivityTitle(
      dependencies.scheduler,
      () => sessionIndicator(dependencies.getSessionName(), this.worktreeName, context.cwd),
      (title) => context.ui.setTitle(title),
      dependencies.mode,
    );
    this.background = new BackgroundActivityMonitor(
      dependencies.events,
      dependencies.scheduler,
      dependencies.generation,
      dependencies.createRequestId,
      (active) => this.activity.setBackgroundProvider(LEGACY_BACKGROUND_PROVIDER, active),
    );
    this.jpiBackground = new JpiBackgroundActivityMonitor(dependencies.events, (active) =>
      this.activity.setBackgroundProvider(JPI_BACKGROUND_PROVIDER, active),
    );
    this.schedule = new ScheduleActivityMonitor(dependencies.events, (active) =>
      this.activity.setScheduleActive(active),
    );
  }

  async start(): Promise<void> {
    this.unsubscribers = [
      this.dependencies.events.on("subagents:started", (data) => {
        const id = eventId(data);
        if (id) this.activity.startSubagent(id);
      }),
      this.dependencies.events.on("subagents:completed", (data) => {
        const id = eventId(data);
        if (id) this.activity.finishSubagent(id);
      }),
      this.dependencies.events.on("subagents:failed", (data) => {
        const id = eventId(data);
        if (id) this.activity.finishSubagent(id);
      }),
    ];
    this.background.start();
    this.jpiBackground.start();
    this.schedule.start();
    const name = await loadWorktreeName(
      this.dependencies.exec,
      this.context.cwd,
      this.worktreeLookup.signal,
    );
    if (this.disposed) return;
    this.worktreeName = name;

    // Core restores its title after awaited session_start handlers, so render next turn.
    this.scheduleReassert(0);
    for (const delay of STARTUP_REASSERT_DELAYS_MS) this.scheduleReassert(delay);
  }

  setMainActive(active: boolean): void {
    this.activity.setMain(active);
  }

  startUiPrompt(): void {
    this.activity.startPrompt();
  }

  endUiPrompt(): void {
    this.activity.endPrompt();
  }

  refreshName(): void {
    this.activity.refresh();
  }

  shutdown(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.worktreeLookup.abort();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.background.dispose();
    this.jpiBackground.dispose();
    this.schedule.dispose();
    for (const timer of this.startupTimers) this.dependencies.scheduler.clearTimeout(timer);
    this.startupTimers = [];
    this.activity.shutdown();
  }

  private scheduleReassert(delay: number): void {
    const timer = this.dependencies.scheduler.setTimeout(() => {
      this.startupTimers = this.startupTimers.filter((entry) => entry !== timer);
      if (!this.disposed) this.activity.refresh();
    }, delay);
    this.startupTimers.push(timer);
  }
}
