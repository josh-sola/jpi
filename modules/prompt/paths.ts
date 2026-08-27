import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { getAgentDirectory } from "../../src/core/index.ts";

export const SYSTEM_PROMPT_FILENAME = "JPI-SYSTEM.md";

export function getSystemPromptPath(env?: NodeJS.ProcessEnv, homeDirectory?: string): string {
  return join(getAgentDirectory(env, homeDirectory), SYSTEM_PROMPT_FILENAME);
}

export function getDefaultTemplatePath(): string {
  return fileURLToPath(new URL("./JPI-SYSTEM.default.md", import.meta.url));
}
