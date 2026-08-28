import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { JpiModule } from "../../src/core/index.ts";
import { btwSchema } from "./config.ts";
import { registerBtw } from "./index.ts";

const btwModule: JpiModule<typeof btwSchema> = {
  name: "btw",
  section: "btw",
  schema: btwSchema,
  setup(pi: ExtensionAPI, ctx) {
    registerBtw(pi, ctx);
  },
};

export default btwModule;
