import { ActivityTitle } from "./activity.ts";
import { BackgroundActivityMonitor } from "./background.ts";
import {
  loadWorktreeName,
  sessionIndicator,
  type EventBus,
  type ExecCommand,
  type Scheduler,
} from "./helpers.ts";
import { JpiBackgroundActivityMonitor } from "./jpi-background.ts";

const LEGACY_BACKGROUND_PROVIDER = "pi-background-tasks";
const JPI_BACKGROUND_PROVIDER = "jpi-background";

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
};

function eventId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  const id = (data as Record<string, unknown>).id;
  return typeof id === "string" && id ? id : undefined;
}

export class TitleController {
  private worktreeName?: string | undefined;
  private unsubscribers: Array<() => void> = [];
  private startupTimer?: unknown;
  private worktreeLookup = new AbortController();
  private disposed = false;
  private activity: ActivityTitle;
  private background: BackgroundActivityMonitor;
  private jpiBackground: JpiBackgroundActivityMonitor;
  private dependencies: Dependencies;
  private context: TitleContext;

  constructor(dependencies: Dependencies, context: TitleContext) {
    this.dependencies = dependencies;
    this.context = context;
    this.activity = new ActivityTitle(
      dependencies.scheduler,
      () => sessionIndicator(dependencies.getSessionName(), this.worktreeName, context.cwd),
      (title) => context.ui.setTitle(title),
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
    const name = await loadWorktreeName(
      this.dependencies.exec,
      this.context.cwd,
      this.worktreeLookup.signal,
    );
    if (this.disposed) return;
    this.worktreeName = name;

    // Core restores its title after awaited session_start handlers, so render next turn.
    this.startupTimer = this.dependencies.scheduler.setTimeout(() => {
      this.startupTimer = undefined;
      if (!this.disposed) this.activity.refresh();
    }, 0);
  }

  setMainActive(active: boolean): void {
    this.activity.setMain(active);
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
    if (this.startupTimer !== undefined) {
      this.dependencies.scheduler.clearTimeout(this.startupTimer);
    }
    this.activity.shutdown();
  }
}
