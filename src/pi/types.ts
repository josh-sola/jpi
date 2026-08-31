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

/** Structural mirror of pi's own SessionEntry — only the shape suggest.ts's transcript rendering reads. */
export interface TranscriptEntryLike {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

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
