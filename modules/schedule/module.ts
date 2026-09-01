import type { JpiModule } from "../../src/core/module.ts";
import { scheduleSchema } from "./config.ts";
import { registerSchedule } from "./index.ts";

const scheduleModule: JpiModule<typeof scheduleSchema> = {
  name: "schedule",
  section: "schedule",
  schema: scheduleSchema,
  setup(pi, ctx) {
    registerSchedule(pi, ctx.config);
  },
};

export default scheduleModule;
