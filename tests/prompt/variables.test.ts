import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  buildEnvironment,
  buildGuidelines,
  buildPiDocsBlock,
  buildToolList,
} from "../../src/pi/system-prompt.ts";

test("buildToolList renders one line per tool that has a snippet", () => {
  const result = buildToolList({
    selectedTools: ["read", "bash", "edit"],
    toolSnippets: { read: "reads files", edit: "edits files" },
  });
  assert.equal(result, "- read: reads files\n- edit: edits files");
});

test("buildToolList falls back to pi's default tool set when none is selected", () => {
  const result = buildToolList({
    toolSnippets: { write: "writes files" },
  });
  assert.equal(result, "- write: writes files");
});

test("buildToolList is empty when no selected tool has a snippet", () => {
  assert.equal(buildToolList({ selectedTools: ["bash"], toolSnippets: {} }), "");
  assert.equal(buildToolList({ selectedTools: [] }), "");
});

test("buildGuidelines dedupes bullets and trims whitespace", () => {
  const result = buildGuidelines({
    promptGuidelines: ["Be concise", "  Be concise  ", "Show file paths"],
  });
  assert.equal(result, "- Be concise\n- Show file paths");
});

test("buildGuidelines drops blank entries and returns empty string when nothing remains", () => {
  assert.equal(buildGuidelines({ promptGuidelines: ["  ", ""] }), "");
  assert.equal(buildGuidelines({}), "");
});

test("buildPiDocsBlock reproduces stock pi's documentation block", () => {
  const result = buildPiDocsBlock({
    readmePath: "/pkg/README.md",
    docsPath: "/pkg/docs",
    examplesPath: "/pkg/examples",
  });
  assert.match(result, /^Pi documentation \(read only when the user asks about pi itself/);
  assert.match(result, /- Main documentation: \/pkg\/README\.md/);
  assert.match(result, /- Additional docs: \/pkg\/docs/);
  assert.match(result, /- Examples: \/pkg\/examples \(extensions, custom tools, SDK\)/);
});

test("buildEnvironment renders one key/value line per fact", () => {
  const result = buildEnvironment({
    cwd: "/Users/tester/project",
    isGitRepo: true,
    platform: "darwin",
    osRelease: "25.5.0",
    today: "2026-08-26",
  });
  assert.equal(
    result,
    [
      "Working directory: /Users/tester/project",
      "Is git repo: yes",
      "Platform: darwin",
      "OS version: 25.5.0",
      "Today's date: 2026-08-26",
    ].join("\n"),
  );
});

test("buildEnvironment reports a non-git directory correctly", () => {
  const result = buildEnvironment({
    cwd: "/tmp/scratch",
    isGitRepo: false,
    platform: "linux",
    osRelease: "6.1.0",
    today: "2026-08-26",
  });
  assert.match(result, /Is git repo: no/);
});
