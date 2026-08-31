/**
 * Restyles a handful of other extensions' tools to match jpi's Claude-Code
 * style (bullet header, one-line "⎿" collapsed result) without touching
 * those packages: pi-mcp-adapter's `mcp`, `mcpScript`, and its per-server
 * `mcp__<server>` namespace-proxy tools; `@juicesharp/rpiv-ask-user-question`
 * (which ships with no renderers at all); and pi-schedule-prompt's
 * `schedule_prompt` (which has renderers, just no `renderShell: "self"`, so
 * it sits inside pi's bordered tool box instead of jpi's flat style).
 *
 * Re-registering any of these the normal way (`pi.registerTool`) doesn't
 * work for the MCP ones: pi's tool registry is a per-extension map,
 * aggregated first-match-wins (`ExtensionRunner.getAllRegisteredTools` /
 * `getToolDefinition` walk `this.extensions` in load order and keep the
 * first hit), and the adapter registers `mcp`/`mcpScript`/namespace tools
 * asynchronously, after every extension — including jpi's `style` module —
 * has already finished loading. A same-name `pi.registerTool` call here
 * would lose that race even if timing allowed it, since the adapter's own
 * extension slot comes first in `this.extensions` regardless of
 * registration order.
 *
 * So this patches the lookup chokepoint instead:
 * `ExtensionRunner.prototype.getToolDefinition`. It calls through to the
 * original lookup and, only for names this module knows how to reskin,
 * returns a wrapped copy of the definition with jpi's renderers spliced in —
 * every other field (`execute` above all) is the original extension's own
 * reference, untouched. `getToolDefinition` is also the path pi's own
 * execution machinery (agent-session.js) and the HTML transcript exporter
 * use to look up a tool by name; preserving every non-render field is what
 * keeps running the tool and exporting its transcript safe under this
 * patch. Wrapped copies are cached in a `WeakMap` keyed by the original
 * definition so repeated lookups for the same tool return the identical
 * object — some renderers/components compare definitions by reference —
 * and the original definition is never mutated.
 *
 * Which names get reskinned, and how, lives in `STATIC_RESKINS` (exact name
 * match) plus one dynamic case for the `mcp__` namespace-proxy prefix, since
 * pi-mcp-adapter registers one such tool per configured MCP server and the
 * set of server names isn't known ahead of time.
 *
 * Fragile by nature: depends on `getToolDefinition`'s name, its per-extension
 * `tools` map shape, and pi's root barrel continuing to export
 * `ExtensionRunner`. An upstream change to any of those turns this into a
 * no-op — the original extension's own vanilla rendering stays in place —
 * rather than a crash.
 */

import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";

import {
  asString,
  bulletState,
  createToolHeader,
  errorMessage,
  isRecord,
  markReviewAnnotationConsumer,
  type RenderResult,
  truncateEnd,
  withReviewAnnotation,
} from "../../src/core/index.ts";
import { patchToolDefinitionLookup, type ToolRenderContext } from "../../src/pi/index.ts";
import { firstNonEmptyLine, summarizeBashOutput } from "./format.ts";
import { renderCollapsibleResult, renderErrorResult } from "./index.ts";

const NAMESPACE_PROXY_PREFIX = "mcp__";

/** Every reskinned tool's real `execute`/`parameters` carry far more than this file touches. */
type McpDefinition = ToolDefinition<any, any, any>;

// ---- Shared MCP result rendering (mcp, mcpScript, and every mcp__<server> namespace proxy) ----
// All three run through the adapter's own `executeCall`, so they share one
// `AgentToolResult` shape: text/image content blocks, plus an optional
// `details.error` for failures that don't throw.

/** Renders one content block the way the adapter's own renderer does: text as-is, an image as a `[image: mime]` placeholder line. */
function blockText(block: { type: string; text?: unknown; mimeType?: unknown }): string {
  return block.type === "text"
    ? asString(block.text)
    : `[image: ${asString(block.mimeType) || "unknown"}]`;
}

function resultText(
  content: readonly { type: string; text?: unknown; mimeType?: unknown }[],
): string {
  return content.map(blockText).join("\n");
}

function hasErrorDetails(details: unknown): boolean {
  return isRecord(details) && Boolean(details.error);
}

/** Shared renderResult for mcp/mcpScript/namespace proxies: same partial/error/collapsed shape as the restyled built-in tools. */
const renderMcpResult: RenderResult<any, any, any> = (result, options, theme, context) => {
  if (options.isPartial) return new Container();
  const text = resultText(result.content ?? []);
  if (context.isError || hasErrorDetails(result.details)) {
    return renderErrorResult(text, options.expanded, theme);
  }
  return renderCollapsibleResult(summarizeBashOutput(text), text, options.expanded, theme);
};

