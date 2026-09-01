import type { JpiModule } from "../../src/core/module.ts";
import {
  disableThinkingItalics,
  patchAssistantMessage,
  removeUserMessagePadding,
} from "../../src/pi/index.ts";
import { registerStyleTools } from "./index.ts";
import { patchMcpToolRendering } from "./mcp-style.ts";

const styleModule: JpiModule = {
  name: "style",
  section: "style",
  setup(pi) {
    patchAssistantMessage();
    pi.on("session_start", (_event, ctx) => {
      patchAssistantMessage(() => ctx.ui.theme);
    });
    registerStyleTools(pi);
    disableThinkingItalics();
    removeUserMessagePadding();
    patchMcpToolRendering();
  },
};

export default styleModule;
