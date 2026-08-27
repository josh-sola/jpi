import { homedir } from "node:os";
import { join } from "node:path";

import { getAgentDirectory } from "./agent-dir.ts";

/** The `Store("memories")` root: every project slug's memory directory lives under this. */
export function memoriesRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  return join(getAgentDirectory(env, homeDirectory), "jpi", "memories");
}
