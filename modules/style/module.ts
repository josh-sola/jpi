import type { JpiModule } from "../../src/core/module.ts";
import { registerStyleTools } from "./index.ts";
import { disableThinkingItalics } from "./thinking-style.ts";
import { removeUserMessagePadding } from "./user-message-style.ts";

const styleModule: JpiModule = {
  name: "style",
  section: "style",
  setup(pi) {
    registerStyleTools(pi);
    disableThinkingItalics();
    removeUserMessagePadding();
  },
};

export default styleModule;
