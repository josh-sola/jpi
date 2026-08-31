/**
 * session-stats-messages.e2e.test.ts — canary for src/pi/session-stats.ts and
 * src/pi/messages.ts, against a real `AgentSession`. Mirrors
 * tests/subagents/e2e/usage-reaches-session-stats.e2e.test.ts's `realSession`
 * helper: a real session, in memory, on a faux model, with the message
 * appended through pi's own `sessionManager.appendMessage` — no network, no
 * model turn.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { messageUsage, toolCallName } from "../../src/pi/messages.ts";
import { getSessionTokens } from "../../src/pi/session-stats.ts";
import { fauxModelBackend } from "../subagents/helpers/faux-model-backend.ts";
import { registerFauxProvider } from "../subagents/helpers/pi-ai.ts";

vi.setConfig({ testTimeout: 30_000 });

describe("session-stats + messages (real pi)", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-canary-session-stats-"));
    faux = registerFauxProvider({
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
  });
  afterEach(() => {
    faux.unregister();
    rmSync(cwd, { recursive: true, force: true });
  });

  async function realSession() {
    const model = faux.getModel();
    const backend = fauxModelBackend(model);
    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      model: model as any,
      modelRegistry: backend.modelRegistry,
      modelRuntime: backend.modelRuntime,
      tools: [],
    } as any);
    return session;
  }

  function toolResultCarrying(usage: unknown) {
    return {
      role: "toolResult" as const,
      toolCallId: "tc-1",
      toolName: "Agent",
      content: [{ type: "text" as const, text: "done" }],
      isError: false,
      timestamp: 1,
      usage,
    };
  }

  it("getSessionTokens sums input+output+cacheWrite, deliberately excluding cacheRead", async () => {
    const session = await realSession();
    try {
      const usage = {
        input: 1000,
        output: 400,
        cacheWrite: 100,
        cacheRead: 9000,
        cost: { total: 0.0123 },
      };
      session.sessionManager.appendMessage(toolResultCarrying(usage) as any);
      const stats = session.getSessionStats();

      expect(getSessionTokens(session)).toBe(
        stats.tokens.input + stats.tokens.output + stats.tokens.cacheWrite,
      );
      // Real pi's own `tokens.total` sums cacheRead in too (agent-session.js's
      // addUsageToTotals) — this is exactly the double-count getSessionTokens
      // exists to avoid (issue #38): the two must disagree whenever cacheRead
      // is non-zero, or the workaround has silently become a no-op.
      expect(getSessionTokens(session)).toBe(stats.tokens.total - stats.tokens.cacheRead);
      expect(getSessionTokens(session)).not.toBe(stats.tokens.total);
    } finally {
      session.dispose?.();
    }
  });

  it("getSessionTokens is 0 for a session with no usage-carrying messages", async () => {
    const session = await realSession();
    try {
      expect(getSessionTokens(session)).toBe(0);
    } finally {
      session.dispose?.();
    }
  });

  it("messageUsage reads .usage off a real persisted toolResult message", async () => {
    const session = await realSession();
    try {
      const usage = { input: 5, output: 2, cacheWrite: 0, cacheRead: 0, cost: { total: 0.001 } };
      session.sessionManager.appendMessage(toolResultCarrying(usage) as any);
      // `session.messages` is the agent's own in-memory conversation state,
      // untouched by `sessionManager.appendMessage` — the persisted entry
      // lives on the session manager's own branch instead (a real
      // `SessionEntry`: `{ type: "message", message: {...} }`).
      const branch = session.sessionManager.getBranch();
      const persisted = branch
        .map((entry: any) => entry.message)
        .find((message: any) => message?.role === "toolResult");
      expect(persisted).toBeDefined();
      expect(messageUsage(persisted)).toEqual(usage);
    } finally {
      session.dispose?.();
    }
  });

  it("messageUsage reads .usage off a real pi-ai assistant message", () => {
    const message = fauxAssistantMessage("hello");
    expect(messageUsage(message)).toBe((message as { usage?: unknown }).usage);
    expect(messageUsage(message)).toBeDefined();
  });

  it("toolCallName reads .name off a real pi-ai tool-call content block", () => {
    const call = fauxToolCall("Agent", { prompt: "hi" });
    expect(toolCallName(call)).toBe("Agent");
  });

  it("toolCallName falls back to .toolName for the alternate shape", () => {
    expect(toolCallName({ toolName: "Legacy" })).toBe("Legacy");
  });

  it("toolCallName falls back to 'unknown' when neither field is present", () => {
    expect(toolCallName({})).toBe("unknown");
  });
});
