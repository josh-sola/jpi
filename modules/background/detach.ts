/**
 * Backs the run tool's ctrl+b detach: races a foreground caller's wait
 * against an internal abort, without touching the process it's waiting on.
 */

export const DETACH_MARKER = Symbol("run-detach");

/** Await a promise until it settles or `signal` fires, without cancelling the underlying work. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as unknown);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal.reason as unknown);
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
 * Tracks foreground `run` calls currently blocked on their task's waiter, so
 * ctrl+b can release them early. A tool call registers itself for the
 * duration of its wait and unregisters in a `finally`, which is also what
 * makes a detach after the wait already settled a no-op — by then the entry
 * is gone and detachAll() has nothing left to act on.
 */
export class DetachRegistry {
  private readonly controllers = new Map<string, AbortController>();

  register(taskId: string, controller: AbortController): void {
    this.controllers.set(taskId, controller);
  }

  unregister(taskId: string): void {
    this.controllers.delete(taskId);
  }

  hasActive(): boolean {
    return this.controllers.size > 0;
  }

  /** Detaches every currently-awaiting foreground run; returns how many were detached. */
  detachAll(): number {
    const controllers = [...this.controllers.values()];
    for (const controller of controllers) controller.abort(DETACH_MARKER);
    return controllers.length;
  }
}
