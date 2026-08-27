import { homedir } from "node:os";
import { join } from "node:path";

function expandHome(path: string, homeDirectory: string): string {
  if (path === "~") return homeDirectory;
  if (path.startsWith("~/")) return join(homeDirectory, path.slice(2));
  return path;
}

export function getAgentDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const agentDirectory = env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent";
  return expandHome(agentDirectory, homeDirectory);
}
