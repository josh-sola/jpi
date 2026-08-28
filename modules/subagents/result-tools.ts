/**
 * result-tools.ts — `get_subagent_result` and `steer_subagent`: the two
 * tools that reach an already-spawned background agent.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  bulletState,
  createResultLine,
  createToolHeader,
  errorMessage,
  extractResultText,
  truncateEnd,
} from "../../src/core/index.ts";
import { awaitAgentSettled, queuePendingSteer } from "./abortable.ts";
import { isTopLevelAgent } from "./agent-manager.ts";
import { getAgentConversation, steerAgent, SUBAGENT_TOOL_NAMES } from "./agent-runner.ts";
import { formatLifetimeTokens, textResult } from "./agent-tool.ts";
import type { SubagentsRuntime } from "./index.ts";
import { getStatusNote, partialOutputSuffix } from "./status-note.ts";
import { formatCost, formatDuration, getDisplayName } from "./ui/agent-widget.ts";
import { getLifetimeCost, getSessionContextPercent } from "./usage.ts";

/** First non-empty line of `text`, for a one-line error or fallback summary. */
function firstNonEmptyLine(text: string): string | undefined {
  return text.split("\n").find((line) => line.trim() !== "");
}

/** Register `get_subagent_result` and `steer_subagent`. */
export function wireResultTools(rt: SubagentsRuntime): void {
  // ---- get_subagent_result tool ----

  rt.registerToolReportingUsage(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.GET_RESULT,
      label: "Get Agent Result",
      description:
        "Check status and retrieve a background agent's full result — its completion notification carries only a preview. Use the agent ID returned by Agent.",
      promptSnippet: "Check status and retrieve results from a background agent",
      parameters: Type.Object({
        agent_id: Type.String({
          description:
            "The agent ID to check. The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
        }),
        wait: Type.Optional(
          Type.Boolean({
            description:
              "If true, wait for the agent to complete before returning. Default: false.",
          }),
        ),
        verbose: Type.Optional(
          Type.Boolean({
            description:
              "If true, include the agent's full conversation (messages + tool calls). Default: false.",
          }),
        ),
      }),
      execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
        const record = rt.resolveAgentRef(params.agent_id);
        if (!record || !isTopLevelAgent(record)) {
          return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
        }

        // Wait for completion if requested. Cancellation stops only this tool
        // call; the background agent keeps running and remains unconsumed so its
        // completion notification can still be delivered.
        if (params.wait && (record.status === "running" || record.status === "queued")) {
          await awaitAgentSettled(record, signal);
        }

        const displayName = getDisplayName(record.type);
        const duration = formatDuration(record.startedAt, record.completedAt);
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const statsParts = [`Tool uses: ${record.toolUses}`];
        if (tokens) statsParts.push(tokens);
        if (rt.isShowCostEnabled()) {
          const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
          if (costText) statsParts.push(`Cost: ${costText}`);
        }
        if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
        if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
        statsParts.push(`Duration: ${duration}`);

        let output =
          `Agent: ${record.id}\n` +
          `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
          `Description: ${record.description}\n\n`;

        if (record.status === "running") {
          output += "Agent is still running. Use wait: true or check back later.";
        } else if (record.status === "error") {
          output += `Error: ${record.error}${partialOutputSuffix(record)}`;
        } else {
          output += record.result?.trim() || "No output.";
        }

        // Mark result as consumed — suppresses the completion notification
        if (record.status !== "running" && record.status !== "queued") {
          record.resultConsumed = true;
          rt.cancelNudge?.(params.agent_id);
        }

        // Verbose: include full conversation
        if (params.verbose && record.session) {
          const conversation = getAgentConversation(record.session);
          if (conversation) {
            output += `\n\n--- Agent Conversation ---\n${conversation}`;
          }
        }

        return textResult(output);
      },
      renderShell: "self",
      renderCall(args, theme, context) {
        return createToolHeader(
          bulletState(context),
          "Subagent",
          `result: ${args.agent_id}`,
          theme,
          context.lastComponent,
        );
      },
      renderResult(result, options, theme, context) {
        if (options.isPartial) return new Container();
        const text = extractResultText(result.content);
        const container = new Container();
        if (context.isError) {
          const preview = truncateEnd(firstNonEmptyLine(text) ?? "Error", 100);
          container.addChild(createResultLine(preview, theme, "error"));
          if (options.expanded) container.addChild(new Text(theme.fg("error", text), 0, 0));
          return container;
        }

        const summary = truncateEnd(firstNonEmptyLine(text) ?? "(no output)", 100);
        container.addChild(createResultLine(summary, theme, "dim"));
        if (options.expanded && text)
          container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
        return container;
      },
    }),
  );

  // ---- steer_subagent tool ----

  rt.registerToolReportingUsage(
    defineTool({
      name: SUBAGENT_TOOL_NAMES.STEER,
      label: "Steer Agent",
      description:
        "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
        "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
      promptSnippet: "Send a steering message to redirect a running background agent",
      parameters: Type.Object({
        agent_id: Type.String({
          description:
            "The agent ID to steer (must be currently running). The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
        }),
        message: Type.String({
          description:
            "The steering message to send. This will appear as a user message in the agent's conversation.",
        }),
      }),
      execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
        const record = rt.resolveAgentRef(params.agent_id);
        if (!record || !isTopLevelAgent(record)) {
          return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
        }
        if (record.status !== "running") {
          return textResult(
            `Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`,
          );
        }
        if (!record.session) {
          // Session not ready yet — queue the steer for delivery once initialized
          queuePendingSteer(record, params.message);
          rt.pi.events.emit("subagents:steered", { id: record.id, message: params.message });
          return textResult(
            `Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`,
          );
        }

        try {
          await steerAgent(record.session, params.message);
          rt.pi.events.emit("subagents:steered", { id: record.id, message: params.message });
          const tokens = formatLifetimeTokens(record);
          const contextPercent = getSessionContextPercent(record.session);
          const stateParts: string[] = [];
          if (tokens) stateParts.push(tokens);
          if (rt.isShowCostEnabled()) {
            const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
            if (costText) stateParts.push(costText);
          }
          stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
          if (contextPercent !== null)
            stateParts.push(`context ${Math.round(contextPercent)}% full`);
          if (record.compactionCount)
            stateParts.push(
              `${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`,
            );
          return textResult(
            `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
              `Current state: ${stateParts.join(" · ")}`,
          );
        } catch (err) {
          return textResult(`Failed to steer agent: ${errorMessage(err)}`);
        }
      },
      renderShell: "self",
      renderCall(args, theme, context) {
        return createToolHeader(
          bulletState(context),
          "Subagent",
          `steer: ${args.agent_id}`,
          theme,
          context.lastComponent,
        );
      },
      renderResult(result, options, theme, context) {
        if (options.isPartial) return new Container();
        const text = extractResultText(result.content);
        const container = new Container();
        if (context.isError) {
          const preview = truncateEnd(firstNonEmptyLine(text) ?? "Error", 100);
          container.addChild(createResultLine(preview, theme, "error"));
          if (options.expanded) container.addChild(new Text(theme.fg("error", text), 0, 0));
          return container;
        }

        const summary = truncateEnd(firstNonEmptyLine(text) ?? "(no output)", 100);
        container.addChild(createResultLine(summary, theme, "dim"));
        if (options.expanded && text)
          container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
        return container;
      },
    }),
  );
}
