import type { JpiModule } from "../../src/core/module.ts";
import { disableThinkingItalics, removeUserMessagePadding } from "../../src/pi/index.ts";
import { registerStyleTools } from "./index.ts";
import { patchMcpToolRendering } from "./mcp-style.ts";

const styleModule: JpiModule = {
  name: "style",
  section: "style",
  setup(pi) {
    registerStyleTools(pi);
    disableThinkingItalics();
    removeUserMessagePadding();
    patchMcpToolRendering();
  },
};

export default styleModule;
