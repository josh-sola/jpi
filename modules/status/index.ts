import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { ModuleContext } from "../../src/core/module.ts";
import type { statusSchema } from "./config.ts";
import { createStatusExtension } from "./extension.ts";

export function registerStatusExtension(
  pi: ExtensionAPI,
  ctx: ModuleContext<typeof statusSchema>,
): void {
  const extension = createStatusExtension(
    (command, args, options) => pi.exec(command, args, options),
    { truncateToWidth, visibleWidth },
    { setInterval, clearInterval },
    ctx.config,
    ctx.value,
    pi.events,
  );

  pi.on("session_start", extension.onSessionStart);
  pi.on("session_info_changed", async (event) => extension.onSessionInfoChanged(event));
  pi.on("turn_end", async () => extension.onTurnEnd());
  pi.on("message_start", async (event) => extension.onMessageStart(event));
  pi.on("message_update", async (event) => extension.onMessageUpdate(event));
  pi.on("message_end", async (event) => extension.onMessageEnd(event));
  pi.on("tool_execution_start", async (event) => extension.onToolExecutionStart(event));
  pi.on("tool_execution_end", async () => extension.onToolExecutionEnd());
  pi.registerCommand("jpi-status", {
    description: "Show, refresh, or reload the custom footer",
    handler: extension.onCommand,
  });
}
