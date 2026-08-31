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
