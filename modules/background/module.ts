import type { JpiModule } from "../../src/core/module.ts";
import { backgroundSchema } from "./config.ts";
import { registerBackground } from "./index.ts";

const backgroundModule: JpiModule<typeof backgroundSchema> = {
  name: "background",
  section: "background",
  schema: backgroundSchema,
  setup(pi, ctx) {
    registerBackground(pi, ctx.config);
  },
};

export default backgroundModule;
