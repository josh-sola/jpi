/**
 * Tests bypass the module loader, so this builds the same injected-schema
 * config it would and drives the tasks module's `setup` directly against a
 * fake ExtensionAPI.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Config, injectEnabled } from "../../../src/core/index.ts";
import { tasksSchema } from "../../../modules/tasks/config.ts";
import tasksModule from "../../../modules/tasks/module.ts";

export async function initTasksExtension(pi: ExtensionAPI): Promise<void> {
  const config = new Config("tasks", injectEnabled("tasks", tasksSchema));
  const { value, issues } = await config.load();
  await tasksModule.setup(pi, { config, value, issues });
}
