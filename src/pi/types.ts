import type { AssistantMessage, ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";

/** Minimal event bus shape shared by every module that emits or listens on the pi event bus. */
export interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export type NotifyLevel = "info" | "warning" | "error";

export type Notifier = (message: string, level?: NotifyLevel) => void;

/** The event pi fires before building the system prompt; modules append to or replace `systemPrompt`. */
export type BeforeAgentStartEvent = {
  systemPrompt: string;
};

// Local mirror of pi's ToolRenderContext: pi-coding-agent 0.84.3's root barrel
// does not re-export it. Delete once upstream exports it.
export interface ToolRenderContext<TState = any, TArgs = any> {
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

/**
 * Structural mirror of pi's own SessionEntry — covers both the narrow shape
 * modules/history/suggest.ts's transcript rendering reads (`type`,
 * `message.role`/`content`) and the wider shape modules/guardian reads
 * (`message.toolName`/`details`, for interleaving tool-call activity and
 * question/answer tool results into the review transcript).
 */
export interface TranscriptEntryLike {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    details?: unknown;
  };
}

// The root barrel exports ToolCallEventResult but omits this sibling type
// (a gap in pi-coding-agent 0.84.3); mirror it until upstream fixes the export.
export interface ToolResultEventResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  usage?: Usage;
}

/**
 * Mirrors pi's `ExtensionUIContext` dialog methods (`select`/`input`).
 * Optional: older hosts (or tests) may not implement them, in which case a
 * denial falls back to the plain (no-dialog) path.
 */
export type DialogUIContext = {
  select?(
    title: string,
    options: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  input?(
    title: string,
    placeholder?: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
};

/** Structural subset of pi's `SessionManager`: just the branch guardian reads for review context. */
export type SessionManagerLike = {
  getBranch(): TranscriptEntryLike[];
};

/** Structural subset of pi's `ModelRegistry`: just what guardian needs to resolve and run its reviewer model. */
export type ModelRegistryLike = {
  find(provider: string, modelId: string): unknown;
  hasConfiguredAuth(model: unknown): boolean;
  complete(
    model: unknown,
    context: unknown,
    options?: Record<string, unknown>,
  ): Promise<AssistantMessage>;
};

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`). Hand-mirrored because pi-ai doesn't export
 * the ordering as a value, only the `ThinkingLevel` union type — drift risk
 * flagged as #147.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Narrow `{ fg, bold }` theme surface some jpi UI widgets (subagents'
 * AgentWidget/FleetList/ConversationViewer) render with — NOT pi's real
 * `Theme` (see `markdown.ts`'s two `resolveMarkdownTheme`/
 * `resolveWidgetMarkdownTheme` variants, one per theme shape).
 */
export type WidgetTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

/** What a `setWidget`/`custom` content factory returns. */
export type WidgetRenderer = {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
};

/** `ctx.ui.setWidget`'s signature — shared by every jpi widget that registers one. */
export type SetWidgetFn = (
  key: string,
  content: undefined | ((tui: any, theme: WidgetTheme) => WidgetRenderer),
  options?: { placement?: "aboveEditor" | "belowEditor" },
) => void;

/** Minimal `ctx.ui` surface for a status line + a widget (structural subset). */
export type WidgetUIContext = {
  setStatus(key: string, text: string | undefined): void;
  setWidget: SetWidgetFn;
};

/** Minimal `ctx.ui` surface a below/above-editor list widget with its own input/overlay needs (structural subset). */
export type FleetUIContext = {
  setWidget: SetWidgetFn;
  onTerminalInput(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  getEditorText(): string;
  notify: Notifier;
  custom<T>(
    factory: (
      tui: any,
      theme: WidgetTheme,
      keybindings: any,
      done: (result: T) => void,
    ) => WidgetRenderer,
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/** Narrow view of Pi's TUI focus API, with the legacy/private fallback. */
export type FocusAwareTui = {
  getFocusedComponent?(): unknown;
  focusedComponent?: unknown;
};

/** A message content part carrying inline text, as read by the footer's live-speed estimate. */
export type MessageContentPart = {
  type?: string;
  text?: string;
};

/** The subset of pi-ai's `Usage` jpi-status accumulates, read defensively (`?? 0`) since every field is optional on the wire. */
export type MessageUsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

/** Structural mirror of an `AgentMessage` as jpi-status reads it. */
export type MessageLike = {
  role?: string;
  stopReason?: string;
  usage?: MessageUsageLike;
  content?: string | MessageContentPart[];
};

/** Structural mirror of pi's own SessionEntry, as jpi-status's turn-accounting replay reads it. */
export type BranchEntryLike = {
  type?: string;
  message?: MessageLike;
};

export type SessionStartInput = {
  sessionManager?:
    | {
        getSessionName?(): string | undefined;
        getBranch?(): BranchEntryLike[];
      }
    | undefined;
};

export type SessionInfoChangedInput = {
  name?: string | undefined;
};

export type MessageEventInput = {
  message?: MessageLike;
};

export type ToolExecutionStartInput = {
  toolName?: string;
};

/** Structural mirror of pi's `ReadonlyFooterDataProvider`, the object a `setFooter` factory receives at render time. */
export type FooterData = {
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(callback: () => void): () => void;
};

/** Structural mirror of the `ExtensionContext` pi hands the footer's lifecycle hooks. */
export type FooterContext = {
  mode: string;
  cwd: string;
  model?:
    | {
        id?: string;
        name?: string;
        provider?: string;
        reasoning?: boolean;
        contextWindow?: number;
        maxTokens?: number;
      }
    | undefined;
  thinkingLevel?: string | undefined;
  isIdle?(): boolean;
  getContextUsage():
    | {
        tokens?: number | null;
        contextWindow?: number | null;
        percent: number | null;
      }
    | undefined;
  sessionManager?:
    | {
        getSessionName?(): string | undefined;
        getBranch?(): BranchEntryLike[];
      }
    | undefined;
  ui: {
    notify: Notifier;
    setFooter(
      factory:
        | ((
            tui: { requestRender(): void },
            theme: unknown,
            footerData: FooterData,
          ) => { render(width: number): string[]; invalidate(): void; dispose(): void })
        | undefined,
    ): void;
  };
};
