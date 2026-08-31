import { homedir } from "node:os";
import { join } from "node:path";

function expandHome(path: string, homeDirectory: string): string {
  if (path === "~") return homeDirectory;
  if (path.startsWith("~/")) return join(homeDirectory, path.slice(2));
  return path;
}

// pi's own config resolution (which directory holds jpi.kdl, memories, etc.)
// isn't part of its public extension API, so this duplicates pi's unexported
// PI_CODING_AGENT_DIR -> ~/.pi/agent logic. That's exactly why it lives in
// src/pi: if pi ever changes its default or the env var name, this is where
// to look.
export function getAgentDirectory(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const agentDirectory = env.PI_CODING_AGENT_DIR?.trim() || "~/.pi/agent";
  return expandHome(agentDirectory, homeDirectory);
}
