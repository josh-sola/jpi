import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerReview } from "../../modules/review/index.ts";
import { buildReviewPrompt } from "../../modules/review/prompt.ts";

type ReviewCommand = {
  readonly description: string;
  handler(args: string): unknown;
};

function registerTestReview() {
  let command: ReviewCommand | undefined;
  const messages: string[] = [];
  const pi = {
    registerCommand(name: string, value: ReviewCommand) {
      assert.equal(name, "review");
      command = value;
    },
    sendUserMessage(message: string) {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;

  registerReview(pi);
  assert.ok(command, "the review command should be registered");
  return { command, messages };
}

test("/review registers a descriptive command that expands into a user message", async () => {
  const { command, messages } = registerTestReview();

  assert.match(command.description, /review code changes/i);
  await command.handler("PR 123");
  assert.equal(messages.length, 1);
  assert.equal(messages[0], buildReviewPrompt("PR 123"));
});

test("blank /review arguments default to all local git state", () => {
  const prompt = buildReviewPrompt("   \t ");

  assert.match(prompt, /local git state, including staged, unstaged, and untracked changes/);
  assert.match(prompt, /read-only `git` commands/);
});

test("nonblank /review arguments are preserved as free-form target instructions", () => {
  const args = "  changes against main focusing on retries  ";
  const prompt = buildReviewPrompt(args);

  assert.match(prompt, new RegExp(`<review_target>\\n${args}\\n</review_target>`));
});

test("/review uses a read-only explore batch to establish and recheck eligibility", () => {
  const prompt = buildReviewPrompt("PR 123");

  assert.match(prompt, /strictly read-only, user-invoked code review/);
  assert.match(
    prompt,
    /may edit files, apply patches, write files, run builds, type checks, or tests, or post\/comment externally/,
  );
  assert.match(prompt, /Do not use `gh pr comment`/);
  assert.match(prompt, /`gh pr view`, `gh pr diff`, `gh pr list`, and `gh search`/);
  assert.match(prompt, /parallel `Agent` batch of three separate, read-only `explore` agents/);
  assert.match(
    prompt,
    /local state is eligible only when it has reviewable staged, unstaged, or untracked changes/,
  );
  assert.match(prompt, /PR state is eligible only when it is valid and reviewable/);
  assert.match(prompt, /discover the applicable `AGENTS.md` and `CLAUDE.md` files/);
  assert.match(prompt, /summarize the changes/);
  assert.match(prompt, /recheck eligibility with a read-only `explore` agent/);
  assert.match(prompt, /do not report earlier findings as current/);
});

test("/review assigns deep reviewers and excludes useful false-positive categories", () => {
  const prompt = buildReviewPrompt("PR 123");

  assert.match(
    prompt,
    /exactly five independent, read-only `general-purpose` reviewers as one parallel `Agent` batch/,
  );
  assert.match(prompt, /instruction compliance/);
  assert.match(prompt, /shallow bugs in changed code/);
  assert.match(prompt, /relevant git history/);
  assert.match(prompt, /prior PR\/review context/);
  assert.match(prompt, /code-comment constraints/);
  assert.match(prompt, /pre-existing or disproven issues/);
  assert.match(prompt, /compiler, linter, or test-catchable errors/);
  assert.match(
    prompt,
    /style or pedantic nitpicks not required by applicable project instructions/,
  );
  assert.match(prompt, /intentional or directly related functionality changes/);
  assert.match(prompt, /findings outside changed lines/);
});

test("/review validates candidates continuously against the original confidence anchors", () => {
  const prompt = buildReviewPrompt("PR 123");
  const anchors = [
    "**0:** Not confident at all. This is a false positive that doesn't stand up to light scrutiny, or is a pre-existing issue.",
    "**25:** Somewhat confident. This might be a real issue, but may also be a false positive. The agent wasn't able to verify that it's a real issue. If the issue is stylistic, it is one that was not explicitly called out in the relevant CLAUDE.md.",
    "**50:** Moderately confident. The agent was able to verify this is a real issue, but it might be a nitpick or not happen very often in practice. Relative to the rest of the PR, it's not very important.",
    "**75:** Highly confident. The agent double checked the issue, and verified that it is very likely it is a real issue that will be hit in practice. The existing approach in the PR is insufficient. The issue is very important and will directly impact the code's functionality, or it is an issue that is directly mentioned in the relevant CLAUDE.md.",
    "**100:** Absolutely certain. The agent double checked the issue, and confirmed that it is definitely a real issue, that will happen frequently in practice. The evidence directly confirms this.",
  ];

  assert.match(prompt, /one read-only `explore` validator per candidate finding/);
  assert.match(prompt, /score confidence anywhere from 0 to 100/);
  for (const anchor of anchors) assert.ok(prompt.includes(anchor));
  assert.match(prompt, /Keep only findings with confidence >=80/);
  assert.match(
    prompt,
    /severity, concise title, impact, evidence, path and line range, confidence, and a concrete fix direction/,
  );
  assert.match(prompt, /No issues found/);
  assert.match(prompt, /Do not include praise or low-value suggestions/);
});
