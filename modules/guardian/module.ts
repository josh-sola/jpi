import type { JpiModule } from "../../src/core/module.ts";
import autoReview, { guardianSchema } from "./index.ts";

const guardianModule: JpiModule<typeof guardianSchema> = {
  name: "guardian",
  section: "guardian",
  schema: guardianSchema,
  setup: autoReview,
};

export default guardianModule;
