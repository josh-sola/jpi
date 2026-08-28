/**
 * background-by-default.test.ts — every top-level `Agent` spawn runs in the
 * background, asserted at the tool boundary rather than at the resolver.
 *
 * `documented-defaults.test.ts` pins `resolveAgentInvocationConfig`'s
 * arguments; this pins what the orchestrator actually receives back from a
 * real `Agent` call, which is the part the tool description makes promises
 * about:
 *
 *   - a spawn hands back an ID instead of the agent's output,
 *   - `run_in_background: false` is not a schema field — passing it
 *     anyway is silently ignored, so the call still backgrounds,
 *   - a fan-out sized like the ones the description tells the model to send
 *     runs concurrently instead of queueing behind `maxConcurrent`.
 *
 * That last one is the reason the concurrency default is 10, not 4: with
 * every top-level spawn charged to the one background pool, a lower limit
 * would silently queue the tail of exactly the parallel fan-outs the
 * description tells the model to send.
 */
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../modules/subagents/agent-runner.ts", async () => {
  const actual = await vi.importActual<typeof import("../../modules/subagents/agent-runner.ts")>(
    "../../modules/subagents/agent-runner.ts",
  );
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../../modules/subagents/agent-runner.ts";
import { subagentsExtension } from "./helpers/boot-extension.ts";

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>();
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    getAllTools: vi.fn(() => [] as any[]),
    setActiveTools: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle };
}

function ctx() {
  return {
    hasUI: false,
    ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn() },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const textOf = (r: any): string => r.content[0].text;

const settled = (text: string) =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: text,
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  } as any);

function spawn(tools: Map<string, any>, params: Record<string, unknown> = {}) {
  return tools
    .get("Agent")
    .execute(
      "tc",
      { prompt: "go", description: "d", subagent_type: "general-purpose", ...params },
      undefined,
      undefined,
      ctx(),
    );
}

describe("every top-level spawn runs in the background", () => {
  it("returns an agent ID, not the result, when the call doesn't specify", async () => {
    const { pi, tools } = makePi();
    await subagentsExtension(pi);
    settled("THE-PAYLOAD");

    const out = textOf(await spawn(tools));

    expect(out).toContain("Agent ID:");
    // The whole point of backgrounding: the orchestrator does NOT get the
    // output here — it arrives later as a notification preview.
    expect(out).not.toContain("THE-PAYLOAD");
  });

  it("run_in_background: false is not a schema field — passing it anyway has no effect", async () => {
    const { pi, tools } = makePi();
    await subagentsExtension(pi);
    settled("THE-PAYLOAD");

    const out = textOf(await spawn(tools, { run_in_background: false }));

    // Still backgrounds: the field isn't declared, so pi passes it through
    // as an unknown extra property that the tool never reads.
    expect(out).toContain("Agent ID:");
    expect(out).not.toContain("THE-PAYLOAD");
  });

  it("starts a six-way fan-out concurrently instead of queueing the tail", async () => {
    // Six is the shape the Agent tool description tells the model to send.
    // With maxConcurrent at its old 4 this queued two of them.
    const { pi, tools } = makePi();
    await subagentsExtension(pi);
    // Never settles — every agent stays occupying its slot for the whole test.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any);

    const outs: string[] = [];
    for (let i = 0; i < 6; i++) outs.push(textOf(await spawn(tools)));

    expect(outs).toHaveLength(6);
    for (const out of outs) expect(out).not.toContain("queued");
  });
});
