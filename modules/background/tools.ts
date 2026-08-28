import type {
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

import {
  bulletState,
  createResultLine,
  createToolHeader,
  extractResultText,
  isRecord,
  plural,
  truncateEnd,
} from "../../src/core/index.ts";
import { abortable, DETACH_MARKER, type DetachRegistry } from "./detach.ts";
import { type MonitorManager, resolveBackgroundItem } from "./monitor.ts";
import {
  BG_KILL_DESCRIPTION,
  BG_KILL_GUIDELINES,
  BG_KILL_PROMPT_SNIPPET,
  BG_LOGS_DESCRIPTION,
  BG_LOGS_GUIDELINES,
  BG_LOGS_PROMPT_SNIPPET,
  BG_MONITOR_DESCRIPTION,
  BG_MONITOR_GUIDELINES,
  BG_MONITOR_PROMPT_SNIPPET,
  BG_STATUS_DESCRIPTION,
  BG_STATUS_GUIDELINES,
  BG_STATUS_PROMPT_SNIPPET,
  RUN_DESCRIPTION,
  RUN_GUIDELINES,
  RUN_PROMPT_SNIPPET,
} from "./prompts.ts";
import {
  type BackgroundTaskRegistry,
  type BgTaskSnapshot,
  MAX_LOG_BYTES,
  type TaskRunContext,
} from "./registry.ts";
import { type InstallRunner, mapSpawnError, type PreparedRun, prepareRun } from "./runner.ts";
import type { Snapshot } from "./log-view.ts";

export interface BackgroundToolDeps {
  readonly registry: BackgroundTaskRegistry;
  readonly monitors: MonitorManager;
}

function taskRunContext(ctx: ExtensionContext): TaskRunContext {
  return { cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() };
}

function textContent(text: string): TextContent[] {
  return [{ type: "text", text }];
}

/** Collapsed summary: first non-empty line, or "(no output)". Mirrors a shell tool's result line. */
function summarizeOutput(text: string): string {
  const lines = text.split("\n");
  const firstIndex = lines.findIndex((line) => line.trim() !== "");
  if (firstIndex === -1) return "(no output)";
  const preview = truncateEnd(lines[firstIndex] ?? "", 100);
  const remaining = lines.length - firstIndex - 1;
  return remaining > 0 ? `${preview} … +${remaining} ${plural(remaining, "line")}` : preview;
}

/** First non-empty line of `text`, for a one-line error preview. */
function firstNonEmptyLine(text: string): string | undefined {
  return text.split("\n").find((line) => line.trim() !== "");
}

/** Shared renderResult for the bg_* tools: partial/error handling, then a shell-style summary. */
function renderBackgroundResult(
  result: { content: ReadonlyArray<{ type: string; text?: string }> },
  options: ToolRenderResultOptions,
  theme: Theme,
  context: { isError: boolean },
) {
  if (options.isPartial) return new Container();
  const text = extractResultText(result.content);
  const container = new Container();
  if (context.isError) {
    const preview = truncateEnd(firstNonEmptyLine(text) ?? "Error", 100);
    container.addChild(createResultLine(preview, theme, "error"));
    if (options.expanded) container.addChild(new Text(theme.fg("error", text), 0, 0));
    return container;
  }

  container.addChild(createResultLine(summarizeOutput(text), theme, "dim"));
  if (options.expanded && text) {
    container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
  }
  return container;
}

function formatSnapshot(item: Snapshot): string {
  const age =
    item.endTime !== undefined
      ? `${Math.round((item.endTime - item.startTime) / 1000)}s`
      : "running";
  const label =
    item.kind === "monitor"
      ? `monitor ${item.id} (${item.description})`
      : `task ${item.id} (${item.name})`;
  const code =
    item.exitCode !== undefined && item.exitCode !== null ? ` exit=${item.exitCode}` : "";
  const error = item.error ? ` error=${item.error}` : "";
  return `${label}: ${item.status} [${age}]${code}${error}\n  output: ${item.outputPath}`;
}

const BgStatusParams = Type.Object({
  taskId: Type.Optional(
    Type.String({
      description: "Task or monitor id, or an unambiguous prefix. Omit to list everything.",
    }),
  ),
});

const BgLogsParams = Type.Object({
  taskId: Type.String({ description: "Task or monitor id, or an unambiguous prefix." }),
  maxBytes: Type.Optional(
    Type.Number({
      description: `Maximum bytes to return, clamped to 1-${MAX_LOG_BYTES}. Default: ${MAX_LOG_BYTES}.`,
    }),
  ),
  tail: Type.Optional(
    Type.Boolean({ description: "Read the tail when true, the head when false. Default: true." }),
  ),
});

const BgKillParams = Type.Object({
  taskId: Type.String({ description: "Task or monitor id, or an unambiguous prefix, to stop." }),
});

const BgMonitorParams = Type.Object({
  command: Type.String({ description: "Shell command whose stdout lines are the event stream." }),
  description: Type.String({
    description: "Short description of what this monitor watches for. Shown in every notification.",
  }),
  timeoutSeconds: Type.Optional(
    Type.Number({
      description: "Stop the monitor as timed out after this many seconds. Default: from config.",
    }),
  ),
  persistent: Type.Optional(
    Type.Boolean({
      description: "Run for the rest of the session instead of timing out. Default: false.",
    }),
  ),
});

export function createBackgroundTools(deps: BackgroundToolDeps): ToolDefinition[] {
  const { registry, monitors } = deps;

  const bgStatus: ToolDefinition<typeof BgStatusParams> = {
    name: "bg_status",
    label: "Background Status",
    description: BG_STATUS_DESCRIPTION,
    promptSnippet: BG_STATUS_PROMPT_SNIPPET,
    promptGuidelines: [...BG_STATUS_GUIDELINES],
    parameters: BgStatusParams,
    execute(_toolCallId, params) {
      let items: Snapshot[];
      if (params.taskId) {
        items = [resolveBackgroundItem(registry, monitors, params.taskId)];
      } else {
        const tasks = registry.list().filter((task) => !monitors.has(task.id));
        items = [...tasks, ...monitors.list()];
      }
      return Promise.resolve({
        content: textContent(
          items.length > 0
            ? items.map(formatSnapshot).join("\n\n")
            : "No background tasks or monitors.",
        ),
        details: { items },
      });
    },
    renderShell: "self",
    renderCall(_args, theme, context) {
      return createToolHeader(
        bulletState(context),
        "Background",
        "status",
        theme,
        context.lastComponent,
      );
    },
    renderResult: renderBackgroundResult,
  };

  const bgLogs: ToolDefinition<typeof BgLogsParams> = {
    name: "bg_logs",
    label: "Background Logs",
    description: BG_LOGS_DESCRIPTION,
    promptSnippet: BG_LOGS_PROMPT_SNIPPET,
    promptGuidelines: [...BG_LOGS_GUIDELINES],
    parameters: BgLogsParams,
    async execute(_toolCallId, params) {
      const read = await registry.readOutput(params.taskId, {
        ...(params.maxBytes !== undefined && { maxBytes: params.maxBytes }),
        tail: params.tail ?? true,
      });
      return { content: textContent(read.text), details: read };
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      return createToolHeader(
        bulletState(context),
        "Background",
        `logs: ${args.taskId}`,
        theme,
        context.lastComponent,
      );
    },
    renderResult: renderBackgroundResult,
  };

  const bgKill: ToolDefinition<typeof BgKillParams> = {
    name: "bg_kill",
    label: "Background Kill",
    description: BG_KILL_DESCRIPTION,
    promptSnippet: BG_KILL_PROMPT_SNIPPET,
    promptGuidelines: [...BG_KILL_GUIDELINES],
    parameters: BgKillParams,
    async execute(_toolCallId, params) {
      const task = await registry.stop(params.taskId);
      return {
        content: textContent(`Stopped ${task.name} (${task.id}). Output: ${task.outputPath}`),
        details: { task },
      };
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      return createToolHeader(
        bulletState(context),
        "Background",
        `kill: ${args.taskId}`,
        theme,
        context.lastComponent,
      );
    },
    renderResult: renderBackgroundResult,
  };

  const bgMonitor: ToolDefinition<typeof BgMonitorParams> = {
    name: "bg_monitor",
    label: "Background Monitor",
    description: BG_MONITOR_DESCRIPTION,
    promptSnippet: BG_MONITOR_PROMPT_SNIPPET,
    promptGuidelines: [...BG_MONITOR_GUIDELINES],
    parameters: BgMonitorParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const monitor = await monitors.start(
        taskRunContext(ctx),
        params.command,
        params.description,
        {
          ...(params.timeoutSeconds !== undefined && { timeoutSeconds: params.timeoutSeconds }),
          persistent: params.persistent ?? false,
        },
      );
      return {
        content: textContent(
          `Started monitor ${monitor.id}: ${monitor.description}\nOutput: ${monitor.outputPath}\nEach matching line becomes a notification; exit ends the watch.`,
        ),
        details: { monitor },
      };
    },
    renderShell: "self",
    // No monitor id exists until execute() runs, so the header uses the
    // description — the only identifier available at call-render time.
    renderCall(args, theme, context) {
      return createToolHeader(
        bulletState(context),
        "Background",
        `monitor: ${args.description}`,
        theme,
        context.lastComponent,
      );
    },
    renderResult: renderBackgroundResult,
  };

  return [bgStatus, bgLogs, bgKill, bgMonitor] as ToolDefinition[];
}

