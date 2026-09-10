import {
  createActivityTracker,
  type ActivitySnapshot,
  type ActivityTracker,
  type Scheduler,
} from "../../src/core/index.ts";
import type { EventBus } from "../../src/pi/index.ts";

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

type OrcaStatusContext = {
  mode: string;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
};

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

export function encodeOrcaStatus(payload: OrcaStatusPayload): string {
  return `\x1b]9999;${JSON.stringify(payload)}\x1b\\`;
}

function managedHookActive(env: Record<string, string | undefined>): boolean {
  return Boolean(
    env.ORCA_AGENT_HOOK_ENDPOINT || env.ORCA_AGENT_HOOK_ENDPOINT_FILE || env.ORCA_AGENT_HOOK_PORT,
  );
}

function toOrcaPayload(snapshot: ActivitySnapshot): OrcaStatusPayload {
  const subagents = snapshot.subagents.length > 0 ? { subagents: snapshot.subagents } : {};
  if (snapshot.state === "blocked") return { state: "blocked", ...subagents };
  if (snapshot.state === "working") {
    return {
      state: "working",
      ...(snapshot.monitoring ? { workingMode: "monitoring" as const } : {}),
      ...subagents,
    };
  }
  return { state: "done" };
}

export function createOrcaStatusExtension(
  dependencies: OrcaStatusDependencies,
): OrcaStatusExtension {
  const env = dependencies.env ?? process.env;
  const write = dependencies.write ?? ((output) => void process.stdout.write(output));
  let tracker: ActivityTracker | undefined;

  return {
    onSessionStart(_event, context) {
      tracker?.dispose();
      tracker = undefined;
      if (context.mode !== "tui" || !env.ORCA_PANE_KEY) return;
      if (managedHookActive(env)) {
        context.ui.notify(
          "Aggregate JPI Orca status is disabled because Orca's managed Pi hook is active; disable managed hooks to use JPI aggregate status.",
          "warning",
        );
        return;
      }

      // Orca reads the first report of a session as the session boundary.
      let first = true;
      tracker = createActivityTracker({
        events: dependencies.events,
        ...(dependencies.now ? { now: dependencies.now } : {}),
        ...(dependencies.scheduler ? { scheduler: dependencies.scheduler } : {}),
        onChange: (snapshot) => {
          if (first) {
            first = false;
            write(encodeOrcaStatus({ state: "done", sessionBoundary: true }));
            return;
          }
          write(encodeOrcaStatus(toOrcaPayload(snapshot)));
        },
      });
      tracker.start();
    },

    onAgentStart() {
      tracker?.setForeground(true);
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

    onSessionShutdown() {
      tracker?.dispose();
      tracker = undefined;
    },
  };
}
