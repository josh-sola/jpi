import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { scratchpadDir, scratchpadRoot } from "../../src/core/scratchpad-dir.ts";

const uid = process.getuid?.() ?? "user";

test("scratchpad root is uid-scoped under the temp root", () => {
  assert.equal(scratchpadRoot("/tmp"), join("/tmp", `jpi-scratchpad-${uid}`));
});

test("scratchpad dir nests the project slug and session id", () => {
  assert.equal(
    scratchpadDir("/Users/tester/repos/app", "abc-123", "/tmp"),
    join("/tmp", `jpi-scratchpad-${uid}`, "-Users-tester-repos-app", "abc-123"),
  );
});

test("scratchpad dir sanitizes hostile session ids", () => {
  assert.equal(
    scratchpadDir("/p", "../up/../../etc", "/tmp"),
    join("/tmp", `jpi-scratchpad-${uid}`, "-p", "..-up-..-..-etc"),
  );
  assert.equal(
    scratchpadDir("/p", "..", "/tmp"),
    join("/tmp", `jpi-scratchpad-${uid}`, "-p", "session"),
  );
});
