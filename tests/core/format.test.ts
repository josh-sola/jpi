import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { truncateEnd } from "../../src/core/format.ts";

test("truncateEnd leaves short text alone", () => {
  assert.equal(truncateEnd("short", 80), "short");
});

test("truncateEnd truncates with an ellipsis at the limit", () => {
  const result = truncateEnd("a".repeat(90), 80);
  assert.equal(result.length, 80);
  assert.ok(result.endsWith("…"));
});

test("truncateEnd trims trailing whitespace left by the cut before appending the ellipsis", () => {
  assert.equal(truncateEnd("hello   world", 8), "hello…");
});
