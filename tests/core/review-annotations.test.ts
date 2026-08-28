import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  formatReviewDuration,
  getReviewAnnotation,
  hasReviewAnnotationConsumer,
  markReviewAnnotationConsumer,
  onReviewAnnotation,
  recordReviewAnnotation,
} from "../../src/core/review-annotations.ts";

test("formatReviewDuration keeps one decimal under 10s and whole seconds at or above it", () => {
  assert.equal(formatReviewDuration(800), "0.8s");
  assert.equal(formatReviewDuration(1234), "1.2s");
  assert.equal(formatReviewDuration(12000), "12s");
});

test("recordReviewAnnotation stores the annotation for later retrieval", () => {
  recordReviewAnnotation("call-record-1", { durationMs: 500 });
  assert.deepEqual(getReviewAnnotation("call-record-1"), { durationMs: 500 });
  assert.equal(getReviewAnnotation("call-never-recorded"), undefined);
});

test("onReviewAnnotation fires its callback once the annotation for that toolCallId lands", () => {
  let fired = 0;
  const unsubscribe = onReviewAnnotation("call-subscribe-1", () => {
    fired += 1;
  });
  assert.equal(fired, 0);

  recordReviewAnnotation("call-subscribe-1", { durationMs: 900 });
  assert.equal(fired, 1);

  // The subscriber is consumed on fire, so recording again does not re-fire it.
  recordReviewAnnotation("call-subscribe-1", { durationMs: 950 });
  assert.equal(fired, 1);
  unsubscribe();
});

test("a second subscriber for the same toolCallId is ignored until the first fires", () => {
  let firstFired = 0;
  let secondFired = 0;
  onReviewAnnotation("call-subscribe-2", () => {
    firstFired += 1;
  });
  onReviewAnnotation("call-subscribe-2", () => {
    secondFired += 1;
  });

  recordReviewAnnotation("call-subscribe-2", { durationMs: 300 });
  assert.equal(firstFired, 1);
  assert.equal(secondFired, 0);
});

test("unsubscribe removes a still-pending subscriber", () => {
  let fired = 0;
  const unsubscribe = onReviewAnnotation("call-subscribe-3", () => {
    fired += 1;
  });
  unsubscribe();

  recordReviewAnnotation("call-subscribe-3", { durationMs: 100 });
  assert.equal(fired, 0);
});

test("markReviewAnnotationConsumer registers each named tool independently", () => {
  assert.equal(hasReviewAnnotationConsumer("bash"), false);
  assert.equal(hasReviewAnnotationConsumer("read"), false);
  markReviewAnnotationConsumer(["bash", "read"]);
  assert.equal(hasReviewAnnotationConsumer("bash"), true);
  assert.equal(hasReviewAnnotationConsumer("read"), true);
});

test("hasReviewAnnotationConsumer returns false for a name that was never marked", () => {
  markReviewAnnotationConsumer(["web_search"]);
  assert.equal(hasReviewAnnotationConsumer("web_fetch"), false);
});
