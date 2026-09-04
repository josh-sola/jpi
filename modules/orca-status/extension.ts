import { isRecord, jpiBackgroundRunningIds, TASKS_CHANNEL } from "../../src/core/index.ts";
import type { EventBus } from "../../src/pi/index.ts";

const GRACE_MS = 250;

export type OrcaStatusPayload = {
  state: "working" | "blocked" | "done";
  workingMode?: "monitoring";
  sessionBoundary?: true;
  subagents?: Array<{
    id: string;
    state: "working";
    startedAt: number;
    agentType?: string;
    description?: string;
  }>;
};

type Scheduler = {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(timer: unknown): void;
};

type OrcaStatusContext = {
  mode: string;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
};

type Subagent = NonNullable<OrcaStatusPayload["subagents"]>[number];

export type OrcaStatusDependencies = {
  events: EventBus;
  env?: Record<string, string | undefined>;
  write?: (output: string) => void;
  now?: () => number;
  scheduler?: Scheduler;
};

export type OrcaStatusExtension = {
  onSessionStart(event: unknown, context: OrcaStatusContext): void;
  onAgentStart(event: unknown, context: OrcaStatusContext): void;
  onAgentSettled(event: unknown, context: OrcaStatusContext): void;
  onUiPromptStart(event: unknown, context: OrcaStatusContext): void;
  onUiPromptEnd(event: unknown, context: OrcaStatusContext): void;
  onSessionShutdown(event: unknown, context: OrcaStatusContext): void;
};

const defaultScheduler: Scheduler = {
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function encodeOrcaStatus(payload: OrcaStatusPayload): string {
  return `\x1b]9999;${JSON.stringify(payload)}\x1b\\`;
}

function managedHookActive(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.ORCA_AGENT_HOOK_ENDPOINT || env.ORCA_AGENT_HOOK_ENDPOINT_FILE || env.ORCA_AGENT_HOOK_PORT,
  );
}

function subagent(data: unknown, now: () => number): Subagent | undefined {
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

class OrcaStatusController {
  private unsubscribers: Array<() => void> = [];
  private subagents = new Map<string, Subagent>();
  private backgroundIds = new Set<string>();
  private foreground = false;
  private prompts = 0;
  private graceTimer: unknown;
  private lastPayload?: string;
  private disposed = false;

  constructor(
    private readonly dependencies: Required<
      Pick<OrcaStatusDependencies, "events" | "write" | "now" | "scheduler">
    >,
  ) {}

  start(): void {
    this.unsubscribers = [
      this.dependencies.events.on("subagents:started", (data) => this.startSubagent(data)),
      this.dependencies.events.on("subagents:completed", (data) => this.finishSubagent(data)),
      this.dependencies.events.on("subagents:failed", (data) => this.finishSubagent(data)),
      this.dependencies.events.on(TASKS_CHANNEL, (data) => this.setBackground(data)),
    ];
    this.publish({ state: "done", sessionBoundary: true });
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
    const subagents = this.subagents.size ? { subagents: [...this.subagents.values()] } : {};
    if (this.prompts > 0) {
      this.publish({ state: "blocked", ...subagents });
      return;
    }
    if (this.foreground) {
      this.publish({ state: "working", ...subagents });
      return;
    }
    if (this.hasDetached()) {
      this.publish({ state: "working", workingMode: "monitoring", ...subagents });
      return;
    }
    this.publish({ state: "done" });
  }

  private publish(payload: OrcaStatusPayload): void {
    const encoded = JSON.stringify(payload);
    if (encoded === this.lastPayload) return;
    this.lastPayload = encoded;
    this.dependencies.write(encodeOrcaStatus(payload));
  }
}

export function createOrcaStatusExtension(
  dependencies: OrcaStatusDependencies,
): OrcaStatusExtension {
  const env = dependencies.env ?? process.env;
  const write = dependencies.write ?? ((output) => void process.stdout.write(output));
  const now = dependencies.now ?? Date.now;
  const scheduler = dependencies.scheduler ?? defaultScheduler;
  let activeController: OrcaStatusController | undefined;

  return {
    onSessionStart(_event, context) {
      activeController?.dispose();
      activeController = undefined;
      if (context.mode !== "tui" || !env.ORCA_PANE_KEY) return;
      if (managedHookActive(env)) {
        context.ui.notify(
          "Aggregate JPI Orca status is disabled because Orca's managed Pi hook is active; disable managed hooks to use JPI aggregate status.",
          "warning",
        );
        return;
      }
      activeController = new OrcaStatusController({
        events: dependencies.events,
        write,
        now,
        scheduler,
      });
      activeController.start();
    },

    onAgentStart() {
      activeController?.setForeground(true);
    },

    onAgentSettled() {
      activeController?.setForeground(false);
    },

    onUiPromptStart() {
      activeController?.startPrompt();
    },

    onUiPromptEnd() {
      activeController?.endPrompt();
    },

    onSessionShutdown() {
      activeController?.dispose();
      activeController = undefined;
    },
  };
}
