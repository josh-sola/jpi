/** Where jpi-tasks' Store-backed files land, for tests to assert against. */

import { projectSlug, Store } from "../../../src/core/index.ts";

function store(agentDir: string): Store {
  return new Store("tasks", { PI_CODING_AGENT_DIR: agentDir });
}

export function sessionFilePath(agentDir: string, cwd: string, sessionId: string): string {
  const sanitized = sessionId.replace(/[^A-Za-z0-9._-]/g, "-");
  return store(agentDir).path(`${projectSlug(cwd)}/session-${sanitized}.json`);
}

export function projectFilePath(agentDir: string, cwd: string): string {
  return store(agentDir).path(`${projectSlug(cwd)}/project.json`);
}

export function projectSlugDir(agentDir: string, cwd: string): string {
  return store(agentDir).path(projectSlug(cwd));
}
