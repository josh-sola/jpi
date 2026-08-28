/**
 * Shared test harness: a minimal fake ExtensionAPI, so tests can drive
 * src/index.ts without a real pi session.
 */

import { vi } from "vite-plus/test";

/** Let queued microtasks and immediates run — event handlers in src/index.ts are async
 *  but the emitter calls them synchronously, so awaiting a tick is how a test observes
 *  their effects. */
export function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/** Minimal mock of ExtensionAPI with tool capture and lifecycle event hooks. */
export function mockPi() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const lifecycleHandlers = new Map<string, ((...args: any[]) => any)[]>();

  const pi = {
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    registerCommand(name: string, def: any) {
      commands.set(name, def);
    },
    on(event: string, handler: any) {
      if (!lifecycleHandlers.has(event)) lifecycleHandlers.set(event, []);
      lifecycleHandlers.get(event)!.push(handler);
    },
    sendUserMessage: vi.fn(),
  };

  return {
    pi,
    tools,
    commands,
    /** Execute a registered tool by name. */
    async executeTool(name: string, params: any, ctx?: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx ?? mockCtx());
    },
    /** Execute a registered tool with an abort signal. */
    async executeToolWithSignal(name: string, params: any, signal: AbortSignal, ctx?: any) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.execute("call-1", params, signal, undefined, ctx ?? mockCtx());
    },
    /** Run a registered command's handler. */
    async runCommand(name: string, args: string, ctx: any) {
      const cmd = commands.get(name);
      if (!cmd) throw new Error(`Command ${name} not registered`);
      return cmd.handler(args, ctx);
    },
    /** Fire lifecycle event handlers (turn_start, tool_result, etc.) */
    async fireLifecycle(event: string, ...args: any[]) {
      const results: any[] = [];
      for (const h of lifecycleHandlers.get(event) ?? []) {
        results.push(await h(...args));
      }
      return results;
    },
  };
}

export type MockPi = ReturnType<typeof mockPi>;

/** Minimal mock ExtensionContext. Pass `modelRegistry` to stub `find`/`complete`/etc. for callers that drive a model call. */
export function mockCtx(
  cwd = process.cwd(),
  overrides: { modelRegistry?: Record<string, unknown> } = {},
) {
  return {
    // Task paths resolve against the session workspace, not the host process cwd.
    cwd,
    model: { id: "test-model", name: "Test" },
    modelRegistry: {},
    ui: {
      setWidget: vi.fn(),
      setStatus: vi.fn(),
      notify: vi.fn(),
    },
    ...overrides,
  };
}

/**
 * Mock ExtensionContext carrying a session ID, for session_start handling.
 *
 * `getSessionFile` mirrors pi: a persisted session has one, and a session pi is not
 * persisting (`pi --no-session`, `SessionManager.inMemory()`) reports a session ID
 * but no file. Pass `{ persisted: false }` for the latter.
 */
export function mockSessionCtx(
  sessionId: string,
  opts?: { persisted?: boolean; cwd?: string; modelRegistry?: Record<string, unknown> },
) {
  const sessionFile = opts?.persisted === false ? undefined : `/sessions/${sessionId}.jsonl`;
  return {
    ...mockCtx(
      opts?.cwd,
      opts?.modelRegistry !== undefined ? { modelRegistry: opts.modelRegistry } : {},
    ),
    sessionManager: {
      getSessionId: vi.fn(() => sessionId),
      getSessionFile: vi.fn(() => sessionFile),
    },
  };
}
