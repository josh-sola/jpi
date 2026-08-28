import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createWebFetchTool, type WebFetchToolOptions } from "./fetch.ts";
import { createKetchRunner, type KetchRunner } from "./ketch.ts";
import { createWebSearchTool, DEFAULT_WEB_SEARCH_BACKEND } from "./search.ts";

export type WebExtensionOptions = {
  runner?: KetchRunner;
  backend?: string;
} & Partial<Pick<WebFetchToolOptions, "createSessionId" | "now">>;

export function registerWebTools(pi: ExtensionAPI, options: WebExtensionOptions = {}) {
  const runner =
    options.runner ??
    createKetchRunner({
      exec: (command, args, execOptions) => pi.exec(command, args, execOptions),
    });

  pi.registerTool(createWebSearchTool(runner, options.backend ?? DEFAULT_WEB_SEARCH_BACKEND));
  pi.registerTool(
    createWebFetchTool({
      runner,
      ...(options.createSessionId ? { createSessionId: options.createSessionId } : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
  );
}
