/**
 * Rendering tests for the Agent tool's own renderCall/renderResult, now that
 * it's card-less like every other jpi tool: the bullet header (badged or
 * plain name, muted description) and the `⎿` result-line convention. The
 * jpi theme paints no tool-box tint any more, so the old row-background
 * workaround (rowBackground / restoreBackground) is gone — these tests guard
 * against it quietly reappearing.
 *
 * Pre-execution-failure (#199) and unstructured-result cases are covered in
 * agent-tool-error-rendering.test.ts and are untouched by this change.
 */
import { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { registerAgents } from "../../modules/subagents/agent-types.ts";
import type { AgentConfig } from "../../modules/subagents/types.ts";
import { subagentsExtension } from "./helpers/boot-extension.ts";

async function agentTool() {
  const tools = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  await subagentsExtension(pi);
  return tools.get("Agent");
}

const THEME_COLOR_NAMES = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "bashMode",
];

const THEME_BG_NAMES = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
];

/** Real `Theme` (256-color, no disk access) — needed so ANSI-escape assertions test the genuine mechanism, not a fake stub. */
function testTheme(): Theme {
  const fgColors = Object.fromEntries(THEME_COLOR_NAMES.map((name) => [name, 7]));
  const bgColors = Object.fromEntries(THEME_BG_NAMES.map((name) => [name, 0]));
  return new Theme(fgColors as never, bgColors as never, "256color");
}

function plainLines(component: { render(width: number): string[] }, width = 120): string[] {
  return component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    args: {},
    toolCallId: "call-1",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    isError: false,
    ...overrides,
  };
}

const CONFIG: AgentConfig = {
  name: "colored-explorer",
  displayName: "Explorer",
  color: "purple",
  description: "Explores code",
  extensions: false,
  skills: false,
  systemPrompt: "Explore.",
  promptMode: "replace",
};

afterEach(() => {
  registerAgents(new Map());
});

describe("Agent tool call header", () => {
  it("shows bullet + badged agent name + muted description", async () => {
    // subagentsExtension's own setup reloads (and so clears) the custom-agent
    // registry, so the color config must be (re-)registered after it, not
    // just before — matching agent-color-surfaces.test.ts's pattern.
    registerAgents(new Map([[CONFIG.name, CONFIG]]));
    const tool = await agentTool();
    registerAgents(new Map([[CONFIG.name, CONFIG]]));
    const theme = testTheme();
    const lines = plainLines(
      tool.renderCall(
        { subagent_type: CONFIG.name, description: "Audit the auth flow" },
        theme,
        context(),
      ),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("⏺ ");
    expect(lines[0]).toContain("Explorer");
    expect(lines[0]).toContain("(Audit the auth flow)");
  });

  it("shows bullet + plain name + muted description for an unbadged agent", async () => {
    // "general-purpose" is a real, built-in agent type with no configured
    // color — an uncolored (unbadged) agent renders its plain display name.
    const tool = await agentTool();
    const theme = testTheme();
    const lines = plainLines(
      tool.renderCall(
        { subagent_type: "general-purpose", description: "Fix the flaky test" },
        theme,
        context(),
      ),
    );

    expect(lines[0]).toBe("⏺ general-purpose(Fix the flaky test)");
  });

  it("carries pending/running/success/error state on the bullet, like every other tool", async () => {
    const tool = await agentTool();
    const theme = testTheme();
    const args = { subagent_type: "general-purpose", description: "d" };
    const render = (overrides: Record<string, unknown>) =>
      tool.renderCall(args, theme, context(overrides)).render(120)[0];

    expect(render({ executionStarted: false })).toContain(theme.fg("muted", "⏺ "));
    expect(render({ isPartial: true })).toContain(theme.fg("muted", "⏺ "));
    expect(render({})).toContain(theme.fg("success", "⏺ "));
    expect(render({ isError: true })).toContain(theme.fg("error", "⏺ "));
  });

  it("carries no background escape beyond the badge's own, in every bullet state", async () => {
    registerAgents(new Map([[CONFIG.name, CONFIG]]));
    const tool = await agentTool();
    registerAgents(new Map([[CONFIG.name, CONFIG]]));
    const theme = testTheme();
    const args = { subagent_type: CONFIG.name, description: "d" };

    for (const overrides of [
      {},
      { executionStarted: false },
      { isPartial: true },
      { isError: true },
    ]) {
      const raw = tool.renderCall(args, theme, context(overrides)).render(120).join("\n");
      const backgroundOpens = raw.match(/\x1b\[48/g) ?? [];
      expect(backgroundOpens).toHaveLength(1); // exactly the badge's own background
    }
  });

  it("carries no background escape at all for an unbadged agent", async () => {
    const tool = await agentTool();
    const theme = testTheme();
    const raw = tool
      .renderCall(
        { subagent_type: "general-purpose", description: "d" },
        theme,
        context({ isError: true }),
      )
      .render(120)
      .join("\n");

    expect(raw).not.toMatch(/\x1b\[48/);
  });
});

describe("Agent tool result ⎿ line", () => {
  function renderResult(
    tool: any,
    content: string,
    details: unknown,
    optionsOverrides: Record<string, unknown> = {},
  ): string[] {
    return plainLines(
      tool.renderResult(
        { content: [{ type: "text", text: content }], details },
        { expanded: false, isPartial: false, ...optionsOverrides },
        testTheme(),
        context(),
      ),
    );
  }

  it("shows a ⎿ line for a background-launched agent", async () => {
    const tool = await agentTool();
    const lines = renderResult(tool, "", { status: "background", agentId: "abc123", toolUses: 0 });
    expect(lines).toContain("  ⎿  Running in background (ID: abc123)");
  });

  it("shows a ⎿ line for a completed agent, collapsed", async () => {
    const tool = await agentTool();
    const lines = renderResult(tool, "the result", {
      status: "completed",
      toolUses: 2,
      tokens: "1.2k",
      durationMs: 1500,
    });
    expect(lines).toContain("  ⎿  Done");
  });

  it("shows a ⎿ line for a steered agent, collapsed", async () => {
    const tool = await agentTool();
    const lines = renderResult(tool, "the result", {
      status: "steered",
      toolUses: 2,
      durationMs: 1500,
    });
    expect(lines).toContain("  ⎿  Wrapped up (turn limit)");
  });

  it("shows a ⎿ line for a stopped agent", async () => {
    const tool = await agentTool();
    const lines = renderResult(tool, "", { status: "stopped", toolUses: 0 });
    expect(lines).toContain("  ⎿  Stopped");
  });

  it("shows a ⎿ line for an error", async () => {
    const tool = await agentTool();
    const lines = renderResult(tool, "", { status: "error", error: "boom", toolUses: 0 });
    expect(lines).toContain("  ⎿  Error: boom");
  });

  it("shows a ⎿ line for an aborted (max turns) run", async () => {
    const tool = await agentTool();
    const lines = renderResult(tool, "", { status: "aborted", toolUses: 0 });
    expect(lines).toContain("  ⎿  Aborted (max turns exceeded)");
  });

  it("expanded shows the full result text without a ⎿ line", async () => {
    const tool = await agentTool();
    const lines = renderResult(
      tool,
      "line one\nline two",
      { status: "completed", toolUses: 0, durationMs: 100 },
      { expanded: true },
    );
    expect(lines.some((l) => l === "  ⎿  Done")).toBe(false);
    expect(lines.some((l) => l.includes("line one"))).toBe(true);
    expect(lines.some((l) => l.includes("line two"))).toBe(true);
  });
});
