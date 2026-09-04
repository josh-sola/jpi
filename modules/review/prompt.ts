const DEFAULT_TARGET = "local git state, including staged, unstaged, and untracked changes";

export function buildReviewPrompt(args: string): string {
  const target = args.trim() === "" ? DEFAULT_TARGET : args;

  return `Perform a strictly read-only, user-invoked code review for this target/focus instruction:

<review_target>
${target}
</review_target>

This is review-only work. Neither you nor any subagent may edit files, apply patches, write files, run builds, type checks, or tests, or post/comment externally. Do not use \`gh pr comment\`. Use only read-only inspection and collection commands/tools.

First, confirm that the \`Agent\` tool is available. If it is unavailable, state that jpi's subagents module is required for /review and stop; do not attempt a single-agent substitute.

For local targets, use read-only \`git\` commands to collect staged, unstaged, and untracked changes. For PR targets, use only read-only \`gh pr view\`, \`gh pr diff\`, \`gh pr list\`, and \`gh search\` operations. Distinguish these collection paths based on the target instruction.

Then perform this workflow:

1. Launch one parallel \`Agent\` batch of three separate, read-only \`explore\` agents (or a better type only if the repository's actual Agent contract requires it). Give each the raw target and collection rules. Assign one to determine eligibility: local state is eligible only when it has reviewable staged, unstaged, or untracked changes; PR state is eligible only when it is valid and reviewable. Assign one to discover the applicable \`AGENTS.md\` and \`CLAUDE.md\` files. Assign one to summarize the changes. Combine their results into an internal target/instruction summary. If the target is ineligible, state that there is no reviewable target and stop.
2. Launch exactly five independent, read-only \`general-purpose\` reviewers as one parallel \`Agent\` batch (or a better type only if the repository's actual Agent contract requires it). Give each the internal summary and one distinct focus: (a) instruction compliance, (b) shallow bugs in changed code, (c) relevant git history, (d) prior PR/review context, and (e) code-comment constraints. Each reviewer returns only candidate findings with evidence.
3. Treat these as false positives and exclude them: pre-existing or disproven issues; compiler, linter, or test-catchable errors such as missing imports, type errors, broken tests, or formatting; style or pedantic nitpicks not required by applicable project instructions; intentional or directly related functionality changes; and findings outside changed lines.
4. Launch one parallel \`Agent\` batch with one read-only \`explore\` validator per candidate finding (or a better type only if the repository's actual Agent contract requires it). Validators independently inspect the cited code, verify instruction-based findings against the applicable instruction, and score confidence anywhere from 0 to 100 using these anchors verbatim:
   - **0:** Not confident at all. This is a false positive that doesn't stand up to light scrutiny, or is a pre-existing issue.
   - **25:** Somewhat confident. This might be a real issue, but may also be a false positive. The agent wasn't able to verify that it's a real issue. If the issue is stylistic, it is one that was not explicitly called out in the relevant CLAUDE.md.
   - **50:** Moderately confident. The agent was able to verify this is a real issue, but it might be a nitpick or not happen very often in practice. Relative to the rest of the PR, it's not very important.
   - **75:** Highly confident. The agent double checked the issue, and verified that it is very likely it is a real issue that will be hit in practice. The existing approach in the PR is insufficient. The issue is very important and will directly impact the code's functionality, or it is an issue that is directly mentioned in the relevant CLAUDE.md.
   - **100:** Absolutely certain. The agent double checked the issue, and confirmed that it is definitely a real issue, that will happen frequently in practice. The evidence directly confirms this.
   Keep only findings with confidence >=80.
5. Before reporting, recheck eligibility with a read-only \`explore\` agent. If the target changed or is no longer eligible, do not report earlier findings as current; state that the target changed and stop.
6. Return only the concise final report, with findings first. For each surviving finding include severity, concise title, impact, evidence, path and line range, confidence, and a concrete fix direction. If no findings survive, say "No issues found" and name the reviewed target. Do not include praise or low-value suggestions.`;
}
