import { j } from "../../src/core/index.ts";

export const historySchema = j.node({
  fields: {
    maxSize: j
      .number()
      .int()
      .positive()
      .describe("prompts the log file retains; the oldest are dropped at session start")
      .default(1000),
    mouse: j
      .boolean()
      .describe(
        "Claude Code style click-to-move-cursor and drag-to-select in the editor, fullscreen mode only",
      )
      .default(true),
    suggest: j.node({
      fields: {
        enabled: j
          .boolean()
          .describe("set to #true to enable ghost-text next-prompt suggestions")
          .default(false),
        model: j
          .string()
          .describe("model that generates the suggestions")
          .default("openai-codex/gpt-5.6-luna"),
        timeoutMs: j
          .number()
          .int()
          .positive()
          .describe("per-suggestion timeout in milliseconds")
          .default(10_000),
      },
    }),
  },
});
