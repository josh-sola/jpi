/**
 * spawn-invariants.perf.test.ts — how much disk work one `Agent` call is
 * allowed to do.
 *
 * `execute` opens with `reloadCustomAgents()`, which sweeps three directories
 * and parses the YAML frontmatter of every agent file it finds, synchronously.
 * The benchmark measures that at ~1.8 ms for 50 agent files and ~7.4 ms for
 * 200 — per call, and a fan-out pays it per agent. That cost is a deliberate
 * trade (new agent files work without a restart); paying it *twice* would not
 * be, and is exactly the kind of thing a refactor adds without noticing.
 *
 * Counted, not timed, for the reasons in `render-invariants.perf.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

let loads = 0;

vi.mock("../../../modules/subagents/agent-runner.ts", async () => {
  const actual = await vi.importActual<typeof import("../../../modules/subagents/agent-runner.ts")>(
    "../../../modules/subagents/agent-runner.ts",
  );
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("../../../modules/subagents/custom-agents.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../../../modules/subagents/custom-agents.ts")
  >("../../../modules/subagents/custom-agents.ts");
  return {
    ...actual,
    loadCustomAgents: (...args: Parameters<typeof actual.loadCustomAgents>) => {
      loads++;
      return actual.loadCustomAgents(...args);
    },
  };
});

import { runAgent } from "../../../modules/subagents/agent-runner.ts";
import { registerAgents } from "../../../modules/subagents/agent-types.ts";
import {
  ctx,
  flush,
  type Hermetic,
  hermeticDir,
  makePi,
  subagentsExtension,
} from "../helpers/boot-extension.ts";

let hermetic: Hermetic;

beforeEach(() => {
  loads = 0;
  vi.mocked(runAgent).mockReset();
  vi.mocked(runAgent).mockImplementation(async () => ({
    responseText: "done",
    session: { dispose: vi.fn() } as any,
    aborted: false,
    steered: false,
  }));
});

afterEach(() => {
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  registerAgents(new Map());
  hermetic?.restore();
});

/** Boot the real extension in a hermetic cwd and hand back its Agent tool. */
async function bootAgentTool() {
  hermetic = hermeticDir({
    agentFiles: {
      alpha: '---\ndescription: "First fixture agent."\n---\n\nAlpha.\n',
      beta: '---\ndescription: "Second fixture agent."\n---\n\nBeta.\n',
    },
  });
  const { pi, tools } = makePi();
  await subagentsExtension(pi);
  return tools.get("Agent");
}

describe("one Agent call, one sweep of the agent directories", () => {
  it("reloads agent files at most once per background spawn", async () => {
    const agent = await bootAgentTool();
    loads = 0; // activation legitimately loads once; this counts the call only

    await agent.execute(
      "tc-1",
      { subagent_type: "general-purpose", description: "d", prompt: "p", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    await flush();

    expect(loads).toBeLessThanOrEqual(1);
  });

  it("does not scale the sweep with the number of spawns in flight", async () => {
    const agent = await bootAgentTool();
    loads = 0;

    for (let i = 0; i < 5; i++) {
      await agent.execute(
        `tc-${i}`,
        {
          subagent_type: "general-purpose",
          description: "d",
          prompt: "p",
          run_in_background: true,
        },
        undefined,
        undefined,
        ctx(),
      );
    }
    await flush();

    // Five calls, five sweeps at most — not five per call, and not one sweep per
    // agent already running.
    expect(loads).toBeLessThanOrEqual(5);
  });
});
