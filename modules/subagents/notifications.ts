/**
 * notifications.ts — the `subagent-notification` message renderer, the
 * cancellable completion nudge (individual + smart-join group), and the
 * `GroupJoinManager` instance that batches them.
 *
 * `wireNotifications` populates `rt.groupJoin`, `rt.scheduleNudge`,
 * `rt.cancelNudge`, `rt.sendIndividualNudge` and `rt.disposeNudges` — callers
 * elsewhere in the module (the manager's completion callback, the batch
 * finalizer, the result tools) use those fields once setup has run.
 */

import { Text } from "@earendil-works/pi-tui";
import { GroupJoinManager } from "./group-join.ts";
import type { SubagentsRuntime } from "./index.ts";
import { getStatusNote } from "./status-note.ts";
import type { AgentRecord, NotificationDetails } from "./types.ts";
import type { AgentActivity } from "./ui/agent-widget.ts";
import { formatCost, formatMs, formatTokens, formatTurns } from "./ui/agent-widget.ts";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "./usage.ts";
import { escapeXml } from "./xml.ts";

/** Human-readable status label for agent completion. */
function getStatusLabel(status: string, error?: string): string {
  switch (status) {
    case "error":
      return `Error: ${error ?? "unknown"}`;
    case "aborted":
      return "Aborted (max turns exceeded)";
    case "steered":
      return "Wrapped up (turn limit)";
    case "stopped":
      return "Stopped";
    default:
      return "Done";
  }
}

