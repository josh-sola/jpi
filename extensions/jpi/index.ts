import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Config } from "../../src/core/config.ts";
import { errorMessage } from "../../src/core/errors.ts";
import { injectEnabled, type JpiModule } from "../../src/core/module.ts";
import { decorateToolRegistration } from "../../src/core/tool-registration.ts";
import backgroundModule from "../../modules/background/module.ts";
import btwModule from "../../modules/btw/module.ts";
import guardianModule from "../../modules/guardian/module.ts";
import historyModule from "../../modules/history/module.ts";
import memoryModule from "../../modules/memory/module.ts";
import promptModule from "../../modules/prompt/module.ts";
import scratchpadModule from "../../modules/scratchpad/module.ts";
import statusModule from "../../modules/status/module.ts";
import styleModule from "../../modules/style/module.ts";
import subagentsModule from "../../modules/subagents/module.ts";
import tasksModule from "../../modules/tasks/module.ts";
import titleModule from "../../modules/title/module.ts";
import webModule from "../../modules/web/module.ts";

// Order encodes real constraints, not preference: prompt replaces the system
// prompt before memory/scratchpad append to it, so it must load first. style
// re-registers built-in tools, so it loads near the end, after the modules
// whose tools it wraps. history owns the editor via setEditorComponent, where
// the last caller wins, so it must load last of all.
const MODULES: readonly JpiModule[] = [
  promptModule,
  guardianModule,
  statusModule,
  memoryModule,
  webModule,
  titleModule,
  backgroundModule,
  subagentsModule,
  tasksModule,
  scratchpadModule,
  btwModule,
  styleModule,
  historyModule,
];

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
  const decoratedPi = decorateToolRegistration(pi);

  for (const mod of modules) {
    const config = new Config(mod.section, injectEnabled(mod.name, mod.schema));
    const { value, issues: loadIssues } = await config.load();
    for (const issue of loadIssues) issues.push(`${mod.name}: ${issue}`);

    if (!value.enabled) continue;

    try {
      await mod.setup(decoratedPi, { config, value, issues: loadIssues });
    } catch (error) {
      failures.push(`${mod.name}: ${errorMessage(error)}`);
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
