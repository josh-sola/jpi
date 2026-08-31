import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { FleetUIContext } from "../../src/pi/types.ts";
import { registerAgents } from "../../modules/subagents/agent-types.ts";
import { subagentsExtension } from "./helpers/boot-extension.ts";
import type { AgentConfig, AgentRecord } from "../../modules/subagents/types.ts";
import { type AgentActivity, AgentWidget } from "../../modules/subagents/ui/agent-widget.ts";
import { ConversationViewer } from "../../modules/subagents/ui/conversation-viewer.ts";
import { FleetList } from "../../modules/subagents/ui/fleet-list.ts";

const TYPE = "colored-reviewer";
const DISPLAY_NAME = "Code Reviewer";
const PURPLE_BACKGROUND = "\u001b[48;2;130;125;189m";

const config: AgentConfig = {
  name: TYPE,
  displayName: DISPLAY_NAME,
  color: "purple",
  description: "Reviews code",
  extensions: false,
  skills: false,
  systemPrompt: "Review code.",
  promptMode: "replace",
};

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
  getColorMode: () => "truecolor" as const,
};

type RenderedComponent = { render(width?: number): string[] };
type WidgetFactory = (
  tui: { terminal: { columns: number; rows?: number }; requestRender: ReturnType<typeof vi.fn> },
  activeTheme: typeof theme,
) => RenderedComponent;
type SessionHandler = (...args: unknown[]) => unknown;

interface RegisteredTool {
  name: string;
  renderCall(
    args: Record<string, unknown>,
    activeTheme: typeof theme,
    context: {
      executionStarted: boolean;
      isPartial: boolean;
      isError: boolean;
      lastComponent?: unknown;
    },
  ): RenderedComponent;
}

function registerColoredReviewer(color = "purple"): void {
  registerAgents(new Map([[TYPE, { ...config, color }]]));
}

function makeRecord(): AgentRecord {
  return {
    id: "review-1",
    type: TYPE,
    description: "Review this change",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: {
      messages: [],
      subscribe: vi.fn(() => vi.fn()),
    } as unknown as AgentRecord["session"],
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  };
}

function makeActivity(): AgentActivity {
  return {
    activeTools: new Map(),
    toolUses: 0,
    responseText: "",
    turnCount: 1,
  };
}

function makePi() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, SessionHandler>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((tool: unknown) => {
      const registered = tool as RegisteredTool;
      tools.set(registered.name, registered);
    }),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: unknown) => handlers.set(event, handler as SessionHandler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as Parameters<typeof subagentsExtension>[0];
  return { pi, tools, handlers };
}

beforeEach(() => {
  registerColoredReviewer();
});

afterEach(() => {
  registerAgents(new Map());
});

