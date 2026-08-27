import type { JpiModule } from "../../src/core/module.ts";
import { registerStyleTools } from "./index.ts";

const styleModule: JpiModule = {
  name: "style",
  section: "style",
  setup(pi) {
    registerStyleTools(pi);
  },
};

export default styleModule;
