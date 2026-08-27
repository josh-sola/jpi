/**
 * Session-scoped registry that lets guardian's "reviewed" annotation reach
 * the style module's tool-result renderer instead of pi's own appended-entry
 * path (which always inserts a blank-line spacer above the annotation).
 * Module-level state: one process is one session.
 */

export interface ReviewAnnotation {
  readonly durationMs: number;
}

const annotations = new Map<string, ReviewAnnotation>();
const subscribers = new Map<string, () => void>();
let hasConsumer = false;

/** Called once by a module (the style module) that renders the annotation itself. */
export function markReviewAnnotationConsumer(): void {
  hasConsumer = true;
}

export function hasReviewAnnotationConsumer(): boolean {
  return hasConsumer;
}

/** Stores the annotation for `toolCallId` and fires its subscriber, if any. */
export function recordReviewAnnotation(toolCallId: string, annotation: ReviewAnnotation): void {
  annotations.set(toolCallId, annotation);
  const subscriber = subscribers.get(toolCallId);
  if (!subscriber) return;
  subscribers.delete(toolCallId);
  subscriber();
}

export function getReviewAnnotation(toolCallId: string): ReviewAnnotation | undefined {
  return annotations.get(toolCallId);
}

/**
 * Subscribes `callback` to fire once, the moment `toolCallId`'s annotation is
 * recorded. A toolCallId only ever keeps one waiting subscriber — a second
 * call before the first fires is a no-op — so a renderer that re-subscribes
 * on every repaint neither leaks nor double-fires. Returns an unsubscribe
 * that only removes `callback` if it is still the registered one.
 */
export function onReviewAnnotation(toolCallId: string, callback: () => void): () => void {
  if (!subscribers.has(toolCallId)) subscribers.set(toolCallId, callback);
  return () => {
    if (subscribers.get(toolCallId) === callback) subscribers.delete(toolCallId);
  };
}

// Sub-10s durations keep one decimal of precision (reviews are fast enough
// that whole seconds alone would hide most of the variation); 10s and above
// round to a whole second, since that precision stops being useful.
export function formatReviewDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  if (seconds < 10) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}