describe("custom agent color runtime surfaces", () => {
  it("renders the registered Agent tool call header with the display name and color", async () => {
    const { pi, tools, handlers } = makePi();
    await subagentsExtension(pi);
    registerColoredReviewer();

    try {
      const tool = tools.get("Agent");
      if (!tool) throw new Error("Agent tool was not registered");
      const render = (context: {
        executionStarted: boolean;
        isPartial: boolean;
        isError: boolean;
      }) =>
        tool
          .renderCall({ subagent_type: TYPE, description: "Review this change" }, theme, {
            ...context,
            lastComponent: undefined,
          })
          .render(120)
          .join("\n");
      const output = render({ executionStarted: true, isPartial: false, isError: false });

      expect(output).toContain(DISPLAY_NAME);
      expect(output).toContain(PURPLE_BACKGROUND);
      expect(output).toContain("(<muted>Review this change</muted>)");
      // The bullet carries pending/running/success/error state, like every other tool.
      expect(output).toContain("<success>⏺ </success>");
      expect(render({ executionStarted: false, isPartial: false, isError: false })).toContain(
        "<muted>⏺ </muted>",
      );
      expect(render({ executionStarted: true, isPartial: true, isError: false })).toContain(
        "<muted>⏺ </muted>",
      );
      expect(render({ executionStarted: true, isPartial: false, isError: true })).toContain(
        "<error>⏺ </error>",
      );

      const missingType = tool
        .renderCall({ description: "Review this change" }, theme, {
          executionStarted: true,
          isPartial: false,
          isError: false,
          lastComponent: undefined,
        })
        .render(120)
        .join("\n");
      expect(missingType).toContain("<toolTitle>*Agent*</toolTitle>");
      expect(missingType).not.toContain(PURPLE_BACKGROUND);

      // An agent without a color renders no badge — just the fallback-styled name.
      registerAgents(new Map([[TYPE, { ...config, color: undefined }]]));
      const uncolored = render({ executionStarted: true, isPartial: false, isError: false });
      expect(uncolored.trimEnd()).toBe(
        `<success>⏺ </success><toolTitle>*${DISPLAY_NAME}*</toolTitle>(<muted>Review this change</muted>)`,
      );
    } finally {
      await handlers.get("session_shutdown")?.({}, { hasUI: false, ui: {} });
    }
  });

  it("renders the above-editor Agent widget with the display name and color", () => {
    const record = makeRecord();
    const widget = new AgentWidget(
      { listAgents: () => [record] } as unknown as ConstructorParameters<typeof AgentWidget>[0],
      new Map([[record.id, makeActivity()]]),
      () => "all",
    );
    let factory: WidgetFactory | undefined;
    let placement: string | undefined;
    widget.setUICtx({
      setStatus: vi.fn(),
      setWidget: (_key, content, options) => {
        if (typeof content === "function") factory = content as WidgetFactory;
        placement = options?.placement;
      },
    });

    try {
      widget.update();
      const output = factory?.({ terminal: { columns: 120 }, requestRender: vi.fn() }, theme)
        .render()
        .join("\n");

      expect(placement).toBe("aboveEditor");
      expect(output).toContain(DISPLAY_NAME);
      expect(output).toContain(PURPLE_BACKGROUND);
    } finally {
      widget.dispose();
    }
  });

  it("renders the FleetView row with the display name and color", () => {
    const record = makeRecord();
    const manager = {
      listAgents: () => [record],
      abort: vi.fn(() => true),
      steer: vi.fn(() => true),
    } as unknown as ConstructorParameters<typeof FleetList>[0];
    const fleet = new FleetList(manager, new Map());
    let factory: WidgetFactory | undefined;
    fleet.setUICtx({
      setWidget: (_key, content) => {
        if (typeof content === "function") factory = content as WidgetFactory;
      },
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      notify: vi.fn(),
      custom: (() => new Promise<undefined>(() => {})) as FleetUIContext["custom"],
    });

    try {
      fleet.update();
      const output = factory?.(
        { requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } },
        theme,
      )
        .render(120)
        .join("\n");

      expect(output).toContain(DISPLAY_NAME);
      expect(output).toContain(PURPLE_BACKGROUND);

      registerColoredReviewer("invalid");
      const fallback = factory?.(
        { requestRender: vi.fn(), terminal: { columns: 120, rows: 40 } },
        theme,
      )
        .render(120)
        .join("\n");
      expect(fallback).toContain(`<muted>${DISPLAY_NAME}</muted>`);
      expect(fallback).not.toContain(PURPLE_BACKGROUND);
    } finally {
      fleet.dispose();
    }
  });

  it("renders the conversation viewer header with the display name and color", () => {
    const record = makeRecord();
    const viewer = new ConversationViewer(
      {
        terminal: { rows: 30, columns: 120 },
        requestRender: vi.fn(),
      } as unknown as ConstructorParameters<typeof ConversationViewer>[0],
      record.session!,
      record,
      undefined,
      theme,
      vi.fn(),
    );

    try {
      const output = viewer.render(120).join("\n");
      expect(output).toContain(DISPLAY_NAME);
      expect(output).toContain(PURPLE_BACKGROUND);
    } finally {
      viewer.dispose();
    }
  });
});
