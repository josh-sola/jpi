import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Config } from "../../src/core/config.ts";
import { injectEnabled, type JpiModule } from "../../src/core/module.ts";

// Order encodes real constraints, not preference: prompt replaces the system
// prompt before memory/scratchpad append to it, so it must load first. style
// re-registers built-in tools, so it loads near the end, after the modules
// whose tools it wraps. history owns the editor via setEditorComponent, where
// the last caller wins, so it must load last of all.
//
// prompt, guardian, status, memory, web, title, background, subagents,
// tasks, scratchpad, style, history
const MODULES: readonly JpiModule[] = [];

export interface LoadModulesResult {
  readonly issues: readonly string[];
  readonly failures: readonly string[];
}

export async function loadModules(
  pi: ExtensionAPI,
  modules: readonly JpiModule[],
): Promise<LoadModulesResult> {
  const issues: string[] = [];
  const failures: string[] = [];

  for (const mod of modules) {
    const config = new Config(mod.section, injectEnabled(mod.name, mod.schema));
    const { value, issues: loadIssues } = await config.load();
    for (const issue of loadIssues) issues.push(`${mod.name}: ${issue}`);

    if (!value.enabled) continue;

    try {
      await mod.setup(pi, { config, value, issues: loadIssues });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${mod.name}: ${message}`);
    }
  }

  return { issues, failures };
}

export default async function jpi(pi: ExtensionAPI): Promise<void> {
  const { issues, failures } = await loadModules(pi, MODULES);
  if (issues.length === 0 && failures.length === 0) return;

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") return;
    if (!ctx.hasUI) return;
    for (const issue of issues) ctx.ui.notify(issue, "warning");
    for (const failure of failures) ctx.ui.notify(failure, "error");
  });
}
