import { j } from "../../src/core/index.ts";

export const btwSchema = j.node({
  fields: {
    model: j
      .string()
      .describe("model that answers side questions; empty uses the session's active model")
      .default(""),
    timeoutMs: j
      .number()
      .int()
      .positive()
      .describe("per-ask timeout in milliseconds")
      .default(60_000),
    maxExchanges: j
      .number()
      .int()
      .positive()
      .describe("prior btw exchanges replayed with each ask")
      .default(20),
  },
});
