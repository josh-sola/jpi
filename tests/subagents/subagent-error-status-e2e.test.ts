/**
 * subagent-error-status-e2e.test.ts — regression for issue #144: a subagent
 * whose final assistant turn is a provider error must be reported as a
 * failure, not as "completed" with an empty (or stale) result.
 *
 * Full-stack: real pi loader + real extension + real runAgent + real child
 * sessions on a faux model. Faux is the point, not a shortcut — the scenario is
 * a provider error with zero content, which no live model will produce on
 * request. Each run pins `live: false` so the pre-publish smoke's global
 * `PI_E2E_LIVE=1` can't swap a real model in and turn this suite red.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  agentCall,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.ts";

/** Text of the parent's Agent tool result — what the orchestrator LLM sees. */
function agentToolResult(session: AgentSession): string {
  const msg = [...session.messages]
    .reverse()
    .find((m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent") as
    | { content?: unknown }
    | undefined;
  return ((msg?.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

vi.setConfig({ testTimeout: 30_000 });

// Not matched by pi's transient-error patterns → no auto-retry, deterministic.
const FATAL = "invalid request: provider rejected the prompt";

describe("issue #144 — empty-error final turns must not be 'completed'", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("a run whose ONLY turn errors with no output is a failure, not an empty success", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ description: "doomed", prompt: "Do work." }),
        parentFinal: "parent done",
        // The child's one and only turn: provider error, zero content.
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
      live: false,
    });
    await run.manager?.waitForAll();

    // The spawn is background, so the parent's own tool result is only the
    // envelope — the real terminal status and error live on the record.
    const id = /Agent ID: (\S+)/.exec(agentToolResult(run.parentSession))?.[1];
    expect(id).toBeTruthy();
    const record = run.manager?.getRecord(id as string) as {
      status?: string;
      error?: string;
      result?: string;
    };
    // DESIRED: a failure naming the provider error — not a clean "completed".
    expect(record?.status).toBe("error");
    expect(record?.error).toContain(FATAL);
    expect(record?.result ?? "").toBe("");
  });

  it("an earlier turn's text must not mask a failed final turn as a fresh success", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ description: "masked", prompt: "Do work." }),
        parentFinal: "parent done",
        subagent: (ctx) => {
          const hasToolResult = ctx.messages.some((m) => m.role === "toolResult");
          // Turn 1: real text + a tool call. Turn 2 (after the tool result):
          // provider error with zero content.
          return hasToolResult
            ? fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL })
            : fauxAssistantMessage([
                fauxText("EARLIER-PARTIAL-TEXT"),
                fauxToolCall("bash", { command: "echo hi" }),
              ]);
        },
      }),
      live: false,
    });
    await run.manager?.waitForAll();

    // The record reports the failure (not the earlier text as a clean answer),
    // AND keeps the salvaged partial output separately from the error.
    const id = /Agent ID: (\S+)/.exec(agentToolResult(run.parentSession))?.[1];
    expect(id).toBeTruthy();
    const record = run.manager?.getRecord(id as string) as {
      status?: string;
      error?: string;
      result?: string;
    };
    expect(record?.status).toBe("error");
    expect(record?.error).toContain(FATAL);
    expect(record?.result).toContain("EARLIER-PARTIAL-TEXT");
  });

  it("a pure empty-error run leaves no result to salvage", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ description: "empty", prompt: "Do work." }),
        parentFinal: "parent done",
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
      live: false,
    });
    await run.manager?.waitForAll();

    const id = /Agent ID: (\S+)/.exec(agentToolResult(run.parentSession))?.[1];
    expect(id).toBeTruthy();
    const record = run.manager?.getRecord(id as string) as { error?: string; result?: string };
    expect(record?.error).toContain(FATAL);
    expect(record?.result ?? "").toBe("");
  });
});