const renderMcpScriptCall: McpDefinition["renderCall"] = (args, theme, context) => {
  const code = asString((args as { code?: unknown } | undefined)?.code);
  const arg = truncateEnd(firstNonEmptyLine(code) ?? "", 80);
  return createToolHeader(bulletState(context), "McpScript", arg, theme, context.lastComponent);
};

/** Best-effort compact rendering of an arbitrary arg value; never throws. */
function compactValue(value: unknown, maxLen = 60): string {
  try {
    if (typeof value === "string") return truncateEnd(value, maxLen);
    return truncateEnd(JSON.stringify(value), maxLen);
  } catch (error) {
    return truncateEnd(`<${errorMessage(error)}>`, maxLen);
  }
}

/**
 * Mirrors the shape of the adapter's own `formatMcpProxyToolCallLines`
 * (server/tool + a compact args hint, or the connect/describe/search/status
 * fallbacks) but as a single header arg instead of separate lines. Defensive
 * throughout: an unrecognized or missing field just falls through to the next
 * case, down to a raw JSON dump of whatever `args` is.
 */
function formatMcpProxyArg(args: Record<string, unknown>): string {
  const tool = asString(args.tool);
  if (tool) {
    const server = asString(args.server);
    const target = server ? `${server}/${tool}` : tool;
    return args.args === undefined ? target : `${target} ${compactValue(args.args)}`;
  }
  const connect = asString(args.connect);
  if (connect) return `connect ${connect}`;
  const describe = asString(args.describe);
  if (describe) return `describe ${describe}`;
  const search = asString(args.search);
  if (search) {
    const server = asString(args.server);
    return server ? `search ${search} @ ${server}` : `search ${search}`;
  }
  const instructions = asString(args.instructions);
  if (instructions) return `instructions ${instructions}`;
  const server = asString(args.server);
  if (server) return `list ${server}`;
  const action = asString(args.action);
  if (action) return action;
  return "status";
}

const renderMcpProxyCall: McpDefinition["renderCall"] = (args, theme, context) => {
  const arg = isRecord(args) ? formatMcpProxyArg(args) : compactValue(args);
  return createToolHeader(bulletState(context), "MCP", arg, theme, context.lastComponent);
};

/**
 * A namespace proxy's args are just `{tool, args}` against one fixed server
 * (the server is baked into the tool's name, not its args) — reuses
 * `formatMcpProxyArg`'s `tool`/`args` branch by feeding it a synthetic
 * `server` so `<server>/<tool> <hint>` comes out the same way.
 */
function renderNamespaceProxyCall(serverDisplay: string): McpDefinition["renderCall"] {
  return (args, theme, context) => {
    const arg = isRecord(args)
      ? formatMcpProxyArg({ ...args, server: serverDisplay })
      : compactValue(args);
    return createToolHeader(bulletState(context), "MCP", arg, theme, context.lastComponent);
  };
}

// ---- ask_user_question ----
// Ships with no renderers at all (its live dialog is a `ui.custom()`
// overlay the package renders itself; this only styles the persisted
// transcript call/result once the dialog has resolved).

/** `params.questions[0].question`, defensively — the schema guarantees at least one question, but args may not be validated yet while streaming. */
function firstQuestionText(args: unknown): string {
  if (!isRecord(args)) return "";
  const questions = args.questions;
  if (!Array.isArray(questions) || questions.length === 0) return "";
  const first: unknown = questions[0];
  return isRecord(first) ? asString(first.question) : "";
}

function renderAskUserQuestionCall(
  args: unknown,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const arg = truncateEnd(firstQuestionText(args), 80);
  return createToolHeader(bulletState(context), "AskUser", arg, theme, context.lastComponent);
}

/** The tool's result is always `{content: [{type: "text", text}], details: QuestionnaireResult}`, but treated defensively since that's an external package's contract, not this file's. */
const renderAskUserQuestionResult: RenderResult<any, any, any> = (
  result,
  options,
  theme,
  context,
) => {
  if (options.isPartial) return new Container();
  const text = resultText(result.content ?? []);
  if (context.isError) return renderErrorResult(text, options.expanded, theme);
  const summary = truncateEnd(firstNonEmptyLine(text) ?? "No response", 100);
  return renderCollapsibleResult(summary, text, options.expanded, theme);
};

// ---- Per-name reskin table ----

type Reskin = (original: McpDefinition, name: string) => McpDefinition;

function reskinMcpProxy(original: McpDefinition, name: string): McpDefinition {
  markReviewAnnotationConsumer([name]);
  return {
    ...original,
    renderShell: "self",
    renderCall: renderMcpProxyCall,
    renderResult: withReviewAnnotation(renderMcpResult),
  } as McpDefinition;
}

