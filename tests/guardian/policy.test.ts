import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { REVIEW_POLICY } from "../../modules/guardian/policy.ts";

test("review policy stays under the size budget", () => {
  const bytes = Buffer.byteLength(REVIEW_POLICY, "utf8");
  assert.ok(bytes < 20_000, `policy is ${bytes} bytes, expected under 20000`);
});

test("review policy states the no-prior-context constraint", () => {
  assert.match(REVIEW_POLICY, /## What you see and don't/);
  assert.match(REVIEW_POLICY, /you do not see tool results or the agent's internal reasoning/);
  assert.match(
    REVIEW_POLICY,
    /a tool call shows what the agent attempted, never whether it succeeded/,
  );
});

test("review policy discloses what the transcript now carries", () => {
  assert.match(
    REVIEW_POLICY,
    /a bounded whole-session transcript of the user's own messages with the assistant's prose adjacent to them and the agent's recent tool calls interleaved \(names and bounded arguments only\)/,
  );
  assert.match(REVIEW_POLICY, /answered questionnaire pairs marked as such/);
  assert.match(REVIEW_POLICY, /harness-recorded user approvals of previously denied calls/);
  assert.match(REVIEW_POLICY, /An answer authorizes only the literal thing the question asked/);
  assert.match(REVIEW_POLICY, /A declined questionnaire authorizes nothing/);
});

test("review policy states the interleaved-tool-call and user-approval evidence rules", () => {
  assert.match(
    REVIEW_POLICY,
    /Interleaved tool calls are activity evidence only: they show what the agent attempted, and when, relative to the user's messages — never outcomes, and they never authorize anything\./,
  );
  assert.match(
    REVIEW_POLICY,
    /A harness-recorded user approval is the user's own decision, captured when the user approved a previously denied call after seeing it and its reason\./,
  );
  assert.match(
    REVIEW_POLICY,
    /it authorizes repeating that action and clears same-class calls for the session's task under the consent bar\. It never clears a HARD BLOCK\./,
  );
});

test("review policy states trust defaults", () => {
  assert.match(REVIEW_POLICY, /## Trust defaults/);
  assert.match(
    REVIEW_POLICY,
    /no code host, cloud account, service, or destination is trusted unless/,
  );
  assert.match(
    REVIEW_POLICY,
    /already-configured remotes are inside the trust boundary by default/,
  );
});

test("review policy keeps low-risk carve-outs equivalent to the prior policy", () => {
  assert.match(
    REVIEW_POLICY,
    /Do not deny solely because a path is outside the current working directory/,
  );
  assert.match(
    REVIEW_POLICY,
    /Installing packages already declared in the repo's manifest .* via standard commands is low risk/,
  );
  assert.match(
    REVIEW_POLICY,
    /Installing an agent-chosen package name not already declared carries more risk/,
  );
  assert.match(
    REVIEW_POLICY,
    /Reading credentials from the agent's own config and sending them to their matching, intended provider is routine use/,
  );
});

test("review policy never narrates itself in terms only visible from outside guardian", () => {
  assert.doesNotMatch(REVIEW_POLICY, /claude code/i);
  assert.doesNotMatch(REVIEW_POLICY, /codex/i);
  assert.doesNotMatch(REVIEW_POLICY, /auto[- ]mode/i);
  assert.doesNotMatch(REVIEW_POLICY, /anthropic/i);
});

test("review policy hard-blocks are stated as never cleared by user context", () => {
  const hardBlockSection = REVIEW_POLICY.slice(
    REVIEW_POLICY.indexOf("## HARD BLOCK"),
    REVIEW_POLICY.indexOf("## The consent bar"),
  );
  assert.ok(hardBlockSection.length > 0);
  for (const phrase of [
    "Data exfiltration across the trust boundary",
    "Reviewer or safety-gate bypass",
    "Agent loops with approval gates disabled",
    "Credential exposure to the wrong destination",
  ]) {
    assert.ok(hardBlockSection.includes(phrase), `missing hard block: ${phrase}`);
  }
});