const RunParams = Type.Object({
  language: Type.Union([Type.Literal("zsh"), Type.Literal("typescript"), Type.Literal("python")], {
    description:
      "Script language. zsh runs the script as-is; typescript and python get a staged dependency install.",
  }),
  script: Type.Optional(
    Type.String({
      description:
        "Inline script text. Exactly one of script/file is required — prefer this over file.",
    }),
  ),
  file: Type.Optional(
    Type.String({
      description:
        "Path to an existing script, relative to cwd or absolute. Exactly one of script/file is required.",
    }),
  ),
  dependencies: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Dependency specs: PEP 508 for python (e.g. requests==2.32), npm specs for typescript (e.g. zod@^4). Not supported for zsh.",
    }),
  ),
  path: Type.Optional(
    Type.String({
      description: "Working directory the script runs in. Default: the session's cwd.",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Seconds before the run is killed. Default: from config. 0 disables it for a foreground run.",
    }),
  ),
  background: Type.Optional(
    Type.Boolean({
      description:
        "Run in the background and return a task id immediately, instead of blocking until it finishes. Default: false.",
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Short label for this run, used for background task naming." }),
  ),
});
type RunParamsValue = Static<typeof RunParams>;

/** First line of the script, or the file path, truncated for the header. */
function runCommandArg(args: RunParamsValue): string {
  const raw = args.script ? (args.script.split("\n")[0] ?? "") : (args.file ?? "");
  return truncateEnd(raw, 80);
}

