/**
 * Rendering tests for get_subagent_result and steer_subagent: the
 * Claude-Code-style `⏺ Name(arg)` header and the collapsed `⎿` result summary.
 * The Agent tool's own renderCall/renderResult are covered elsewhere and are
 * untouched here.
 */
import { describe, expect, it, vi } from "vite-plus/test";
import { subagentsExtension } from "./helpers/boot-extension.ts";

async function bootTools() {
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
  return tools;
}

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function context(overrides: Record<string, unknown> = {}) {
  return { isError: false, ...overrides };
}

function renderCall(tool: any, args: any): string {
  return tool.renderCall(args, theme, { lastComponent: undefined }).render(120).join("\n");
}

function renderResult(tool: any, result: any, overrides: Record<string, unknown> = {}): string {
  return tool
    .renderResult(
      { content: result.content },
      { expanded: false, isPartial: false },
      theme,
      context(overrides),
    )
    .render(120)
    .join("\n");
}

describe("get_subagent_result rendering", () => {
  it("renders a ⏺ Subagent(result: <name-or-id>) header", async () => {
    const tools = await bootTools();
    const output = renderCall(tools.get("get_subagent_result"), { agent_id: "explore-2" });
    expect(output).toBe("⏺ Subagent(result: explore-2)");
  });

  it("summarizes the collapsed result as its first line", async () => {
    const tools = await bootTools();
    const output = renderResult(tools.get("get_subagent_result"), {
      content: [
        {
          type: "text",
          text: "Agent: explore-2\nType: explore | Status: completed\n\nFound the bug.",
        },
      ],
    });
    expect(output).toBe("  ⎿  Agent: explore-2");
  });

  it("shows the first error line on the ⎿ line when the result is an error", async () => {
    const tools = await bootTools();
    const output = renderResult(
      tools.get("get_subagent_result"),
      {
        content: [{ type: "text", text: 'Agent not found: "nope". It may have been cleaned up.' }],
      },
      { isError: true },
    );
    expect(output).toBe('  ⎿  Agent not found: "nope". It may have been cleaned up.');
  });
});

describe("steer_subagent rendering", () => {
  it("renders a ⏺ Subagent(steer: <name-or-id>) header", async () => {
    const tools = await bootTools();
    const output = renderCall(tools.get("steer_subagent"), { agent_id: "explore", message: "hi" });
    expect(output).toBe("⏺ Subagent(steer: explore)");
  });

  it("summarizes the collapsed result as its first line", async () => {
    const tools = await bootTools();
    const output = renderResult(tools.get("steer_subagent"), {
      content: [
        {
          type: "text",
          text: "Steering message sent to agent explore.\nCurrent state: 3 tool uses",
        },
      ],
    });
    expect(output).toBe("  ⎿  Steering message sent to agent explore.");
  });

  it("shows the first error line on the ⎿ line when the result is an error", async () => {
    const tools = await bootTools();
    const output = renderResult(
      tools.get("steer_subagent"),
      { content: [{ type: "text", text: 'Agent "explore" is not running (status: completed).' }] },
      { isError: true },
    );
    expect(output).toBe('  ⎿  Agent "explore" is not running (status: completed).');
  });
});
