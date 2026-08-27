import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { JpiModule } from "../../src/core/module.ts";
import { createTitleExtension } from "./extension.ts";

const titleModule: JpiModule = {
  name: "title",
  section: "title",
  setup(pi: ExtensionAPI) {
    const extension = createTitleExtension({
      exec: (command, args, options) => pi.exec(command, args, options),
      events: pi.events,
      getSessionName: () => pi.getSessionName(),
    });

    pi.on("session_start", extension.onSessionStart);
    pi.on("session_info_changed", extension.onSessionInfoChanged);
    pi.on("agent_start", extension.onAgentStart);
    pi.on("agent_settled", extension.onAgentSettled);
    pi.on("session_shutdown", extension.onSessionShutdown);
  },
};

export default titleModule;
