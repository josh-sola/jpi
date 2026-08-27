import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { JpiModule } from "../../src/core/module.ts";
import { createMemoryExtension } from "./extension.ts";

const memoryModule: JpiModule = {
  name: "memory",
  section: "memory",
  setup(pi: ExtensionAPI) {
    const extension = createMemoryExtension();

    pi.on("session_start", extension.onSessionStart);
    pi.on("before_agent_start", extension.onBeforeAgentStart);
    pi.registerCommand("jpi-memory", {
      description: "Show the memory directory, index, and capacity status",
      handler: extension.onCommand,
    });
  },
};

export default memoryModule;
