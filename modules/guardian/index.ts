import type {
  CustomEntry,
  EntryRenderOptions,
  ExtensionAPI,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Text } from "@earendil-works/pi-tui";

import {
  formatReviewDuration,
  hasReviewAnnotationConsumer,
  j,
  recordReviewAnnotation,
  type ModuleContext,
} from "../../src/core/index.ts";
import {
  AutoReviewController,
  COMMAND_NAME,
  STATUS_KEY,
  type ReviewCommandContext,
  type ReviewContext,
} from "./controller.ts";

// Re-exported for call sites (and tests) that import these from guardian's
// own module rather than the shared core barrel.
export { formatReviewDuration, isWithinRoot } from "../../src/core/index.ts";
// Re-exported so call sites (and tests) can import the module's public
// surface from this one file instead of reaching into each sibling directly.
export {
  isMcpGatewayIntrospection,
  isScratchpadWrite,
  isToolAllowlisted,
  matchesMcpServer,
  parseReviewerModel,
} from "./allowlist.ts";
export { AutoReviewController, mergeUsage } from "./controller.ts";
export {
  buildRecentUserTranscript,
  renderQuestionAnswers,
  stringifyBoundedJson,
} from "./transcript.ts";
export { parseReviewerDecision } from "./reviewer-response.ts";

export const REVIEWED_ENTRY_TYPE = "guardian-reviewed";

export const guardianSchema = j.node({
  fields: {
    model: j.string().describe("model that runs the reviews").default("anthropic/claude-sonnet-5"),
    timeoutMs: j
      .number()
      .int()
      .positive()
      .describe("per-review timeout in milliseconds")
      .default(10_000),
    allow: j.node({
      fields: {
        tool: j.list(j.string(), {
          description: 'tool names that skip review (repeat: tool "name")',
          default: [],
        }),
        bash: j.list(j.string(), {
          description: "regexes; a full command match skips review",
          default: [],
        }),
        mcp: j.list(j.string(), {
          description: 'MCP servers whose tools skip review (repeat: mcp "server")',
          default: [],
        }),
        readonly: j
          .boolean()
          .describe("set to #false to disable the built-in read-only command and tool allowlists")
          .default(true),
        scratchpad: j
          .boolean()
          .describe("set to #false to review scratchpad writes too")
          .default(true),
      },
    }),
    policy: j.list(j.string(), {
      description: "extra review policy lines",
      default: [],
    }),
  },
});

type ReviewedEntryData = { durationMs: number };

// Sits directly under a reviewed tool call's result line, matching that
// line's two-space indent so it reads as an annotation on it, not a new item.
export function renderReviewedEntry(
  entry: CustomEntry<ReviewedEntryData>,
  _options: EntryRenderOptions,
  theme: Theme,
): Component | undefined {
  const durationMs = entry.data?.durationMs;
  if (typeof durationMs !== "number") return undefined;
  return new Text(`  ${theme.fg("dim", `⛨ reviewed · ${formatReviewDuration(durationMs)}`)}`, 0, 0);
}

export default function autoReview(
  pi: ExtensionAPI,
  moduleCtx: ModuleContext<typeof guardianSchema>,
): void {
  const controller = new AutoReviewController(moduleCtx.config);

  pi.registerEntryRenderer<ReviewedEntryData>(REVIEWED_ENTRY_TYPE, renderReviewedEntry);

  pi.registerCommand(COMMAND_NAME, {
    description: "Show or control the Guardian review gate",
    handler: async (args, ctx) => {
      await controller.handleCommand(args, ctx as ReviewCommandContext);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await controller.seedPrompt();
    await controller.reloadConfig();
    const status = await controller.getStatusSnapshot(ctx as ReviewContext);
    controller.applyStatus(ctx as ReviewContext, status);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("before_agent_start", () => {
    controller.resetAgentRun();
  });

  pi.on("tool_call", async (event, ctx) => controller.handleToolCall(event, ctx as ReviewContext));
  pi.on("tool_result", async (event) => controller.handleToolResult(event));
  pi.on("tool_result", async (event) => {
    const durationMs = controller.takeReviewDuration(event.toolCallId);
    if (durationMs === undefined) return undefined;
    if (hasReviewAnnotationConsumer(event.toolName)) {
      recordReviewAnnotation(event.toolCallId, { durationMs });
      return undefined;
    }
    pi.appendEntry<ReviewedEntryData>(REVIEWED_ENTRY_TYPE, { durationMs });
    return undefined;
  });
  pi.on("message_end", async (event) => {
    if (event.message.role !== "toolResult") return undefined;
    return controller.handleToolResultMessage(event.message);
  });
}
