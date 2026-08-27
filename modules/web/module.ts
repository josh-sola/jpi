import type { JpiModule } from "../../src/core/module.ts";
import { registerWebTools } from "./index.ts";

const webModule: JpiModule = {
  name: "web",
  section: "web",
  setup(pi) {
    registerWebTools(pi);
  },
};

export default webModule;
