import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { ExtensionRunner, initTheme, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { patchMcpToolRendering } from "../../modules/style/mcp-style.ts";
import { bootRealSession } from "../pi/helpers/real-session.ts";

initTheme();

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

function testTheme(): Theme {
  const fgColors = Object.fromEntries(THEME_COLOR_NAMES.map((name) => [name, 7]));
  const bgColors = Object.fromEntries(THEME_BG_NAMES.map((name) => [name, 0]));
  return new Theme(fgColors as never, bgColors as never, "256color");
}

function plainLines(component: { render(width: number): string[] }, width = 120): string[] {
  return component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

/** A minimal stand-in for a real ExtensionRunner: just enough of `this.extensions` for getToolDefinition to walk. */
function fakeRunner(definitionsByName: Record<string, any>): any {
  const runner = Object.create(ExtensionRunner.prototype);
  const tools = new Map(
    Object.entries(definitionsByName).map(([name, definition]) => [name, { definition }]),
  );
  runner.extensions = [{ tools }];
  return runner;
}

function context(overrides: Record<string, unknown> = {}): any {
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
    expanded: false,
    isError: false,
    ...overrides,
  };
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text", text }], details };
}

test("a live AgentSession registry receives the styled mcp definition", async () => {
  const handle = await bootRealSession();
  try {
    patchMcpToolRendering();
    const execute = async () => ({ content: [], details: {} });
    const original = {
      name: "mcp",
      label: "MCP",
      description: "d",
      parameters: Type.Object({}),
      execute,
    };
    handle.pi.registerTool(original);

    const styled = handle.session.getToolDefinition("mcp") as any;
    assert.notEqual(styled, original);
    assert.equal(styled.renderShell, "self");
    assert.equal(styled.execute, execute);

    const args = { server: "xcode", tool: "xcodebuild_list_sims" };
    const lines = plainLines(styled.renderCall!(args, testTheme(), context({ args })));
    assert.equal(lines[0], "⏺ MCP(xcode/xcodebuild_list_sims)");
  } finally {
    await handle.dispose();
  }
}, 30_000);

test("patching wraps the mcpScript lookup with jpi's renderers, execute untouched", () => {
  patchMcpToolRendering();
  const execute = async () => ({ content: [], details: {} });
  const original = {
    name: "mcpScript",
    label: "MCP Script",
    description: "d",
    parameters: {},
    execute,
  };
  const runner = fakeRunner({ mcpScript: original });

  const wrapped = runner.getToolDefinition("mcpScript");

  assert.notEqual(wrapped, original);
  assert.equal(wrapped.renderShell, "self");
  assert.equal(typeof wrapped.renderCall, "function");
  assert.equal(typeof wrapped.renderResult, "function");
  assert.equal(wrapped.execute, execute);
  assert.equal(wrapped.label, "MCP Script");
});

test("repeated lookups of the same original definition return the identical wrapped object", () => {
  patchMcpToolRendering();
  const original = {
    name: "mcp",
    label: "MCP",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ mcp: original });

  const first = runner.getToolDefinition("mcp");
  const second = runner.getToolDefinition("mcp");

  assert.equal(first, second);
});

test("a non-MCP tool name passes through untouched", () => {
  patchMcpToolRendering();
  const original = {
    name: "read",
    label: "Read",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ read: original });

  const result = runner.getToolDefinition("read");

  assert.equal(result, original);
});

test("an unregistered tool name still returns undefined", () => {
  patchMcpToolRendering();
  const runner = fakeRunner({});
  assert.equal(runner.getToolDefinition("nope"), undefined);
});

test("patching twice is idempotent: still wraps, still one cached object per definition", () => {
  patchMcpToolRendering();
  patchMcpToolRendering();
  const original = {
    name: "mcpScript",
    label: "MCP Script",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ mcpScript: original });

  const first = runner.getToolDefinition("mcpScript");
  const second = runner.getToolDefinition("mcpScript");

  assert.equal(first.renderShell, "self");
  assert.equal(first, second);
});

test("renderCall for mcpScript shows the bullet, name, and first code line", () => {
  patchMcpToolRendering();
  const original = {
    name: "mcpScript",
    label: "MCP Script",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ mcpScript: original });
  const wrapped = runner.getToolDefinition("mcpScript");

  const args = { code: "\n\nconst x = await tools.search({ query: 'foo' });\nemit(x);" };
  const lines = plainLines(wrapped.renderCall(args, testTheme(), context({ args })));

  assert.equal(lines[0], "⏺ McpScript(const x = await tools.search({ query: 'foo' });)");
});

