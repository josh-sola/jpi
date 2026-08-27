import { errorMessage, isRecord, type EventBus } from "../../src/core/index.ts";
import { type MonitorManager, type MonitorSnapshot, resolveBackgroundItem } from "./monitor.ts";
import type { BackgroundTaskRegistry, BgTaskSnapshot, TaskRunContext } from "./registry.ts";

export const REQUEST_CHANNEL = "jpi-background:request:v1";
export const RESPONSE_CHANNEL = "jpi-background:response:v1";
export const TERMINAL_CHANNEL = "jpi-background:terminal:v1";
export const TASKS_CHANNEL = "jpi-background:tasks:v1";

export const REQUEST_SCHEMA = "jpi-background.request.v1";
export const RESPONSE_SCHEMA = "jpi-background.response.v1";
export const TERMINAL_SCHEMA = "jpi-background.terminal.v1";
export const TASKS_SCHEMA = "jpi-background.tasks.v1";

const KNOWN_OPS = new Set(["capabilities", "run", "status", "logs", "kill"]);
type Operation = "capabilities" | "run" | "status" | "logs" | "kill";

export type { EventBus };

export interface RequestEnvelope {
  readonly schema: typeof REQUEST_SCHEMA;
  readonly request_id: string;
  readonly operation: Operation;
  readonly params?: Record<string, unknown>;
}

export interface ResponseEnvelope {
  readonly schema: typeof RESPONSE_SCHEMA;
  readonly request_id: string;
  readonly operation: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

export interface BackgroundBus {
  /** Fire-and-forget broadcast of one task's or monitor's terminal snapshot. Consumers dedupe by id. */
  publishTerminal(snapshot: BgTaskSnapshot | MonitorSnapshot): void;
  /** Wires the request-channel handler and the tasks-level broadcast. Call once, after both are constructed. */
  attach(
    registry: BackgroundTaskRegistry,
    monitors: MonitorManager,
    getContext: () => TaskRunContext | undefined,
  ): void;
}

export function parseRequest(data: unknown): RequestEnvelope | undefined {
  if (!isRecord(data) || data.schema !== REQUEST_SCHEMA) return undefined;
  const requestId = data.request_id;
  const operation = data.operation;
  if (typeof requestId !== "string" || requestId.length === 0) return undefined;
  if (typeof operation !== "string" || !KNOWN_OPS.has(operation)) return undefined;
  const params = isRecord(data.params) ? data.params : undefined;
  return {
    schema: REQUEST_SCHEMA,
    request_id: requestId,
    operation: operation as Operation,
    params,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

async function handleRequest(
  events: EventBus,
  registry: BackgroundTaskRegistry,
  monitors: MonitorManager,
  getContext: () => TaskRunContext | undefined,
  request: RequestEnvelope,
  logger: Pick<Console, "error">,
): Promise<void> {
  const params = request.params ?? {};
  try {
    let result: unknown;
    switch (request.operation) {
      case "capabilities": {
        result = { version: "1", ops: [...KNOWN_OPS] };
        break;
      }
      case "run": {
        const ctx = getContext();
        if (!ctx) throw new Error("No active session context yet");
        const command = optionalString(params.command);
        if (!command) throw new Error("run requires a command string");
        const task = await registry.start(ctx, command, {
          name: optionalString(params.name),
          timeoutSeconds: optionalNumber(params.timeoutSeconds),
          wakeOnCompletion: optionalBoolean(params.wakeOnCompletion),
        });
        result = { task };
        break;
      }
      case "status": {
        const taskId = optionalString(params.taskId);
        if (taskId) {
          result = { tasks: [resolveBackgroundItem(registry, monitors, taskId)] };
        } else {
          const tasks = registry.list().filter((task) => !monitors.has(task.id));
          result = { tasks: [...tasks, ...monitors.list()] };
        }
        break;
      }
      case "logs": {
        const taskId = optionalString(params.taskId);
        if (!taskId) throw new Error("logs requires a taskId");
        result = await registry.readOutput(taskId, {
          maxBytes: optionalNumber(params.maxBytes),
          tail: optionalBoolean(params.tail),
        });
        break;
      }
      case "kill": {
        const taskId = optionalString(params.taskId);
        if (!taskId) throw new Error("kill requires a taskId");
        result = { task: await registry.stop(taskId) };
        break;
      }
    }
    emitResponse(events, logger, {
      request_id: request.request_id,
      operation: request.operation,
      ok: true,
      result,
    });
  } catch (error) {
    emitResponse(events, logger, {
      request_id: request.request_id,
      operation: request.operation,
      ok: false,
      error: errorMessage(error),
    });
  }
}

function emitResponse(
  events: EventBus,
  logger: Pick<Console, "error">,
  fields: Pick<ResponseEnvelope, "request_id" | "operation" | "ok" | "result" | "error">,
): void {
  try {
    events.emit(RESPONSE_CHANNEL, { schema: RESPONSE_SCHEMA, ...fields });
  } catch (error) {
    logger.error("[jpi-background] response broadcast failed:", error);
  }
}

/** Level channel, replace-set semantics: each payload is the full current running set. */
export function jpiBackgroundRunningIds(data: unknown): Set<string> | undefined {
  if (!isRecord(data) || data.schema !== TASKS_SCHEMA || !Array.isArray(data.tasks)) {
    return undefined;
  }
  const ids = new Set<string>();
  for (const task of data.tasks) {
    if (isRecord(task) && typeof task.id === "string" && task.id) ids.add(task.id);
  }
  return ids;
}

export function createBackgroundBus(
  events: EventBus,
  logger: Pick<Console, "error"> = console,
): BackgroundBus {
  function publishTerminal(snapshot: BgTaskSnapshot | MonitorSnapshot): void {
    try {
      events.emit(TERMINAL_CHANNEL, { schema: TERMINAL_SCHEMA, task: snapshot });
    } catch (error) {
      logger.error("[jpi-background] terminal broadcast failed:", error);
    }
  }

  return {
    publishTerminal,
    attach(registry, monitors, getContext) {
      function currentRunningSet(): Array<BgTaskSnapshot | MonitorSnapshot> {
        const tasks = registry
          .list()
          .filter((task) => !monitors.has(task.id) && task.status === "running");
        const monitorSnapshots = monitors.list().filter((monitor) => monitor.status === "running");
        return [...tasks, ...monitorSnapshots];
      }

      function publishTasksLevel(): void {
        try {
          events.emit(TASKS_CHANNEL, { schema: TASKS_SCHEMA, tasks: currentRunningSet() });
        } catch (error) {
          logger.error("[jpi-background] tasks-level broadcast failed:", error);
        }
      }

      registry.onChange(publishTasksLevel);

      events.on(REQUEST_CHANNEL, (data) => {
        const request = parseRequest(data);
        if (!request) return;
        void handleRequest(events, registry, monitors, getContext, request, logger);
      });
    },
  };
}