/** Format a structured task notification matching Claude Code's <task-notification> XML. */
function formatTaskNotification(
  record: AgentRecord,
  resultMaxLen: number,
  showCost = false,
): string {
  const status = getStatusLabel(record.status, record.error);
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : 0;
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);
  const contextPercent = getSessionContextPercent(record.session);
  const ctxXml =
    contextPercent !== null
      ? `<context_percent>${Math.round(contextPercent)}</context_percent>`
      : "";
  const compactXml = record.compactionCount
    ? `<compactions>${record.compactionCount}</compactions>`
    : "";
  // Only under `showCost`: this is LLM context, and a figure the orchestrator
  // did not ask for is a figure it may start reporting unprompted.
  const cost = showCost ? getLifetimeCost(record.lifetimeUsage) : 0;
  const costXml = cost > 0 ? `<estimated_cost_usd>${cost.toFixed(4)}</estimated_cost_usd>` : "";

  const resultPreview = record.result
    ? record.result.length > resultMaxLen
      ? record.result.slice(0, resultMaxLen) +
        "\n...(truncated, use get_subagent_result for full output)"
      : record.result
    : "No output.";

  return [
    `<task-notification>`,
    `<task-id>${record.id}</task-id>`,
    record.toolCallId ? `<tool-use-id>${escapeXml(record.toolCallId)}</tool-use-id>` : null,
    record.outputFile ? `<output-file>${escapeXml(record.outputFile)}</output-file>` : null,
    `<status>${escapeXml(status)}</status>`,
    `<summary>Agent "${escapeXml(record.description)}" ${record.status}${getStatusNote(record.status)}</summary>`,
    `<result>${escapeXml(resultPreview)}</result>`,
    `<usage><total_tokens>${totalTokens}</total_tokens><tool_uses>${record.toolUses}</tool_uses>${ctxXml}${compactXml}${costXml}<duration_ms>${durationMs}</duration_ms></usage>`,
    `</task-notification>`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Build notification details for the custom message renderer. */
function buildNotificationDetails(
  record: AgentRecord,
  resultMaxLen: number,
  activity?: AgentActivity,
): NotificationDetails {
  const totalTokens = getLifetimeTotal(record.lifetimeUsage);

  return {
    id: record.id,
    description: record.description,
    status: record.status,
    toolUses: record.toolUses,
    turnCount: activity?.turnCount ?? 0,
    maxTurns: activity?.maxTurns,
    totalTokens,
    // Carried unconditionally; the renderer gates on the setting. Details are
    // data, and a notification rendered before a mid-session toggle should not
    // be stuck with the old answer.
    totalCost: getLifetimeCost(record.lifetimeUsage),
    durationMs: record.completedAt ? record.completedAt - record.startedAt : 0,
    outputFile: record.outputFile,
    error: record.error,
    resultPreview: record.result
      ? record.result.length > resultMaxLen
        ? record.result.slice(0, resultMaxLen) + "…"
        : record.result
      : "No output.",
  };
}

/** Holds notifications briefly so get_subagent_result can cancel them before delivery. */
const NUDGE_HOLD_MS = 200;

/**
 * Wire the notification renderer, the individual/group nudge machinery and
 * the `GroupJoinManager` onto `rt`. Call once during setup, after `rt.pi`,
 * `rt.widget`, `rt.fleet` and `rt.agentActivity` are in place.
 */
export function wireNotifications(rt: SubagentsRuntime): void {
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    pendingNudges.set(
      key,
      setTimeout(() => {
        pendingNudges.delete(key);
        try {
          send();
        } catch {
          /* ignore stale completion side-effect errors */
        }
      }, delay),
    );
  }

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  // ---- Individual nudge helper (async join mode) ----
  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return; // re-check at send time

    const notification = formatTaskNotification(record, 500, rt.isShowCostEnabled());
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : "";

    rt.pi.sendMessage<NotificationDetails>(
      {
        customType: "subagent-notification",
        content: notification + footer,
        display: true,
        details: buildNotificationDetails(record, 500, rt.agentActivity.get(record.id)),
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  function sendIndividualNudge(record: AgentRecord) {
    rt.agentActivity.delete(record.id);
    rt.widget.markFinished(record.id);
    rt.fleet.onAgentFinished(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
    rt.widget.update();
  }

  // ---- Group join manager ----
  const groupJoin = new GroupJoinManager((records, partial) => {
    for (const r of records) {
      rt.agentActivity.delete(r.id);
      rt.widget.markFinished(r.id);
      rt.fleet.onAgentFinished(r.id);
    }

    const groupKey = `group:${records.map((r) => r.id).join(",")}`;
    scheduleNudge(groupKey, () => {
      // Re-check at send time
      const unconsumed = records.filter((r) => !r.resultConsumed);
      if (unconsumed.length === 0) {
        rt.widget.update();
        return;
      }

      const notifications = unconsumed
        .map((r) => formatTaskNotification(r, 300, rt.isShowCostEnabled()))
        .join("\n\n");
      const label = partial
        ? `${unconsumed.length} agent(s) finished (partial — others still running)`
        : `${unconsumed.length} agent(s) finished`;

      const [first, ...rest] = unconsumed;
      const details = buildNotificationDetails(first, 300, rt.agentActivity.get(first.id));
      if (rest.length > 0) {
        details.others = rest.map((r) =>
          buildNotificationDetails(r, 300, rt.agentActivity.get(r.id)),
        );
      }

      rt.pi.sendMessage<NotificationDetails>(
        {
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
    rt.widget.update();
  }, 30_000);

  rt.groupJoin = groupJoin;
  rt.scheduleNudge = scheduleNudge;
  rt.cancelNudge = cancelNudge;
  rt.sendIndividualNudge = sendIndividualNudge;
  rt.disposeNudges = () => {
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
  };

  // ---- Register custom notification renderer ----
  rt.pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError
          ? d.status
          : d.status === "steered"
            ? "completed (steered)"
            : "completed";

        // Line 1: icon + agent description + status
        let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        // Line 2: stats
        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (rt.isShowCostEnabled()) {
          const costText = formatCost(d.totalCost ?? 0);
          if (costText) parts.push(costText);
        }
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line +=
            "\n  " + parts.map((p) => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        }

        // Line 3: result preview (collapsed) or full (expanded)
        if (expanded) {
          const lines = d.resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        } else {
          const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
          line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
        }

        // Line 4: output file link (if present)
        if (d.outputFile) {
          line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      const rendered = all.map(renderOne);
      // A group of agents lands as one notification, and the number a user wants
      // from it is what the batch cost — not four figures to add up by hand.
      // Derived from the per-agent details rather than carried alongside them:
      // one source, so the total can never disagree with the rows above it.
      if (rt.isShowCostEnabled() && all.length > 1) {
        const total = formatCost(all.reduce((sum, a) => sum + (a.totalCost ?? 0), 0));
        if (total) {
          const tokens = all.reduce((sum, a) => sum + a.totalTokens, 0);
          rendered.unshift(
            theme.fg("dim", `${all.length} agents · ${formatTokens(tokens)} · ${total}`),
          );
        }
      }
      return new Text(rendered.join("\n"), 0, 0);
    },
  );
}
