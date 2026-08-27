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
