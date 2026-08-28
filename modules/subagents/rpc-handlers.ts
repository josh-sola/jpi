/**
 * rpc-handlers.ts — the cross-extension RPC handler bodies for this
 * extension's manager. The generic ping/spawn/stop/consume plumbing (the
 * event-bus wiring, the reply envelope) lives in cross-extension-rpc.ts and
 * stays there; this file only builds the small `SpawnCapable` object that
 * plumbing calls into.
 */

import { registerRpcHandlers, type RpcHandle } from "./cross-extension-rpc.ts";
import type { SubagentsRuntime } from "./index.ts";

export type { RpcHandle };

/**
 * Register the RPC handlers and broadcast `subagents:ready`. Call once per
 * activation, from `session_start` — see index.ts for why gating on the
 * first bound `session_start` matters for a filtered-out child session.
 */
export function wireRpcHandlers(rt: SubagentsRuntime): RpcHandle {
  const handle = registerRpcHandlers({
    events: rt.pi.events,
    pi: rt.pi,
    getCtx: () => rt.getCurrentCtx(),
    manager: {
      spawn: rt.spawnTopLevel,
      awaitStartup: (id) => rt.manager.awaitStartup(id),
      getRecord: (id) => rt.manager.getRecord(id),
      // Unguarded on purpose: the stop handler now runs the top-level check
      // itself off `getRecord`, and reports the refusal instead of the
      // "Agent not found" a false from here used to be read as.
      abort: (id) => rt.manager.abort(id),
      consumeResult: (id) => {
        const record = rt.resolveAgentRef(id);
        // Same guard as get_subagent_result: a running agent has no result
        // to consume, and its notification is still the caller's only
        // signal that it finished.
        if (!record || record.parentAgentId) return false;
        if (record.status === "running" || record.status === "queued") return false;
        record.resultConsumed = true;
        rt.cancelNudge?.(record.id);
        return true;
      },
    },
  });

  // Broadcast readiness so extensions loaded alongside us can discover us.
  // Emitting after all factories have run (rather than at factory time)
  // also avoids the race where a consumer loaded after us misses the event.
  rt.pi.events.emit("subagents:ready", {});

  return handle;
}

/** Undo `wireRpcHandlers` — called from `session_shutdown`. */
export function unwireRpcHandlers(handle: RpcHandle | undefined): void {
  handle?.unsubSpawn();
  handle?.unsubStop();
  handle?.unsubPing();
  handle?.unsubConsume();
}
