import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  createActivityTracker,
  type ActivitySnapshot,
  type ActivityTracker,
  type Scheduler,
} from "../../src/core/index.ts";
import { getAgentDirectory } from "../../src/pi/index.ts";
import type { EventBus } from "../../src/pi/index.ts";
import { createHerdrClient } from "./client.ts";

const SOURCE = "herdr:pi";
const AGENT = "pi";

type HerdrAgentState = "working" | "blocked" | "idle";

type MinimalModel = { provider: string; id: string; name: string } | undefined;

type HerdrStatusContext = {
  mode: string;
  model?: MinimalModel;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  sessionManager?: {
    getSessionFile?(): string | undefined;
    getSessionId?(): string | undefined;
  };
};

type SessionRef = { agent_session_path: string } | { agent_session_id: string };

export type HerdrStatusDependencies = {
  events: EventBus;
  env?: Record<string, string | undefined>;
  send?: (request: unknown) => Promise<boolean>;
  now?: () => number;
  scheduler?: Scheduler;
  fileExists?: (path: string) => boolean;
  agentDirectory?: string;
  /** Sidebar label per model, keyed `${provider}/${id}`, from the module's `label` config entries. */
  labels?: ReadonlyMap<string, string>;
};

export type HerdrStatusExtension = {
  onSessionStart(event: { reason: string }, context: HerdrStatusContext): void;
  onAgentStart(event: unknown, context: HerdrStatusContext): void;
  onAgentSettled(event: unknown, context: HerdrStatusContext): void;
  onUiPromptStart(event: unknown, context: HerdrStatusContext): void;
  onUiPromptEnd(event: unknown, context: HerdrStatusContext): void;
  onModelSelect(event: { model?: MinimalModel }, context: HerdrStatusContext): void;
  onSessionShutdown(event: unknown, context: HerdrStatusContext): void;
};

// This counter is shared by the whole process and only advances when a
// request actually goes out. Herdr compares seq per pane per source, so it
// must strictly increase in wire order, not in enqueue order.
let reportSeq = Date.now() * 1000;
function nextSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

let requestCounter = 0;
function nextRequestId(kind: string): string {
  requestCounter += 1;
  return `jpi:herdr-status:${kind}:${requestCounter}`;
}

/** Strips one leading "Vendor: " prefix, the way model catalog names commonly carry it. */
export function labelFor(
  model: MinimalModel,
  labels: ReadonlyMap<string, string>,
): string | undefined {
  if (!model) return undefined;
  const configured = labels.get(`${model.provider}/${model.id}`);
  if (configured) return configured;
  const stripped = model.name.replace(/^[^:]+:\s*/, "");
  return (stripped || model.name).toLowerCase();
}

function sessionRefFrom(context: HerdrStatusContext): SessionRef | undefined {
  const path = context.sessionManager?.getSessionFile?.();
  if (typeof path === "string" && path.startsWith("/")) return { agent_session_path: path };
  const id = context.sessionManager?.getSessionId?.();
  if (typeof id === "string" && id) return { agent_session_id: id };
  return undefined;
}

function toHerdrState(snapshot: ActivitySnapshot): HerdrAgentState {
  if (snapshot.state === "blocked") return "blocked";
  if (snapshot.state === "working") return "working";
  return "idle";
}

