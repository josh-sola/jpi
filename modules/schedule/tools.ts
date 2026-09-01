import type {
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
  truncateEnd,
} from "../../src/core/index.ts";
import {
  LIST_SCHEDULES_DESCRIPTION,
  LIST_SCHEDULES_PROMPT_SNIPPET,
  SCHEDULE_DESCRIPTION,
  SCHEDULE_GUIDELINES,
  SCHEDULE_PROMPT_SNIPPET,
  STOP_SCHEDULE_DESCRIPTION,
  STOP_SCHEDULE_PROMPT_SNIPPET,
} from "./prompts.ts";
import {
  validateCronExpression,
  type ScheduleRegistry,
  type ScheduleSnapshot,
} from "./registry.ts";

export interface ScheduleToolDeps {
  readonly registry: ScheduleRegistry;
}

function textContent(text: string): TextContent[] {
  return [{ type: "text", text }];
}

/** First non-empty line of `text`, for a one-line error or fallback summary. */
function firstNonEmptyLine(text: string): string | undefined {
  return text.split("\n").find((line) => line.trim() !== "");
}

/** Shared renderResult for the schedule tools: partial/error handling, then a one-line summary. */
function renderScheduleResult(
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

  container.addChild(createResultLine(firstNonEmptyLine(text) ?? "Done", theme, "dim"));
  if (options.expanded && text) container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
  return container;
}

function cronSummary(expression: string): string {
  return `cron "${expression}"`;
}

function formatWhen(ms: number | undefined): string {
  return ms === undefined ? "unknown" : new Date(ms).toISOString();
}

function formatSchedule(item: ScheduleSnapshot): string {
  const next = `next run: ${formatWhen(item.nextRun)}`;
  const last =
    item.lastFiredAt !== undefined ? ` · last fired: ${formatWhen(item.lastFiredAt)}` : "";
  const prompt = truncateEnd(item.prompt, 200);
  const runs = `run ${item.runCount} time${item.runCount === 1 ? "" : "s"}`;
  return `${item.id} (${cronSummary(item.cronExpression)}) — ${next}${last} · ${runs}\n  ${prompt}`;
}

const ScheduleParams = Type.Object({
  prompt: Type.String({
    description: "The prompt text injected into this session's chat when the schedule fires.",
  }),
  cron: Type.String({
    description:
      'Cron expression (croner syntax): 5-field (minute precision) or 6-field with a leading seconds column, e.g. "*/5 * * * * *" for every 5 seconds. */n steps work in every field.',
  }),
});
type ScheduleParamsValue = Static<typeof ScheduleParams>;

const ListSchedulesParams = Type.Object({});

const StopScheduleParams = Type.Object({
  id: Type.String({ description: "Schedule id, or an unambiguous prefix, to stop." }),
});

export function createScheduleTools(deps: ScheduleToolDeps): ToolDefinition[] {
  const { registry } = deps;

  const schedule: ToolDefinition<typeof ScheduleParams> = {
    name: "schedule",
    label: "Schedule",
    description: SCHEDULE_DESCRIPTION,
    promptSnippet: SCHEDULE_PROMPT_SNIPPET,
    promptGuidelines: [...SCHEDULE_GUIDELINES],
    parameters: ScheduleParams,
    prepareArguments(args): ScheduleParamsValue {
      if (!isRecord(args)) throw new Error("schedule arguments must be an object");
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) throw new Error("schedule requires a non-empty prompt");
      const cron = typeof args.cron === "string" ? args.cron.trim() : "";
      if (!cron) throw new Error("schedule requires a cron expression");
      validateCronExpression(cron);
      return { prompt, cron };
    },
    async execute(_toolCallId, params) {
      const created = registry.create(params.prompt, params.cron);
      return Promise.resolve({
        content: textContent(
          `Scheduled ${created.id} (${cronSummary(created.cronExpression)}). Next run: ${formatWhen(created.nextRun)}.`,
        ),
        details: { schedule: created },
      });
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      return createToolHeader(
        bulletState(context),
        "Schedule",
        args.cron ?? "",
        theme,
        context.lastComponent,
      );
    },
    renderResult: renderScheduleResult,
  };

  const listSchedules: ToolDefinition<typeof ListSchedulesParams> = {
    name: "list_schedules",
    label: "List Schedules",
    description: LIST_SCHEDULES_DESCRIPTION,
    promptSnippet: LIST_SCHEDULES_PROMPT_SNIPPET,
    parameters: ListSchedulesParams,
    execute() {
      const items = registry.list();
      return Promise.resolve({
        content: textContent(
          items.length > 0 ? items.map(formatSchedule).join("\n\n") : "No scheduled prompts.",
        ),
        details: { items },
      });
    },
    renderShell: "self",
    renderCall(_args, theme, context) {
      return createToolHeader(
        bulletState(context),
        "Schedule",
        "list",
        theme,
        context.lastComponent,
      );
    },
    renderResult: renderScheduleResult,
  };

  const stopSchedule: ToolDefinition<typeof StopScheduleParams> = {
    name: "stop_schedule",
    label: "Stop Schedule",
    description: STOP_SCHEDULE_DESCRIPTION,
    promptSnippet: STOP_SCHEDULE_PROMPT_SNIPPET,
    parameters: StopScheduleParams,
    async execute(_toolCallId, params) {
      const stopped = registry.stop(params.id);
      return Promise.resolve({
        content: textContent(`Stopped ${stopped.id} (${cronSummary(stopped.cronExpression)}).`),
        details: { schedule: stopped },
      });
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      return createToolHeader(
        bulletState(context),
        "Schedule",
        `stop: ${args.id}`,
        theme,
        context.lastComponent,
      );
    },
    renderResult: renderScheduleResult,
  };

  return [schedule, listSchedules, stopSchedule] as ToolDefinition[];
}
