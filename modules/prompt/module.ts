import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatSkillsForPrompt,
  getDocsPath,
  getExamplesPath,
  getReadmePath,
} from "@earendil-works/pi-coding-agent";

import type { JpiModule } from "../../src/core/module.ts";
import { createPromptExtension } from "./extension.ts";

const promptModule: JpiModule = {
  name: "prompt",
  section: "prompt",
  setup(pi: ExtensionAPI) {
    const extension = createPromptExtension({
      formatSkillsForPrompt,
      getPiDocsPaths: () => ({
        readmePath: getReadmePath(),
        docsPath: getDocsPath(),
        examplesPath: getExamplesPath(),
      }),
    });

    pi.on("before_agent_start", extension.onBeforeAgentStart);
  },
};

export default promptModule;
