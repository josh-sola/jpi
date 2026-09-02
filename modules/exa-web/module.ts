import { j } from "../../src/core/index.ts";
import type { JpiModule } from "../../src/core/module.ts";
import { registerExaWebTools, resolveExaApiKey } from "./index.ts";

export const exaWebSchema = j.node({
  fields: {
    apiKey: j.string().describe("Exa API key; empty uses EXA_API_KEY").default(""),
  },
});

const exaWebModule: JpiModule<typeof exaWebSchema> = {
  name: "exa-web",
  section: "exa-web",
  schema: exaWebSchema,
  exclusiveGroup: "web-provider",
  enabledByDefault: false,
  setup(pi, ctx) {
    registerExaWebTools(pi, { apiKey: resolveExaApiKey(ctx.value.apiKey) });
  },
};

export default exaWebModule;
