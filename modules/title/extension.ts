import { randomUUID } from "node:crypto";

import { type TitleMode } from "./activity.ts";
import { TitleController, type TitleContext } from "./controller.ts";
import type { EventBus, ExecCommand, Scheduler } from "./helpers.ts";

export type TitleDependencies = {
  exec: ExecCommand;
  events: EventBus;
  getSessionName(): string | undefined;
  getTitleMode(): TitleMode;
  scheduler?: Scheduler;
  requestId?: () => string;
};

export type TitleExtension = {
  onSessionStart(event: unknown, context: TitleContext): Promise<void>;
  onSessionInfoChanged(event: unknown, context: TitleContext): void;
  onAgentStart(event: unknown, context: TitleContext): void;
  onAgentSettled(event: unknown, context: TitleContext): void;
  onUiPromptStart(event: unknown, context: TitleContext): void;
  onUiPromptEnd(event: unknown, context: TitleContext): void;
  onSessionShutdown(event: unknown, context: TitleContext): void;
};

const defaultScheduler: Scheduler = {
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function createTitleExtension(dependencies: TitleDependencies): TitleExtension {
  const scheduler = dependencies.scheduler ?? defaultScheduler;
  const createRequestId = dependencies.requestId ?? randomUUID;
  let generation = 0;
  let activeController: TitleController | undefined;

  return {
    async onSessionStart(_event, context) {
      activeController?.shutdown();
      activeController = undefined;
      generation += 1;
      if (context.mode !== "tui") return;

      const controller = new TitleController(
        {
          exec: dependencies.exec,
          events: dependencies.events,
          getSessionName: dependencies.getSessionName,
          scheduler,
          createRequestId,
          generation,
          mode: dependencies.getTitleMode(),
        },
        context,
      );
      activeController = controller;
      await controller.start();
    },

    onSessionInfoChanged() {
      activeController?.refreshName();
    },

    onAgentStart() {
      activeController?.setMainActive(true);
    },

    onAgentSettled() {
      activeController?.setMainActive(false);
    },

    onUiPromptStart() {
      activeController?.startUiPrompt();
    },

    onUiPromptEnd() {
      activeController?.endUiPrompt();
    },

    onSessionShutdown() {
      activeController?.shutdown();
      activeController = undefined;
      generation += 1;
    },
  };
}
