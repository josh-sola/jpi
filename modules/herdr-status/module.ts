import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { j, type InferNode } from "../../src/core/index.ts";
import type { JpiModule } from "../../src/core/module.ts";
import { createHerdrStatusExtension } from "./extension.ts";

// The builder has no node with two string arguments. This node holds them
// as a two-item array attr instead, read by index: 0 is the model key, 1 is
// the label text.
const label = j.node({
  attrs: {
    pair: j
      .array(j.string())
      .describe("model provider/id, then the sidebar label text")
      .default([]),
  },
});

export const herdrStatusSchema = j.node({
  fields: {
    label: j.list(label, {
      description:
        'sidebar label per model, keyed provider/id (repeat: label "provider/id" "text")',
      default: [],
    }),
  },
});

function labelMap(
  value: InferNode<typeof herdrStatusSchema>["label"],
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const entry of value) {
    const [model, text] = entry.pair;
    if (model && text) labels.set(model, text);
  }
  return labels;
}

const herdrStatusModule: JpiModule<typeof herdrStatusSchema> = {
  name: "herdr-status",
  section: "herdr-status",
  schema: herdrStatusSchema,
  setup(pi: ExtensionAPI, ctx) {
    const extension = createHerdrStatusExtension({
      events: pi.events,
      labels: labelMap(ctx.value.label),
    });
    pi.on("session_start", extension.onSessionStart);
    pi.on("agent_start", extension.onAgentStart);
    pi.on("agent_settled", extension.onAgentSettled);
    pi.on("ui_prompt_start", extension.onUiPromptStart);
    pi.on("ui_prompt_end", extension.onUiPromptEnd);
    pi.on("model_select", extension.onModelSelect);
    pi.on("session_shutdown", extension.onSessionShutdown);
  },
};

export default herdrStatusModule;
