import type { JpiModule } from "../../src/core/module.ts";
import setupSubagents from "./index.ts";
import { subagentsSchema, type SubagentsSchema } from "./settings.ts";

const subagentsModule: JpiModule<SubagentsSchema> = {
  name: "subagents",
  section: "subagents",
  schema: subagentsSchema,
  setup: setupSubagents,
};

export default subagentsModule;
