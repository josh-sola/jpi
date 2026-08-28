// README publishes concrete default values (Persistent settings, README:441).
// Every existing test that looked like it checked one actually SET the value
// first — `test/agent-runner-settings.test.ts` had a `beforeEach(setGraceTurns(5))`
// followed by `it("defaults to 5")`, which asserts the setter, not the default.
//
// The defaults live in module-level `let`s that the settings appliers overwrite
// at boot, so reading them after any other suite has run tells you nothing.
// `vi.resetModules()` + a dynamic import gives a genuinely fresh module, which
// is why this lives in its own file: resetModules is file-wide and hostile to
// suites that hold module references across tests.

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

describe("documented defaults (README:441)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  // modules/subagents/agent-runner.ts pulls in the whole pi-coding-agent graph, and
  // `server.deps.inline` means resetModules re-transforms all of it — several
  // seconds under a loaded full run, versus instant in isolation. The default
  // 5s timeout makes these two flaky, so they get an explicit generous one
  // rather than a retry.
  const HEAVY_REIMPORT_MS = 60_000;

  it(
    "grace turns after the soft limit default to 5",
    async () => {
      const { getGraceTurns } = await import("../../modules/subagents/agent-runner.ts");
      expect(getGraceTurns()).toBe(5);
    },
    HEAVY_REIMPORT_MS,
  );

  it(
    "max turns is unlimited by default",
    async () => {
      const { getDefaultMaxTurns } = await import("../../modules/subagents/agent-runner.ts");
      expect(getDefaultMaxTurns()).toBeUndefined();
    },
    HEAVY_REIMPORT_MS,
  );

  it("nested subagent depth defaults to 2", async () => {
    const { getMaxSubagentDepth } = await import("../../modules/subagents/nested-tools.ts");
    expect(getMaxSubagentDepth()).toBe(2);
  });

  // Every top-level agent is charged to this one pool — a lower limit
  // would silently queue the tail of the parallel fan-outs the `Agent` tool
  // description tells the model to send.
  it("background concurrency defaults to 10", async () => {
    const { AgentManager } = await import("../../modules/subagents/agent-manager.ts");
    const manager = new AgentManager();
    try {
      expect(manager.getMaxConcurrent()).toBe(10);
    } finally {
      await manager.dispose();
    }
  });

  it("resolveAgentInvocationConfig: defaultRunInBackground fills the gap for a nested spawn, and an explicit param wins", async () => {
    const { resolveAgentInvocationConfig } =
      await import("../../modules/subagents/invocation-config.ts");
    // nested-tools.ts passes false unconditionally — a nested spawn defaults
    // to inline since a detached child has no wake channel. The top-level
    // Agent tool never calls this with a default at all: every top-level
    // spawn is background unconditionally.
    expect(
      resolveAgentInvocationConfig(undefined, {}, { defaultRunInBackground: false })
        .runInBackground,
    ).toBe(false);
    // An explicit param still wins over the default either way.
    expect(
      resolveAgentInvocationConfig(
        undefined,
        { run_in_background: true },
        { defaultRunInBackground: false },
      ).runInBackground,
    ).toBe(true);
    expect(
      resolveAgentInvocationConfig(
        undefined,
        { run_in_background: false },
        { defaultRunInBackground: true },
      ).runInBackground,
    ).toBe(false);
  });

  it("model scope is off by default", async () => {
    // Off is the safe default: on, an unconfigured enabledModels would start
    // refusing spawns. README:428 documents it as opt-in.
    const { isScopeModelsEnabled } = await import("../../modules/subagents/model-scope.ts");
    expect(isScopeModelsEnabled()).toBe(false);
  });

  it("worktree isolation is on, with a 30-day cleanup period, by default", async () => {
    const { isWorktreeIsolationEnabled, getWorktreeCleanupPeriodDays } =
      await import("../../modules/subagents/worktree.ts");
    expect(isWorktreeIsolationEnabled()).toBe(true);
    expect(getWorktreeCleanupPeriodDays()).toBe(30);
  });
});