test("renderCall for mcp formats a server/tool target with a compact args hint", () => {
  patchMcpToolRendering();
  const original = {
    name: "mcp",
    label: "MCP",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ mcp: original });
  const wrapped = runner.getToolDefinition("mcp");

  const args = { tool: "xcodebuild_list_sims", server: "xcode", args: { foo: "bar" } };
  const lines = plainLines(wrapped.renderCall(args, testTheme(), context({ args })));

  assert.equal(lines[0], '⏺ MCP(xcode/xcodebuild_list_sims {"foo":"bar"})');
});

test("renderCall for mcp degrades to a raw dump for unrecognized args, never throwing", () => {
  patchMcpToolRendering();
  const original = {
    name: "mcp",
    label: "MCP",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ mcp: original });
  const wrapped = runner.getToolDefinition("mcp");

  assert.doesNotThrow(() => {
    const lines = plainLines(wrapped.renderCall({}, testTheme(), context({ args: {} })));
    assert.equal(lines[0], "⏺ MCP(status)");
  });
});

test("renderResult collapsed shows a one-line ⎿ summary", () => {
  patchMcpToolRendering();
  const original = {
    name: "mcpScript",
    label: "MCP Script",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ mcpScript: original });
  const wrapped = runner.getToolDefinition("mcpScript");

  const lines = plainLines(
    wrapped.renderResult(
      textResult("first line\nsecond line\nthird line"),
      { expanded: false, isPartial: false },
      testTheme(),
      context(),
    ),
  );

  assert.equal(lines[0], "  ⎿  first line … +2 lines");
});

test("renderResult expanded shows the full text", () => {
  patchMcpToolRendering();
  const original = {
    name: "mcpScript",
    label: "MCP Script",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ mcpScript: original });
  const wrapped = runner.getToolDefinition("mcpScript");

  const lines = plainLines(
    wrapped.renderResult(
      textResult("first line\nsecond line"),
      { expanded: true, isPartial: false },
      testTheme(),
      context({ expanded: true }),
    ),
  );

  assert.equal(lines[0], "  ⎿  first line … +1 lines");
  assert.ok(lines.includes("first line"));
  assert.ok(lines.includes("second line"));
});

test("renderResult on an error carries the error treatment", () => {
  patchMcpToolRendering();
  const original = {
    name: "mcp",
    label: "MCP",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ mcp: original });
  const wrapped = runner.getToolDefinition("mcp");

  const lines = plainLines(
    wrapped.renderResult(
      textResult("boom: tool not found"),
      { expanded: false, isPartial: false },
      testTheme(),
      context({ isError: true }),
    ),
  );

  assert.equal(lines[0], "  ⎿  boom: tool not found");
});

test("renderResult treats a details.error payload as an error even when context.isError is false", () => {
  patchMcpToolRendering();
  const original = {
    name: "mcp",
    label: "MCP",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ mcp: original });
  const wrapped = runner.getToolDefinition("mcp");

  const lines = plainLines(
    wrapped.renderResult(
      textResult("MCP not initialized", { mode: "call", error: "not_initialized" }),
      { expanded: false, isPartial: false },
      testTheme(),
      context({ isError: false }),
    ),
  );

  assert.equal(lines[0], "  ⎿  MCP not initialized");
});

test("renderResult returns an empty component while partial", () => {
  patchMcpToolRendering();
  const original = {
    name: "mcp",
    label: "MCP",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ mcp: original });
  const wrapped = runner.getToolDefinition("mcp");

  const lines = plainLines(
    wrapped.renderResult(
      textResult(""),
      { expanded: false, isPartial: true },
      testTheme(),
      context(),
    ),
  );

  assert.deepEqual(lines, []);
});

// ---- namespace proxy tools (mcp__<server>) ----

test("a namespace proxy tool name gets wrapped", () => {
  patchMcpToolRendering();
  const original = {
    name: "mcp__datadog-prod",
    label: "MCP: datadog-prod",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ "mcp__datadog-prod": original });

  const wrapped = runner.getToolDefinition("mcp__datadog-prod");

  assert.notEqual(wrapped, original);
  assert.equal(wrapped.renderShell, "self");
  assert.equal(typeof wrapped.renderCall, "function");
  assert.equal(typeof wrapped.renderResult, "function");
  assert.equal(wrapped.execute, original.execute);
});

