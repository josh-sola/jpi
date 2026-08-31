/**
 * Restyles pi's tool-call transcript to read like Claude Code's output: a
 * bullet header per tool call and a one-line "⎿" summary for the collapsed
 * result, with content/diff bodies underneath for read/write/edit.
 *
 * A read/write/edit target inside the memories store or the scratchpad
 * root gets its own phrasing (e.g. "Recalled a memory (<slug>)") instead of
 * showing that path.
 *
 * `powershell` is intentionally left untouched.
 */

import { basename, extname, resolve } from "node:path";

import type {
  ExtensionAPI,
  Theme,
  ToolDefinition,
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
  getLanguageFromPath,
  highlightCode,
  renderDiff,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";

import {
  asString,
  bulletState,
  countLines,
  createResultLine,
  createToolHeader,
  displayPath,
  extractResultText,
  isWithinRoot,
  memoriesRoot,
  plural,
  scratchpadRoot,
  truncateEnd,
} from "../../src/core/index.ts";
import { countDiffStats, editResultDiff, type ToolRenderContext } from "../../src/pi/index.ts";
import {
  countFindResults,
  countGrepMatches,
  countLsEntries,
  countReadLines,
  firstNonEmptyLine,
  numberLines,
  stripTrailingBracketNotice,
  summarizeBashOutput,
  truncateCommand,
} from "./format.ts";

// Bodies (write/read content, edit diffs) render inline up to this many
// lines; beyond it they only show once the user expands the result.
const INLINE_BODY_LINE_LIMIT = 100;

/** `  ⎿  summary`, plus the full output beneath it when expanded. */
export function renderCollapsibleResult(
  summary: string,
  fullText: string,
  expanded: boolean,
  theme: Theme,
): Component {
  const container = new Container();
  container.addChild(createResultLine(summary, theme, "dim"));
  if (expanded && fullText) {
    container.addChild(
      new Text(
        fullText
          .split("\n")
          .map((line) => theme.fg("toolOutput", line))
          .join("\n"),
        0,
        0,
      ),
    );
  }
  return container;
}

/** Error text stays visible even when the result is collapsed. */
export function renderErrorResult(text: string, expanded: boolean, theme: Theme): Component {
  const preview = truncateEnd(firstNonEmptyLine(text) ?? "Error", 100);
  const container = new Container();
  container.addChild(createResultLine(preview, theme, "error"));
  if (expanded) {
    container.addChild(
      new Text(
        text
          .split("\n")
          .map((line) => theme.fg("error", line))
          .join("\n"),
        0,
        0,
      ),
    );
  }
  return container;
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

/** Registers a tool whose call/result rendering is just a header plus a one-line summary. */
function registerSimpleTool(
  pi: ExtensionAPI,
  definition: ToolDefinition<any, any, any>,
  displayName: string,
  argFor: (args: any, context: ToolRenderContext) => string,
  summarize: (text: string) => string,
): void {
  pi.registerTool({
    ...definition,
    renderShell: "self",
    renderCall(args, theme, context) {
      return createToolHeader(
        bulletState(context),
        displayName,
        argFor(args, context),
        theme,
        context.lastComponent,
      );
    },
    renderResult: makeResultRenderer(summarize),
  });
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

type ClassifiableTool = "read" | "write" | "edit";

// Trailing space is deliberate: unlike the plain "Name(arg)" headers, Claude
// Code's memory/scratchpad phrasing reads as a sentence fragment followed by
// a parenthetical, e.g. "Created a memory (<slug>)".
const CLASSIFIED_HEADER_NAME: Record<ClassifiableTool, { memory: string; scratchpad: string }> = {
  read: { memory: "Recalled a memory ", scratchpad: "Read from scratchpad " },
  write: { memory: "Created a memory ", scratchpad: "Wrote into scratchpad " },
  edit: { memory: "Updated a memory ", scratchpad: "Updated in scratchpad " },
};

type Placement =
  | { kind: "plain" }
  | { kind: "memory"; slug: string }
  | { kind: "scratchpad"; name: string };

function classifyPlacement(
  absPath: string,
  memoriesRootDir: string,
  scratchpadRootDir: string,
): Placement {
  if (isWithinRoot(memoriesRootDir, absPath)) {
    return { kind: "memory", slug: basename(absPath, extname(absPath)) };
  }
  if (isWithinRoot(scratchpadRootDir, absPath)) {
    return { kind: "scratchpad", name: basename(absPath) };
  }
  return { kind: "plain" };
}

/** Header name/arg for read/write/edit, given where the target path lands. */
function headerFor(
  tool: ClassifiableTool,
  rawPath: string,
  cwd: string,
  memoriesRootDir: string,
  scratchpadRootDir: string,
): { name: string; arg: string; placement: Placement } {
  const placement = classifyPlacement(resolve(cwd, rawPath), memoriesRootDir, scratchpadRootDir);
  if (placement.kind === "memory") {
    return { name: CLASSIFIED_HEADER_NAME[tool].memory, arg: placement.slug, placement };
  }
  if (placement.kind === "scratchpad") {
    return { name: CLASSIFIED_HEADER_NAME[tool].scratchpad, arg: placement.name, placement };
  }
  return { name: DISPLAY_NAMES[tool], arg: displayPath(rawPath, cwd), placement };
}

/** Syntax-highlighted, line-numbered content body for read/write previews. */
function renderContentBody(rawPath: string, content: string, startAt: number): Component {
  const lang = getLanguageFromPath(rawPath);
  const rawLines = content.split("\n");
  const highlighted = lang ? highlightCode(content, lang) : rawLines;
  return new Text(numberLines(highlighted, startAt).join("\n"), 0, 0);
}

/**
 * pi's edit result already carries a display-oriented diff with its own
 * line-number gutter (`generateDiffString`); `renderDiff` only colors it, so
 * this renders exactly what it returns, indented to sit under the "⎿" line.
 */
function renderDiffBody(diff: string, rawPath: string): Component {
  const rendered = renderDiff(diff, { ...(rawPath && { filePath: rawPath }) });
  return new Text(
    rendered
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
    0,
    0,
  );
}

function showsInlineBody(lineCount: number, expanded: boolean): boolean {
  return lineCount > 0 && (lineCount <= INLINE_BODY_LINE_LIMIT || expanded);
}

export interface StyleToolsOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  scratchpadTempRoot?: string;
}

// pi-internal(builtin-tool-shadowing): relies on extension registrations
// shadowing pi's built-ins by name; load order in extensions/jpi/index.ts is
// load-bearing.
export function registerStyleTools(pi: ExtensionAPI, options: StyleToolsOptions = {}): void {
  const cwd = process.cwd();
  const memoriesRootDir = memoriesRoot(options.env, options.homeDirectory);
  const scratchpadRootDir = scratchpadRoot(options.scratchpadTempRoot);

  pi.registerTool({
    ...createReadToolDefinition(cwd),
    renderShell: "self",
    renderCall(args, theme, context) {
      const { name, arg } = headerFor(
        "read",
        asString(args.path),
        context.cwd,
        memoriesRootDir,
        scratchpadRootDir,
      );
      return createToolHeader(bulletState(context), name, arg, theme, context.lastComponent);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Container();
      const text = extractResultText(result.content);
      if (context.isError) return renderErrorResult(text, options.expanded, theme);

      const rawPath = asString((context.args as { path?: unknown }).path);
      const n = countReadLines(text);
      const summary = `Read ${n} ${plural(n, "line")}`;

      const container = new Container();
      container.addChild(createResultLine(summary, theme, "dim"));
      if (options.expanded) {
        const content = stripTrailingBracketNotice(text);
        const offsetArg = (context.args as { offset?: unknown }).offset;
        const startAt = typeof offsetArg === "number" ? offsetArg : 1;
        container.addChild(renderContentBody(rawPath, content, startAt));
        const notice = content === text ? "" : text.slice(content.length).replace(/^\n+/, "");
        if (notice) container.addChild(new Text(theme.fg("warning", notice), 0, 0));
      }
      return container;
    },
  });

  registerSimpleTool(
    pi,
    createBashToolDefinition(cwd),
    DISPLAY_NAMES.bash,
    (args) => truncateCommand(asString(args.command)),
    (text) => summarizeBashOutput(text),
  );

  pi.registerTool({
    ...createEditToolDefinition(cwd),
    renderShell: "self",
    renderCall(args, theme, context) {
      const { name, arg } = headerFor(
        "edit",
        asString(args.path),
        context.cwd,
        memoriesRootDir,
        scratchpadRootDir,
      );
      return createToolHeader(bulletState(context), name, arg, theme, context.lastComponent);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Container();
      const text = extractResultText(result.content);
      if (context.isError) return renderErrorResult(text, options.expanded, theme);

      const rawPath = asString((context.args as { path?: unknown }).path);
      const diff = editResultDiff(result.details);

      const container = new Container();
      if (!diff) {
        container.addChild(createResultLine("Updated", theme, "dim"));
        return container;
      }

      const { additions, removals } = countDiffStats(diff);
      const summary =
        additions > 0 && removals === 0
          ? `Added ${additions} ${plural(additions, "line")}`
          : removals > 0 && additions === 0
            ? `Removed ${removals} ${plural(removals, "line")}`
            : `Updated with ${additions} ${plural(additions, "addition")} and ${removals} ${plural(removals, "removal")}`;
      container.addChild(createResultLine(summary, theme, "dim"));

      const diffLineCount = countLines(diff);
      if (showsInlineBody(diffLineCount, options.expanded)) {
        container.addChild(renderDiffBody(diff, rawPath));
      }
      return container;
    },
  });

  pi.registerTool({
    ...createWriteToolDefinition(cwd),
    renderShell: "self",
    renderCall(args, theme, context) {
      const { name, arg } = headerFor(
        "write",
        asString(args.path),
        context.cwd,
        memoriesRootDir,
        scratchpadRootDir,
      );
      return createToolHeader(bulletState(context), name, arg, theme, context.lastComponent);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Container();
      const text = extractResultText(result.content);
      if (context.isError) return renderErrorResult(text, options.expanded, theme);

      const writeArgs = context.args as { path?: unknown; content?: unknown };
      const rawPath = asString(writeArgs.path);
      const content = asString(writeArgs.content);
      const lines = countLines(content);
      const { placement } = headerFor(
        "write",
        rawPath,
        context.cwd,
        memoriesRootDir,
        scratchpadRootDir,
      );
      const summary =
        placement.kind === "plain"
          ? `Wrote ${lines} ${plural(lines, "line")} to ${displayPath(rawPath, context.cwd)}`
          : `Wrote ${lines} ${plural(lines, "line")}`;

      const container = new Container();
      container.addChild(createResultLine(summary, theme, "dim"));
      if (showsInlineBody(lines, options.expanded)) {
        container.addChild(renderContentBody(rawPath, content, 1));
      }
      return container;
    },
  });

  registerSimpleTool(
    pi,
    createGrepToolDefinition(cwd),
    DISPLAY_NAMES.grep,
    (args) => truncateEnd(asString(args.pattern), 80),
    (text) => {
      const n = countGrepMatches(text);
      return `Found ${n} ${plural(n, "match", "matches")}`;
    },
  );

  registerSimpleTool(
    pi,
    createFindToolDefinition(cwd),
    DISPLAY_NAMES.find,
    (args) => truncateEnd(asString(args.pattern), 80),
    (text) => {
      const n = countFindResults(text);
      return `Found ${n} ${plural(n, "file")}`;
    },
  );

  registerSimpleTool(
    pi,
    createLsToolDefinition(cwd),
    DISPLAY_NAMES.ls,
    (args, context) => displayPath(asString(args.path) || ".", context.cwd),
    (text) => {
      const n = countLsEntries(text);
      return `Listed ${n} ${plural(n, "path")}`;
    },
  );
}
