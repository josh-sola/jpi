import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { JpiModule } from "../../src/core/module.ts";
import { createTitleExtension } from "./extension.ts";

function titleMode(value: unknown): "static" | "dynamic" {
  return value === "static" ? "static" : "dynamic";
}

const titleModule: JpiModule = {
  name: "title",
  section: "title",
  setup(pi: ExtensionAPI) {
    pi.registerFlag("title-mode", {
      description: "Title activity mode: static|dynamic",
      type: "string",
      default: "dynamic",
    });

    const extension = createTitleExtension({
      exec: (command, args, options) => pi.exec(command, args, options),
      events: pi.events,
      getSessionName: () => pi.getSessionName(),
      getTitleMode: () => titleMode(pi.getFlag("title-mode")),
    });

    pi.on("session_start", extension.onSessionStart);
    pi.on("session_info_changed", extension.onSessionInfoChanged);
    pi.on("agent_start", extension.onAgentStart);
    pi.on("agent_settled", extension.onAgentSettled);
    pi.on("ui_prompt_start", extension.onUiPromptStart);
    pi.on("ui_prompt_end", extension.onUiPromptEnd);
    pi.on("session_shutdown", extension.onSessionShutdown);
  },
};

export default titleModule;
