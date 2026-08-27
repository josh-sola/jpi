import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { JpiModule } from "../../src/core/index.ts";
import { historySchema } from "./config.ts";
import { registerHistory } from "./index.ts";

const historyModule: JpiModule<typeof historySchema> = {
  name: "history",
  section: "history",
  schema: historySchema,
  setup(pi: ExtensionAPI, ctx) {
    registerHistory(pi, ctx);
  },
};

export default historyModule;