function socketEndpoint(socketPath: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

type QueueEntry = {
  kind: "session" | "state" | "metadata";
  build: (seq: number) => unknown;
};

/**
 * One send in flight at a time, FIFO across every kind, so reports land on
 * the wire in the order they happened, including across a session restart.
 * A queued state entry is replaced by the next one, since only the latest matters.
 */
function createSender(): {
  setSend(send: (request: unknown) => Promise<boolean>): void;
  enqueue(entry: QueueEntry): void;
} {
  const queue: QueueEntry[] = [];
  let activeSend: ((request: unknown) => Promise<boolean>) | undefined;
  let draining = false;

  async function drain(): Promise<void> {
    draining = true;
    try {
      while (queue.length > 0) {
        const entry = queue.shift();
        if (!entry || !activeSend) break;
        await activeSend(entry.build(nextSeq()));
      }
    } finally {
      draining = false;
    }
  }

  return {
    setSend(send) {
      activeSend = send;
    },
    enqueue(entry) {
      if (entry.kind === "state") {
        const pendingIndex = queue.findIndex((existing) => existing.kind === "state");
        if (pendingIndex !== -1) queue.splice(pendingIndex, 1);
      }
      queue.push(entry);
      if (!draining) void drain();
    },
  };
}

export function createHerdrStatusExtension(
  dependencies: HerdrStatusDependencies,
): HerdrStatusExtension {
  const env = dependencies.env ?? process.env;
  const fileExists = dependencies.fileExists ?? existsSync;
  const labels = dependencies.labels ?? new Map<string, string>();
  const sender = createSender();
  let tracker: ActivityTracker | undefined;
  let paneId: string | undefined;
  let sessionRef: SessionRef | undefined;

  // Each enqueue captures pane id and session ref as of that moment, so an
  // entry still queued across a session boundary keeps the values it was
  // created with instead of picking up whatever the next session sets.
  function enqueueSession(sessionStartSource: string | undefined): void {
    if (!paneId || !sessionRef) return;
    const activePaneId = paneId;
    const activeSessionRef = sessionRef;
    sender.enqueue({
      kind: "session",
      build: (seq) => ({
        id: nextRequestId("session"),
        method: "pane.report_agent_session",
        params: {
          pane_id: activePaneId,
          source: SOURCE,
          agent: AGENT,
          seq,
          ...(sessionStartSource ? { session_start_source: sessionStartSource } : {}),
          ...activeSessionRef,
        },
      }),
    });
  }

  function enqueueState(snapshot: ActivitySnapshot): void {
    if (!paneId) return;
    const activePaneId = paneId;
    const activeSessionRef = sessionRef;
    const state = toHerdrState(snapshot);
    sender.enqueue({
      kind: "state",
      build: (seq) => ({
        id: nextRequestId("state"),
        method: "pane.report_agent",
        params: {
          pane_id: activePaneId,
          source: SOURCE,
          agent: AGENT,
          state,
          seq,
          ...activeSessionRef,
        },
      }),
    });
  }

  function enqueueLabel(model: MinimalModel): void {
    if (!paneId) return;
    const activePaneId = paneId;
    const text = labelFor(model, labels);
    sender.enqueue({
      kind: "metadata",
      build: (seq) => ({
        id: nextRequestId("metadata"),
        method: "pane.report_metadata",
        params: {
          pane_id: activePaneId,
          source: SOURCE,
          agent: AGENT,
          seq,
          ...(text === undefined ? { clear_display_agent: true } : { display_agent: text }),
        },
      }),
    });
  }

  return {
    onSessionStart(event, context) {
      tracker?.dispose();
      tracker = undefined;
      paneId = undefined;
      sessionRef = undefined;

      if (context.mode !== "tui") return;
      const socketPath = env.HERDR_SOCKET_PATH;
      const herdrPaneId = env.HERDR_PANE_ID;
      if (env.HERDR_ENV !== "1" || !socketPath || !herdrPaneId) return;

      const agentDirectory = dependencies.agentDirectory ?? getAgentDirectory(env);
      if (fileExists(join(agentDirectory, "extensions", "herdr-agent-state.ts"))) {
        context.ui.notify(
          "JPI herdr status is disabled because herdr's own Pi integration is installed; run `herdr integration uninstall pi` to use JPI aggregate status.",
          "warning",
        );
        return;
      }

      paneId = herdrPaneId;
      sender.setSend(
        dependencies.send ??
          ((request: unknown) =>
            createHerdrClient({
              socketPath: socketEndpoint(socketPath),
              ...(dependencies.scheduler ? { scheduler: dependencies.scheduler } : {}),
            }).send(request)),
      );

      sessionRef = sessionRefFrom(context);
      enqueueSession(event.reason);

      tracker = createActivityTracker({
        events: dependencies.events,
        ...(dependencies.now ? { now: dependencies.now } : {}),
        ...(dependencies.scheduler ? { scheduler: dependencies.scheduler } : {}),
        onChange: (snapshot) => enqueueState(snapshot),
      });
      tracker.start();

      enqueueLabel(context.model);
    },

    onAgentStart(_event, context) {
      if (!tracker) return;
      sessionRef = sessionRefFrom(context);
      enqueueSession(undefined);
      tracker.setForeground(true);
    },

    onAgentSettled() {
      tracker?.setForeground(false);
    },

    onUiPromptStart() {
      tracker?.startPrompt();
    },

    onUiPromptEnd() {
      tracker?.endPrompt();
    },

    onModelSelect(event) {
      if (!tracker) return;
      enqueueLabel(event.model);
    },

    onSessionShutdown() {
      tracker?.dispose();
      tracker = undefined;
      enqueueLabel(undefined);
      paneId = undefined;
      sessionRef = undefined;
    },
  };
}
