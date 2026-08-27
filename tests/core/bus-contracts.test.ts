import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  FLEET_CONSUMER_READY_CHANNEL,
  FLEET_PROVIDER_CHANNEL,
  TASKS_CHANNEL,
  TASKS_SCHEMA,
} from "../../src/core/bus-contracts.ts";

// These strings are an external contract: jpi-sidebar and jpi-planter read
// them directly. A rename here must fail this test rather than ship silently.
test("bus contract channel strings are pinned", () => {
  assert.equal(TASKS_CHANNEL, "jpi-background:tasks:v1");
  assert.equal(TASKS_SCHEMA, "jpi-background.tasks.v1");
  assert.equal(FLEET_PROVIDER_CHANNEL, "subagents:fleet:provider:v1");
  assert.equal(FLEET_CONSUMER_READY_CHANNEL, "subagents:fleet:consumer-ready:v1");
});
