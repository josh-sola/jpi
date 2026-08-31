import type { EditToolDetails } from "@earendil-works/pi-coding-agent";

/**
 * Pulls the diff string out of an edit tool result's `details`. `details` is
 * `unknown` on the wire (it's whatever shape the tool that produced it
 * chose); this only recognizes pi's own edit tool shape.
 */
export function editResultDiff(details: unknown): string | undefined {
  return (details as EditToolDetails | undefined)?.diff;
}

/** Added/removed line counts from an edit tool's unified-style diff string. */
export function countDiffStats(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }
  return { additions, removals };
}

/**
 * `usage` off an assistant message, read through an `any` escape hatch: pi's
 * `AgentMessage` union (`Message | CustomAgentMessages[...]`) doesn't narrow
 * cleanly to `AssistantMessage` from a bare `message.role === "assistant"`
 * check in every context this is read from, so callers keep the `?? 0`
 * defensive reads they already had rather than gaining a false sense of type
 * safety here.
 */
export function messageUsage(message: unknown): any {
  return (message as { usage?: unknown }).usage;
}

/**
 * A tool-call content block's tool name. Reads `name` (pi-ai's `ToolCall.name`),
 * falling back to `toolName` for a variant shape that uses that field
 * instead — both through an `any` escape hatch since call sites narrow on
 * `type === "toolCall"` from a broader content union that doesn't always
 * carry a clean `name` type.
 */
export function toolCallName(block: unknown): string {
  const b = block as { name?: string; toolName?: string };
  return b.name ?? b.toolName ?? "unknown";
}

/**
 * A bash-execution message's `command`/`output`, or undefined for any other
 * message role. Pi does have a "bashExecution" message role
 * (`BashExecutionComponent` renders it), but it doesn't narrow cleanly out of
 * `AgentSession["messages"][number]` in every context that reads it, so this
 * reads it through an `any` escape hatch rather than relying on that narrow.
 */
export function asBashExecution(
  msg: unknown,
): { command: string; output?: string | undefined } | undefined {
  const m = msg as { role?: string; command?: string; output?: string };
  if (m.role !== "bashExecution") return undefined;
  return { command: m.command ?? "", output: m.output };
}
