import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { appendPiTail } from "../../modules/prompt/system-prompt-tail.ts";

test("appendPiTail appends appendSystemPrompt text, then the current working directory line", () => {
  const result = appendPiTail(
    "rendered body",
    { appendSystemPrompt: "extra rules", cwd: "/Users/tester/project" },
    () => "",
  );
  assert.equal(
    result,
    "rendered body\n\nextra rules\nCurrent working directory: /Users/tester/project",
  );
});

test("appendPiTail renders the <project_context> block for loaded context files", () => {
  const result = appendPiTail(
    "rendered body",
    {
      cwd: "/repo",
      contextFiles: [{ path: "/repo/AGENTS.md", content: "repo rules" }],
    },
    () => "",
  );
  assert.match(result, /<project_context>/);
  assert.match(
    result,
    /<project_instructions path="\/repo\/AGENTS\.md">\nrepo rules\n<\/project_instructions>/,
  );
  assert.match(result, /<\/project_context>/);
});

test("appendPiTail includes skills only when the read tool is available", () => {
  const withRead = appendPiTail(
    "body",
    { cwd: "/repo", skills: [{ name: "demo" } as never], selectedTools: ["read"] },
    () => "\n\nSKILLS BLOCK",
  );
  assert.match(withRead, /SKILLS BLOCK/);

  const withoutRead = appendPiTail(
    "body",
    { cwd: "/repo", skills: [{ name: "demo" } as never], selectedTools: ["bash"] },
    () => "\n\nSKILLS BLOCK",
  );
  assert.doesNotMatch(withoutRead, /SKILLS BLOCK/);
});

test("appendPiTail normalizes a Windows-style cwd to forward slashes, matching stock pi", () => {
  const result = appendPiTail("body", { cwd: "C:\\Users\\tester\\project" }, () => "");
  assert.match(result, /Current working directory: C:\/Users\/tester\/project/);
});
