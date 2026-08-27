/**
 * Restyles pi's tool-call transcript to read like Claude Code's output: a
 * bullet header per tool call and a one-line "⎿" summary for the collapsed
 * result.
 *
 * `powershell` is intentionally left untouched.
 */

import type {
  EditToolDetails,
  ExtensionAPI,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";

// Local mirror of pi's ToolRenderContext: pi-coding-agent 0.84.3's root barrel
// does not re-export it. Delete once upstream exports it.
interface ToolRenderContext<TState = any, TArgs = any> {
  args: TArgs;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: TState;
  cwd: string;
  executionStarted: boolean;
  argsComplete: boolean;
  isPartial: boolean;
  expanded: boolean;
  isError: boolean;
}

import {
  asString,
  bulletState,
  countDiffStats,
  countFindResults,
  countGrepMatches,
  countLines,
  countLsEntries,
  countReadLines,
  extractResultText,
  firstNonEmptyLine,
  plural,
  relativizePath,
  summarizeBashOutput,
  truncateCommand,
  truncateSingleLine,
} from "./format.ts";

/** `⏺ Name(arg)` header, bullet colored by execution state. */
function renderHeader(
  displayName: string,
  primaryArg: string,
  theme: Theme,
  context: ToolRenderContext,
): Component {
  const state = bulletState(context);
  const bulletColor = state === "success" ? "success" : state === "error" ? "error" : "muted";
  const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  text.setText(
    `${theme.fg(bulletColor, "⏺ ")}${theme.bold(displayName)}(${theme.fg("muted", primaryArg)})`,
  );
  return text;
}

/** `  ⎿  summary`, plus the full output beneath it when expanded. */
function renderCollapsibleResult(
  summary: string,
  fullText: string,
  expanded: boolean,
  theme: Theme,
): Component {
  let text = `  ${theme.fg("dim", "⎿")}  ${theme.fg("dim", summary)}`;
  if (expanded && fullText) {
    text += `\n${fullText
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n")}`;
  }
  return new Text(text, 0, 0);
}

/** Error text stays visible even when the result is collapsed. */
function renderErrorResult(text: string, expanded: boolean, theme: Theme): Component {
  const preview = truncateSingleLine(firstNonEmptyLine(text) ?? "Error", 100);
  let out = `  ${theme.fg("error", "⎿")}  ${theme.fg("error", preview)}`;
  if (expanded) {
    out += `\n${text
      .split("\n")
      .map((line) => theme.fg("error", line))
      .join("\n")}`;
  }
  return new Text(out, 0, 0);
}

/** Shared renderResult scaffolding: partial/error handling, then a tool-specific summary. */
function makeResultRenderer(summarize: (text: string) => string) {
  return function renderResult(
    result: { content: ReadonlyArray<{ type: string; text?: string }> },
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContext,
  ): Component {
    if (options.isPartial) return new Container();
    const text = extractResultText(result.content);
    if (context.isError) return renderErrorResult(text, options.expanded, theme);
    return renderCollapsibleResult(summarize(text), text, options.expanded, theme);
  };
}

const DISPLAY_NAMES = {
  read: "Read",
  bash: "Bash",
  edit: "Update",
  write: "Write",
  grep: "Search",
  find: "Find",
  ls: "List",
} as const;

export function registerStyleTools(pi: ExtensionAPI): void {
  const cwd = process.cwd();

  pi.registerTool({
    ...createReadToolDefinition(cwd),
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderHeader(
        DISPLAY_NAMES.read,
        relativizePath(asString(args.path), context.cwd),
        theme,
        context,
      );
    },
    renderResult: makeResultRenderer((text) => {
      const n = countReadLines(text);
      return `Read ${n} ${plural(n, "line")}`;
    }),
  });

  pi.registerTool({
    ...createBashToolDefinition(cwd),
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderHeader(
        DISPLAY_NAMES.bash,
        truncateCommand(asString(args.command)),
        theme,
        context,
      );
    },
    renderResult: makeResultRenderer((text) => summarizeBashOutput(text)),
  });

  pi.registerTool({
    ...createEditToolDefinition(cwd),
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderHeader(
        DISPLAY_NAMES.edit,
        relativizePath(asString(args.path), context.cwd),
        theme,
        context,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Container();
      const text = extractResultText(result.content);
      if (context.isError) return renderErrorResult(text, options.expanded, theme);
      const relPath = relativizePath(
        asString((context.args as { path?: unknown }).path),
        context.cwd,
      );
      const diff = (result.details as EditToolDetails | undefined)?.diff;
      if (!diff) return renderCollapsibleResult(`Updated ${relPath}`, "", options.expanded, theme);
      const { additions, removals } = countDiffStats(diff);
      const summary = `Updated ${relPath} with ${additions} ${plural(additions, "addition")} and ${removals} ${plural(removals, "removal")}`;
      let out = `  ${theme.fg("dim", "⎿")}  ${theme.fg("dim", summary)}`;
      if (options.expanded) {
        out += `\n${diff
          .split("\n")
          .map((line) => {
            if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("success", line);
            if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("error", line);
            return theme.fg("dim", line);
          })
          .join("\n")}`;
      }
      return new Text(out, 0, 0);
    },
  });

  pi.registerTool({
    ...createWriteToolDefinition(cwd),
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderHeader(
        DISPLAY_NAMES.write,
        relativizePath(asString(args.path), context.cwd),
        theme,
        context,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Container();
      const text = extractResultText(result.content);
      if (context.isError) return renderErrorResult(text, options.expanded, theme);
      const writeArgs = context.args as { path?: unknown; content?: unknown };
      const relPath = relativizePath(asString(writeArgs.path), context.cwd);
      const lines = countLines(asString(writeArgs.content));
      const summary = `Wrote ${lines} ${plural(lines, "line")} to ${relPath}`;
      return renderCollapsibleResult(summary, text, options.expanded, theme);
    },
  });

  pi.registerTool({
    ...createGrepToolDefinition(cwd),
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderHeader(
        DISPLAY_NAMES.grep,
        truncateSingleLine(asString(args.pattern), 80),
        theme,
        context,
      );
    },
    renderResult: makeResultRenderer((text) => {
      const n = countGrepMatches(text);
      return `Found ${n} ${plural(n, "match", "matches")}`;
    }),
  });

  pi.registerTool({
    ...createFindToolDefinition(cwd),
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderHeader(
        DISPLAY_NAMES.find,
        truncateSingleLine(asString(args.pattern), 80),
        theme,
        context,
      );
    },
    renderResult: makeResultRenderer((text) => {
      const n = countFindResults(text);
      return `Found ${n} ${plural(n, "file")}`;
    }),
  });

  pi.registerTool({
    ...createLsToolDefinition(cwd),
    renderShell: "self",
    renderCall(args, theme, context) {
      return renderHeader(
        DISPLAY_NAMES.ls,
        relativizePath(asString(args.path) || ".", context.cwd),
        theme,
        context,
      );
    },
    renderResult: makeResultRenderer((text) => {
      const n = countLsEntries(text);
      return `Listed ${n} ${plural(n, "path")}`;
    }),
  });
}
