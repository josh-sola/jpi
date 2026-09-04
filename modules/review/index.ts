import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildReviewPrompt } from "./prompt.ts";

export function registerReview(pi: ExtensionAPI): void {
  pi.registerCommand("review", {
    description: "Review code changes with parallel read-only subagents",
    async handler(args) {
      pi.sendUserMessage(buildReviewPrompt(args));
    },
  });
}
