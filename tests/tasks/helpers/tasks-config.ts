/**
 * Test-only helper for seeding the shared `jpi.kdl` config file that
 * src/config.ts reads. Tests point `PI_CODING_AGENT_DIR` at a temp directory
 * and use this to pre-write a `tasks { }` section before the extension loads it.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TasksConfigOverrides {
  scope?: "memory" | "session" | "project";
  autoClearCompleted?: "never" | "on_list_complete" | "on_task_complete";
}

export function writeTasksConfig(agentDir: string, overrides: TasksConfigOverrides): void {
  mkdirSync(agentDir, { recursive: true });
  const lines = ["tasks {"];
  if (overrides.scope !== undefined) lines.push(`  scope "${overrides.scope}"`);
  if (overrides.autoClearCompleted !== undefined) {
    lines.push(`  auto-clear-completed "${overrides.autoClearCompleted}"`);
  }
  lines.push("}", "");
  writeFileSync(join(agentDir, "jpi.kdl"), lines.join("\n"));
}
