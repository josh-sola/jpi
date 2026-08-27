import type { JpiModule } from "../../src/core/module.ts";
import { tasksSchema } from "./config.ts";
import { setupTasks } from "./index.ts";

const tasksModule: JpiModule<typeof tasksSchema> = {
  name: "tasks",
  section: "tasks",
  schema: tasksSchema,
  setup: setupTasks,
};

export default tasksModule;
