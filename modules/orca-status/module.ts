import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { JpiModule } from "../../src/core/module.ts";
import { createOrcaStatusExtension } from "./extension.ts";

const orcaStatusModule: JpiModule = {
  name: "orca-status",
  section: "orca-status",
  setup(pi: ExtensionAPI) {
    const extension = createOrcaStatusExtension({ events: pi.events });
    pi.on("session_start", extension.onSessionStart);
    pi.on("agent_start", extension.onAgentStart);
    pi.on("agent_settled", extension.onAgentSettled);
    pi.on("ui_prompt_start", extension.onUiPromptStart);
    pi.on("ui_prompt_end", extension.onUiPromptEnd);
    pi.on("session_shutdown", extension.onSessionShutdown);
  },
};

export default orcaStatusModule;
