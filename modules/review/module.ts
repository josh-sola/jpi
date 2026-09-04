import type { JpiModule } from "../../src/core/module.ts";
import { registerReview } from "./index.ts";

const reviewModule: JpiModule = {
  name: "review",
  section: "review",
  setup: registerReview,
};

export default reviewModule;
