import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { j } from "../../src/core/index.ts";
import type { JpiModule } from "../../src/core/module.ts";
import { createScratchpadExtension } from "./extension.ts";

export const scratchpadSchema = j.node({
  fields: {
    ttlDays: j
      .number()
      .int()
      .positive()
      .describe("age in days after which a stale session's scratchpad dir is swept")
      .default(7),
  },
});

const scratchpadModule: JpiModule<typeof scratchpadSchema> = {
  name: "scratchpad",
  section: "scratchpad",
  schema: scratchpadSchema,
  setup(pi: ExtensionAPI, ctx) {
    const extension = createScratchpadExtension({ ttlDays: ctx.value.ttlDays });

    pi.on("session_start", extension.onSessionStart);
    pi.on("before_agent_start", extension.onBeforeAgentStart);
  },
};

export default scratchpadModule;
