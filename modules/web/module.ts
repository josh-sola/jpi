import { j } from "../../src/core/index.ts";
import type { JpiModule } from "../../src/core/module.ts";
import { registerWebTools } from "./index.ts";
import { DEFAULT_WEB_SEARCH_BACKEND } from "./search.ts";

export const webSchema = j.node({
  fields: {
    backend: j
      .string()
      .describe(
        "ketch search backend: brave, ddg, searxng, exa, firecrawl, keenable, tavily, parallel, or serpbase",
      )
      .default(DEFAULT_WEB_SEARCH_BACKEND),
  },
});

const webModule: JpiModule<typeof webSchema> = {
  name: "web",
  section: "web",
  schema: webSchema,
  exclusiveGroup: "web-provider",
  setup(pi, ctx) {
    registerWebTools(pi, { backend: ctx.value.backend });
  },
};

export default webModule;
