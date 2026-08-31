import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { getAgentDirectory } from "../../src/pi/settings.ts";

test("agent directory honors the Pi agent env var and falls back to the default", () => {
  assert.equal(getAgentDirectory({}, "/Users/tester"), "/Users/tester/.pi/agent");
  assert.equal(
    getAgentDirectory({ PI_CODING_AGENT_DIR: "  " }, "/Users/tester"),
    "/Users/tester/.pi/agent",
  );
  assert.equal(
    getAgentDirectory({ PI_CODING_AGENT_DIR: "/tmp/pi-agent" }, "/Users/tester"),
    "/tmp/pi-agent",
  );
});

test("agent directory expands a leading tilde against the injected home directory", () => {
  assert.equal(
    getAgentDirectory({ PI_CODING_AGENT_DIR: "~/custom-agent" }, "/Users/tester"),
    "/Users/tester/custom-agent",
  );
  assert.equal(getAgentDirectory({ PI_CODING_AGENT_DIR: "~" }, "/Users/tester"), "/Users/tester");
  assert.equal(
    getAgentDirectory({ PI_CODING_AGENT_DIR: "  ~/padded  " }, "/Users/tester"),
    "/Users/tester/padded",
  );
});