test("renderCall for a namespace proxy shows server/tool derived from its name, plus a compact args hint", () => {
  patchMcpToolRendering();
  const original = {
    name: "mcp__datadog-prod",
    label: "MCP: datadog-prod",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ "mcp__datadog-prod": original });
  const wrapped = runner.getToolDefinition("mcp__datadog-prod");

  const args = { tool: "search_datadog_logs", args: { query: "service:foo" } };
  const lines = plainLines(wrapped.renderCall(args, testTheme(), context({ args })));

  assert.equal(lines[0], '⏺ MCP(datadog-prod/search_datadog_logs {"query":"service:foo"})');
});

// ---- ask_user_question ----

test("ask_user_question gets a header and result renderer where it previously had none", () => {
  patchMcpToolRendering();
  const original = {
    name: "ask_user_question",
    label: "Ask User Question",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ ask_user_question: original });

  const wrapped = runner.getToolDefinition("ask_user_question");

  assert.notEqual(wrapped, original);
  assert.equal(wrapped.renderShell, "self");
  assert.equal(typeof wrapped.renderCall, "function");
  assert.equal(typeof wrapped.renderResult, "function");
  assert.equal(wrapped.execute, original.execute);
});

test("renderCall for ask_user_question shows the first question, truncated", () => {
  patchMcpToolRendering();
  const original = {
    name: "ask_user_question",
    label: "Ask User Question",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ ask_user_question: original });
  const wrapped = runner.getToolDefinition("ask_user_question");

  const args = {
    questions: [{ question: "Which library should we use?", header: "Library", options: [] }],
  };
  const lines = plainLines(wrapped.renderCall(args, testTheme(), context({ args })));

  assert.equal(lines[0], "⏺ AskUser(Which library should we use?)");
});

test("renderResult for ask_user_question collapses the answered envelope to one line", () => {
  patchMcpToolRendering();
  const original = {
    name: "ask_user_question",
    label: "Ask User Question",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ ask_user_question: original });
  const wrapped = runner.getToolDefinition("ask_user_question");

  const lines = plainLines(
    wrapped.renderResult(
      textResult('User has answered your questions: "Library"="zod". You can now continue.', {
        answers: [],
        cancelled: false,
      }),
      { expanded: false, isPartial: false },
      testTheme(),
      context(),
    ),
  );

  assert.equal(
    lines[0],
    '  ⎿  User has answered your questions: "Library"="zod". You can now continue.',
  );
});

test("renderResult for ask_user_question is defensive about an unexpected result shape", () => {
  patchMcpToolRendering();
  const original = {
    name: "ask_user_question",
    label: "Ask User Question",
    description: "d",
    parameters: {},
    execute: async () => ({}),
  };
  const runner = fakeRunner({ ask_user_question: original });
  const wrapped = runner.getToolDefinition("ask_user_question");

  assert.doesNotThrow(() => {
    const lines = plainLines(
      wrapped.renderResult(
        { content: [] },
        { expanded: false, isPartial: false },
        testTheme(),
        context(),
      ),
    );
    assert.equal(lines[0], "  ⎿  No response");
  });
});

// ---- schedule_prompt ----

test("schedule_prompt keeps its own renderCall/renderResult and only gains renderShell: self", () => {
  patchMcpToolRendering();
  const originalRenderCall = () => new Text("x", 0, 0);
  const originalRenderResult = () => new Text("y", 0, 0);
  const original = {
    name: "schedule_prompt",
    label: "Schedule Prompt",
    description: "d",
    parameters: {},
    execute: async () => ({}),
    renderCall: originalRenderCall,
    renderResult: originalRenderResult,
  };
  const runner = fakeRunner({ schedule_prompt: original });

  const wrapped = runner.getToolDefinition("schedule_prompt");

  assert.notEqual(wrapped, original);
  assert.equal(wrapped.renderShell, "self");
  assert.equal(wrapped.renderCall, originalRenderCall);
  assert.equal(wrapped.renderResult, originalRenderResult);
  assert.equal(wrapped.execute, original.execute);
});
