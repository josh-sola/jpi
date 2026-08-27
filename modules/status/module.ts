import type { JpiModule } from "../../src/core/module.ts";
import { statusSchema } from "./config.ts";
import { registerStatusExtension } from "./index.ts";

const statusModule: JpiModule<typeof statusSchema> = {
  name: "status",
  section: "status",
  schema: statusSchema,
  setup: registerStatusExtension,
};

export default statusModule;