function reskinMcpScript(original: McpDefinition, name: string): McpDefinition {
  markReviewAnnotationConsumer([name]);
  return {
    ...original,
    renderShell: "self",
    renderCall: renderMcpScriptCall,
    renderResult: withReviewAnnotation(renderMcpResult),
  } as McpDefinition;
}

function reskinAskUserQuestion(original: McpDefinition, name: string): McpDefinition {
  // Guardian only skips its own separately-spaced entry for tools that claim
  // the annotation themselves; this tool shipped with no renderResult at
  // all, so guardian never had a reason to treat it as claimed until now.
  markReviewAnnotationConsumer([name]);
  return {
    ...original,
    renderShell: "self",
    renderCall: renderAskUserQuestionCall,
    renderResult: withReviewAnnotation(renderAskUserQuestionResult),
  } as McpDefinition;
}

/**
 * Minimal reskin: pi-schedule-prompt's own `renderCall`/`renderResult`
 * already read fine (colored status lines, a job table for `list`) — they
 * just render inside pi's bordered tool box because the tool never set
 * `renderShell: "self"`. Lifting it out of the box is the only change;
 * guardian's own "reviewed" annotation keeps appending exactly as it did
 * before, since `renderResult` is untouched.
 */
function reskinSchedulePrompt(original: McpDefinition): McpDefinition {
  return { ...original, renderShell: "self" } as McpDefinition;
}

const STATIC_RESKINS: Record<string, Reskin> = {
  mcp: reskinMcpProxy,
  mcpScript: reskinMcpScript,
  ask_user_question: reskinAskUserQuestion,
  schedule_prompt: reskinSchedulePrompt,
};

/**
 * `name` is the full registered tool name (e.g. "mcp__datadog_prod"); the
 * server display label is just that name with the prefix stripped, not a
 * reverse of the adapter's own server-name normalization (which lossily
 * folds hyphens and other punctuation into underscores) — good enough for a
 * header, not a way to recover the configured server name exactly.
 */
function reskinNamespaceProxy(original: McpDefinition, name: string): McpDefinition {
  markReviewAnnotationConsumer([name]);
  const serverDisplay = name.slice(NAMESPACE_PROXY_PREFIX.length);
  return {
    ...original,
    renderShell: "self",
    renderCall: renderNamespaceProxyCall(serverDisplay),
    renderResult: withReviewAnnotation(renderMcpResult),
  } as McpDefinition;
}

function reskinFor(name: string): Reskin | undefined {
  const staticReskin = STATIC_RESKINS[name];
  if (staticReskin) return staticReskin;
  // Namespace-proxy names are dynamic (one per configured MCP server, e.g.
  // "mcp__datadog_prod") and aren't known ahead of time, so this matches by
  // prefix instead of by an exact-name table entry.
  if (name.startsWith(NAMESPACE_PROXY_PREFIX)) return reskinNamespaceProxy;
  return undefined;
}

const wrapped = new WeakMap<McpDefinition, McpDefinition>();

function wrapDefinition(original: McpDefinition, name: string, reskin: Reskin): McpDefinition {
  const cached = wrapped.get(original);
  if (cached) return cached;
  const definition = reskin(original, name);
  wrapped.set(original, definition);
  return definition;
}

/**
 * Lookups of any name in `STATIC_RESKINS`, or any `mcp__<server>` namespace
 * proxy, return jpi-styled copies; every other name falls through to the
 * original definition unchanged. The actual prototype patch mechanics
 * (idempotence, saving the original, degrading to a no-op) live in
 * `src/pi/extension-runner.ts`'s `patchToolDefinitionLookup` — this is just
 * its transform.
 */
function reskinToolDefinition(
  toolName: string,
  original: (name: string) => unknown,
): McpDefinition | undefined {
  const definition = original(toolName) as McpDefinition | undefined;
  if (!definition) return definition;
  const reskin = reskinFor(toolName);
  if (!reskin) return definition;
  return wrapDefinition(definition, toolName, reskin);
}

/**
 * Patches `ExtensionRunner.prototype.getToolDefinition` so lookups of any
 * name in `STATIC_RESKINS`, or any `mcp__<server>` namespace proxy, return
 * jpi-styled copies. Idempotent: safe to call more than once. Degrades to a
 * no-op — those tools keep their original rendering — if `ExtensionRunner`'s
 * shape doesn't match what this expects.
 */
export function patchMcpToolRendering(): void {
  patchToolDefinitionLookup(reskinToolDefinition, (error) => {
    console.warn(`[jpi-style] could not restyle MCP tool rendering: ${errorMessage(error)}`);
  });
}
