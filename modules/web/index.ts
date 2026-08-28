import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { markReviewAnnotationConsumer } from "../../src/core/index.ts";
import { createWebFetchTool, type WebFetchToolOptions } from "./fetch.ts";
import { createKetchRunner, type KetchRunner } from "./ketch.ts";
import { createWebSearchTool } from "./search.ts";

export type WebExtensionOptions = {
  runner?: KetchRunner;
} & Partial<Pick<WebFetchToolOptions, "createSessionId" | "now">>;

export function registerWebTools(pi: ExtensionAPI, options: WebExtensionOptions = {}) {
  markReviewAnnotationConsumer(["web_search", "web_fetch"]);

  const runner =
    options.runner ??
    createKetchRunner({
      exec: (command, args, execOptions) => pi.exec(command, args, execOptions),
    });

  pi.registerTool(createWebSearchTool(runner));
  pi.registerTool(
    createWebFetchTool({
      runner,
      ...(options.createSessionId ? { createSessionId: options.createSessionId } : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
  );
}
