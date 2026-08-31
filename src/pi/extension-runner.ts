import {
  ExtensionRunner,
  type LoadExtensionsResult,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";

const PATCHED = Symbol.for("jpi:style:mcp-tools-patched");

/**
 * Patches `ExtensionRunner.prototype.getToolDefinition` so every lookup runs
 * through `transform` first: `transform` receives the requested tool name
 * and a bound `original` lookup (`this`-correct, so it can be called more
 * than once or not at all) and returns whatever `getToolDefinition` should
 * now return for that name.
 *
 * `ExtensionRunner.getToolDefinition` is also the path pi's own execution
 * machinery and the HTML transcript exporter use to look up a tool by name,
 * so `transform` is responsible for preserving whatever contract callers
 * expect (falling through to `original` for names it doesn't care about,
 * returning the exact `undefined` `original` would have, etc.) — this
 * installer only owns the patch mechanics.
 *
 * Idempotent: safe to call more than once (across separate `transform`s or
 * the same one — the second call is a no-op either way). Degrades to a
 * no-op — `original` behavior stays, `transform` never runs — if
 * `ExtensionRunner`'s shape doesn't match what this expects; `onDegrade` is
 * called with the error instead of throwing.
 */
export function patchToolDefinitionLookup(
  transform: (toolName: string, original: (name: string) => unknown) => unknown,
  onDegrade: (error: unknown) => void,
): void {
  try {
    const proto = ExtensionRunner.prototype as unknown as Record<PropertyKey, unknown> & {
      [PATCHED]?: boolean;
    };
    if (proto[PATCHED]) return;

    const originalGetToolDefinition = proto.getToolDefinition;
    if (typeof originalGetToolDefinition !== "function") {
      throw new Error("ExtensionRunner.prototype is missing getToolDefinition");
    }

    proto.getToolDefinition = function (this: unknown, toolName: string): unknown {
      const original = (name: string): unknown =>
        (originalGetToolDefinition as (this: unknown, name: string) => unknown).call(this, name);
      return transform(toolName, original);
    };

    Object.defineProperty(proto, PATCHED, { value: true, configurable: true });
  } catch (error) {
    onDegrade(error);
  }
}

/** One loaded extension's path and the tool names it has registered so far. */
export interface LoadedExtensionInfo {
  path: string;
  toolNames: string[];
}

/**
 * Snapshot of every loaded extension's path and registered tool names, read
 * directly off `loader.getExtensions().extensions` and each extension's own
 * `tools` Map.
 *
 * `registerTool` writes into those very maps (see `patchToolDefinitionLookup`
 * above for the sibling reach at the lookup side) — extensions may call it long
 * after load (pi-mcp from `session_start`, context-mode from
 * `before_agent_start`), so this must be called fresh each time rather than
 * cached, to see late arrivals.
 */
export function listExtensionTools(loader: {
  getExtensions(): LoadExtensionsResult;
}): LoadedExtensionInfo[] {
  return loader.getExtensions().extensions.map((extension) => ({
    path: extension.path,
    toolNames: [...extension.tools.keys()],
  }));
}

/** Best-effort ceiling on one child's shutdown handlers, so teardown can't strand a quit. */
const SESSION_SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * Emits `session_shutdown` on `session.extensionRunner`, racing it against a
 * timeout so one hung handler can't strand teardown.
 *
 * `AgentSession.dispose()` only calls `ExtensionRunner.invalidate()` — pi
 * emits the event itself in `AgentSessionRuntime.dispose()` beforehand, and
 * this is for the one place (a child session torn down outside that normal
 * path) that binds extensions onto a session without going through it.
 * Without the emit, everything an extension armed in `session_start` leaks
 * once per spawn, and its next tick throws `assertActive()` from a bare timer
 * callback — an uncaughtException that kills pi (#242).
 *
 * Optional all the way down: on a pi without the `hasHandlers`/`emit`
 * methods, or a stubbed session from a partial `onSessionCreated`, this is a
 * no-op — the same degrade as before the fix. Callers should still wrap the
 * call in their own try/catch: a partial session must degrade, not take the
 * caller's teardown down with it.
 *
 * Deliberately NOT an `async function`: returning `undefined` synchronously
 * (rather than an already-resolved Promise) when there's nothing to emit lets
 * a caller skip `await` on that path and stay fully synchronous — no `await`
 * keyword, even on an immediately-resolved promise, is free of a microtask
 * tick.
 */
export function emitSessionShutdown(
  session: { extensionRunner?: ExtensionRunner } | undefined,
): Promise<void> | undefined {
  const runner = session?.extensionRunner;
  if (!runner?.hasHandlers?.("session_shutdown")) return undefined;
  const event: SessionShutdownEvent = { type: "session_shutdown", reason: "quit" };
  return Promise.race([
    runner.emit(event),
    new Promise<void>((resolve) => setTimeout(resolve, SESSION_SHUTDOWN_TIMEOUT_MS).unref()),
  ]).then(() => undefined);
}