export interface RunToolDeps {
  readonly registry: BackgroundTaskRegistry;
  readonly detach: DetachRegistry;
  /** Foreground default, resolved from config's runDefaultTimeoutSeconds; undefined when disabled. */
  readonly defaultTimeoutSeconds: number | undefined;
  readonly makeStageId?: () => string;
  readonly runInstall?: InstallRunner;
}

/** Builds the `run` tool. Registered conditionally (config's runEnabled), unlike the always-on bg_* tools. */
export function createRunTool(deps: RunToolDeps): ToolDefinition<typeof RunParams> {
  const { registry, detach, defaultTimeoutSeconds, makeStageId, runInstall } = deps;

  async function buildFinishedResult(finished: BgTaskSnapshot, prepared: PreparedRun) {
    const read = await registry.readOutput(finished.id, { tail: true });
    const mappedError = mapSpawnError(finished.error, prepared.argv[0] ?? "");
    const durationSeconds =
      finished.endTime !== undefined
        ? Math.round((finished.endTime - finished.startTime) / 1000)
        : undefined;
    const lines = [
      `${finished.name} (${finished.id}): ${finished.status}${durationSeconds !== undefined ? ` in ${durationSeconds}s` : ""}`,
    ];
    if (finished.exitCode !== undefined && finished.exitCode !== null)
      lines.push(`exit_code: ${finished.exitCode}`);
    if (mappedError) lines.push(`error: ${mappedError}`);
    lines.push(`stage: ${prepared.stageDir}`, `output: ${finished.outputPath}`, "", read.text);
    return { content: textContent(lines.join("\n")), details: { task: finished } };
  }

  return {
    name: "run",
    label: "Run",
    description: RUN_DESCRIPTION,
    promptSnippet: RUN_PROMPT_SNIPPET,
    promptGuidelines: [...RUN_GUIDELINES],
    parameters: RunParams,
    prepareArguments(args): RunParamsValue {
      if (!isRecord(args)) throw new Error("run arguments must be an object");
      const language = args.language;
      if (language !== "zsh" && language !== "typescript" && language !== "python") {
        throw new Error('run requires language to be "zsh", "typescript", or "python"');
      }
      const script =
        typeof args.script === "string" && args.script.length > 0 ? args.script : undefined;
      const file = typeof args.file === "string" && args.file.trim() ? args.file : undefined;
      if ((script === undefined) === (file === undefined)) {
        throw new Error("run requires exactly one of script or file");
      }
      const dependencies = Array.isArray(args.dependencies)
        ? args.dependencies.filter((dep): dep is string => typeof dep === "string")
        : undefined;
      if (dependencies && dependencies.length > 0 && language === "zsh") {
        throw new Error("run does not support dependencies for zsh scripts");
      }

      const prepared: RunParamsValue = { language };
      if (script !== undefined) prepared.script = script;
      if (file !== undefined) prepared.file = file;
      if (dependencies) prepared.dependencies = dependencies;
      if (typeof args.path === "string" && args.path.trim()) prepared.path = args.path;
      if (typeof args.timeout === "number") prepared.timeout = args.timeout;
      if (typeof args.background === "boolean") prepared.background = args.background;
      if (typeof args.name === "string" && args.name.trim()) prepared.name = args.name;
      return prepared;
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const runCtx = taskRunContext(ctx);
      const sessionDir = await registry.ensureSessionDir(runCtx);
      const prepared = await prepareRun(
        {
          language: params.language,
          script: params.script,
          file: params.file,
          dependencies: params.dependencies,
          path: params.path,
        },
        {
          ctxCwd: ctx.cwd,
          sessionDir,
          ...(makeStageId ? { makeStageId } : {}),
          ...(runInstall ? { runInstall } : {}),
        },
      );
      const invocation = {
        argv: prepared.argv,
        cwd: prepared.cwd,
        language: prepared.language,
        stageDir: prepared.stageDir,
      };

      if (params.background) {
        const task = await registry.start(runCtx, prepared.displayCommand, {
          ...(params.name !== undefined && { name: params.name }),
          ...(params.timeout !== undefined && { timeoutSeconds: params.timeout }),
          invocation,
        });
        return {
          content: textContent(
            `Started ${task.name} (${task.id}).\nPID: ${task.pid ?? "unknown"}\nStage: ${prepared.stageDir}\nOutput: ${task.outputPath}\nYou will be notified when it finishes; do not poll.`,
          ),
          details: { task },
        };
      }

      const timeoutSeconds = params.timeout ?? defaultTimeoutSeconds;
      const task = await registry.start(runCtx, prepared.displayCommand, {
        ...(params.name !== undefined && { name: params.name }),
        ...(timeoutSeconds !== undefined && { timeoutSeconds }),
        invocation,
        awaited: true,
      });

      const detachController = new AbortController();
      detach.register(task.id, detachController);
      let onAbort: (() => void) | undefined;
      if (signal) {
        onAbort = () => {
          registry.stop(task.id).catch(() => undefined);
        };
        // The task can already be running by the time we get here — start()
        // itself awaits durable metadata I/O — so a signal that fired during
        // that gap needs the same reaction as one that fires later.
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      try {
        let finished: BgTaskSnapshot;
        try {
          finished = await abortable(registry.waitForTask(task.id), detachController.signal);
        } catch (error) {
          if (error !== DETACH_MARKER) throw error;
          registry.clearAwaited(task.id);
          const current = registry.get(task.id);
          // The task can have finalized in the same window as the detach:
          // finalizeTask's waiters fired before notifyCompletion ran, saw
          // awaited still true, and skipped — that notification never
          // arrives now, so the completed result is the only delivery left.
          if (current.status !== "running") return buildFinishedResult(current, prepared);
          return {
            content: textContent(
              `Moved ${task.name} (${task.id}) to the background — it keeps running.\nStage: ${prepared.stageDir}\nOutput: ${task.outputPath}\nYou will be notified when it finishes; do not poll.`,
            ),
            details: { task: current },
          };
        }

        return await buildFinishedResult(finished, prepared);
      } finally {
        detach.unregister(task.id);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      }
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      return createToolHeader(
        bulletState(context),
        "Run",
        runCommandArg(args),
        theme,
        context.lastComponent,
      );
    },
    renderResult: renderBackgroundResult,
  };
}
