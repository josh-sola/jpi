import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

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

/**
 * Session-storage directory precedence: `PI_CODING_AGENT_SESSION_DIR` env var,
 * else pi's own `SettingsManager.getSessionDir()`. `getSessionDir` is
 * optional on the parameter type only so a caller can hand in a
 * SettingsManager-shaped stub in tests; pi's real `SettingsManager` always
 * has it.
 */
export function resolveDefaultSessionDir(
  settingsManager: { getSessionDir?: () => string | undefined },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir?.();
}

/**
 * Paths to pi's settings.json files, project-local first
 * (`<cwd>/.pi/settings.json`) then global (`<agentDir>/settings.json`). Pi's
 * own `SettingsManager` deep-merges these two — project overrides global —
 * but exposes no generic per-field getter, so a caller that needs one field
 * of the merged result reads both files directly and mirrors that precedence
 * itself (see `readSettingsField`).
 */
export function settingsFilePaths(
  cwd: string,
  agentDir: string = getAgentDir(),
): [project: string, global: string] {
  return [join(cwd, ".pi", "settings.json"), join(agentDir, "settings.json")];
}

/**
 * Reads `field` out of a settings.json file. Undefined when the file is
 * missing, unreadable/corrupt, or `field`'s value doesn't pass `validate`.
 */
export function readSettingsField<T>(
  path: string,
  field: string,
  validate: (value: unknown) => value is T,
): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    const value = raw?.[field];
    if (validate(value)) return value;
  } catch {
    /* corrupt file — silent */
  }
  return undefined;
}

export type AgentFileLocation = "workspace" | "personal";

/** `.agents/agents/` — the project-local custom-agent directory (checked before personal). */
export const workspaceAgentsDir = (cwd: string = process.cwd()) => join(cwd, ".agents", "agents");
/** `<agentDir>/agents/` — the global custom-agent directory. */
export const personalAgentsDir = () => join(getAgentDir(), "agents");

/**
 * Find the file path of a custom agent by name, in discovery-precedence order
 * (workspace, then global). Pi's own agent-file discovery, mirrored here
 * because pi doesn't export a standalone "find this agent's file" lookup.
 */
export function findAgentFile(
  name: string,
  cwd: string = process.cwd(),
): { path: string; location: AgentFileLocation } | undefined {
  const workspacePath = join(workspaceAgentsDir(cwd), `${name}.md`);
  if (existsSync(workspacePath)) return { path: workspacePath, location: "workspace" };
  const personalPath = join(personalAgentsDir(), `${name}.md`);
  if (existsSync(personalPath)) return { path: personalPath, location: "personal" };
  return undefined;
}
