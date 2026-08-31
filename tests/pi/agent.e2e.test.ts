/**
 * agent.e2e.test.ts — canary for src/pi/agent.ts, against a real
 * `AgentSession`.
 *
 * `wrapBeforeToolCall`'s end-to-end veto behavior (chaining to pi's own
 * `beforeToolCall`, actually blocking a call) is already covered against a
 * real session by tests/subagents/e2e/tool-veto-reachability.e2e.test.ts —
 * see that file's own header for why a mock session can't catch this
 * coupling breaking. This canary only needs the two things that file
 * doesn't already pin: that `agent.beforeToolCall` is still assignable on a
 * real `Agent`, and the `state.messages` push-vs-assign identity split
 * `pushMessages` depends on (documented verbatim on `Agent#state`'s real
 * getter: "Assigning `state.tools` or `state.messages` copies the provided
 * top-level array").
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { pushMessages, setSystemPrompt, wrapBeforeToolCall } from "../../src/pi/agent.ts";
import { fauxModelBackend } from "../subagents/helpers/faux-model-backend.ts";
import { registerFauxProvider } from "../subagents/helpers/pi-ai.ts";

vi.setConfig({ testTimeout: 30_000 });

describe("agent: Agent#beforeToolCall/state (real pi-coding-agent)", () => {
  let cwd: string;
  let faux: ReturnType<typeof registerFauxProvider>;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pi-canary-agent-"));
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

  it("agent.beforeToolCall is assignable, and wrapBeforeToolCall installs on it", async () => {
    const session = await realSession();
    try {
      const agent = session.agent;
      expect(agent).toBeDefined();

      const priorCalls: string[] = [];
      agent.beforeToolCall = async () => {
        priorCalls.push("prior");
        return undefined;
      };

      const gateCalls: string[] = [];
      wrapBeforeToolCall(agent, async () => {
        gateCalls.push("gate");
        return undefined; // don't decide — fall through to the prior hook
      });

      const result = await agent.beforeToolCall!({} as never, undefined);
      expect(gateCalls).toEqual(["gate"]);
      expect(priorCalls).toEqual(["prior"]);
      expect(result).toBeUndefined();
    } finally {
      session.dispose?.();
    }
  });

  it("setSystemPrompt overwrites agent.state.systemPrompt", async () => {
    const session = await realSession();
    try {
      setSystemPrompt(session.agent, "a replacement prompt");
      expect(session.agent.state.systemPrompt).toBe("a replacement prompt");
    } finally {
      session.dispose?.();
    }
  });

  it("state.messages: assigning a new array copies it (loses identity); pushMessages keeps it", async () => {
    const session = await realSession();
    try {
      const agent = session.agent;
      const before = agent.state.messages;

      // Assign-based append: a real Pi Agent, per its own doc comment,
      // copies on assignment — the array `state.messages` now returns is a
      // NEW reference, not `before` with an item appended in place.
      agent.state.messages = [...agent.state.messages];
      expect(agent.state.messages).not.toBe(before);

      // pushMessages mutates the live array the getter currently returns,
      // so identity survives the append.
      const current = agent.state.messages;
      const marker = { role: "user", content: "pi-canary-marker" } as never;
      pushMessages(agent, [marker]);
      expect(agent.state.messages).toBe(current);
      expect(agent.state.messages).toContain(marker);
    } finally {
      session.dispose?.();
    }
  });
});
