import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { appendPiTail } from "../../src/pi/system-prompt.ts";

test("appendPiTail appends appendSystemPrompt text, then the current working directory line", () => {
  const result = appendPiTail(
    "rendered body",
    { appendSystemPrompt: "extra rules", cwd: "/Users/tester/project" },
    () => "",
  );
  assert.equal(
    result,
    "rendered body\n\nextra rules\nCurrent working directory: /Users/tester/project\n",
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

test("appendPiTail includes skills with the preferred available file loader", () => {
  const loaders: Array<"read" | "bash" | undefined> = [];
  const formatSkills = (_skills: unknown[], fileReadTool?: "read" | "bash") => {
    loaders.push(fileReadTool);
    return `\n\nSKILLS BLOCK (${fileReadTool})`;
  };

  const withRead = appendPiTail(
    "body",
    { cwd: "/repo", skills: [{ name: "demo" } as never], selectedTools: ["bash", "read"] },
    formatSkills,
  );
  assert.match(withRead, /SKILLS BLOCK \(read\)/);

  const withBash = appendPiTail(
    "body",
    { cwd: "/repo", skills: [{ name: "demo" } as never], selectedTools: ["bash"] },
    formatSkills,
  );
  assert.match(withBash, /SKILLS BLOCK \(bash\)/);
  assert.deepEqual(loaders, ["read", "bash"]);
});

test("appendPiTail normalizes a Windows-style cwd to forward slashes, matching stock pi", () => {
  const result = appendPiTail("body", { cwd: "C:\\Users\\tester\\project" }, () => "");
  assert.match(result, /Current working directory: C:\/Users\/tester\/project/);
});
