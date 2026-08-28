/**
 * abortable.ts — race a promise against an AbortSignal without cancelling the
 * underlying work, plus two tiny agent-record helpers shared by the top-level
 * and nested subagent tools.
 *
 * Used by the `get_subagent_result` wait paths (top-level and nested): pressing
 * Esc cancels only the caller's wait; the background child keeps running and its
 * result stays unconsumed. The listener is removed on every settle path so the
 * signal accumulates no handlers, and a late settlement of the wrapped promise
 * after an abort is absorbed as a no-op (no unhandled rejection).
 *
 * The two helpers below live here, not in agent-manager.ts, so nested-tools.ts
 * can share them without importing agent-manager.ts — that import would close
 * a cycle back through agent-runner.ts (which imports nested-tools.ts to build
 * a child session's scoped tools), and `vi.mock("./agent-runner.ts")` cannot
 * see through a cycle: the mock factory loses to whichever side of the loop
 * initializes first, so tests silently exercise the real, unmocked runner.
 */

import type { AgentRecord } from "./types.ts";

/** Await a promise until it settles or the caller cancels, without aborting the underlying work. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * Queue a steering message for delivery once `record`'s session exists.
 * Shared by every caller that can steer a not-yet-running agent — the
 * manager's own `steer()`, and the top-level/nested `steer_subagent` tools —
 * so they queue on the same field the manager's session-created flush drains.
 */
export function queuePendingSteer(record: AgentRecord, message: string): void {
  if (!record.pendingSteers) record.pendingSteers = [];
  record.pendingSteers.push(message);
}

/** Poll interval while a `wait: true` caller is parked behind a queued agent. */
const QUEUE_WAIT_POLL_MS = 250;

/**
 * Wait for a queued-or-running agent to settle, for `get_subagent_result`'s
 * (and the nested result tool's) `wait: true`. Cancellation stops only the
 * caller's wait — via `abortable` — the agent itself keeps running either way.
 * Queued records have no run promise yet (one is created when the queue starts
 * them), so this polls until the record leaves the queue, then awaits it like
 * a running one.
 */
export async function awaitAgentSettled(record: AgentRecord, signal?: AbortSignal): Promise<void> {
  while (record.status === "queued") {
    await abortable(
      new Promise<void>((resolve) => setTimeout(resolve, QUEUE_WAIT_POLL_MS)),
      signal,
    );
  }
  if (record.promise) await abortable(record.promise, signal);
}
