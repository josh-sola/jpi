/**
 * system-prompt.test.ts — canary for src/pi/system-prompt.ts, the highest-
 * value coupling in src/pi/: `appendPiTail` reproduces the `customPrompt`
 * branch of pi's own unexported `buildSystemPrompt`
 * (dist/core/system-prompt.js) byte-for-byte. This is the one legitimate
 * place in the repo for a deep import (see tests/pi/boundary.test.ts's
 * allowlist) — `buildSystemPrompt` isn't exported from pi-coding-agent's
 * root barrel at all, unlike `getReadmePath`/`getDocsPath`/`getExamplesPath`/
 * `formatSkillsForPrompt`, which are.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  formatSkillsForPrompt,
  getDocsPath,
  getExamplesPath,
  getReadmePath,
  type BuildSystemPromptOptions,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { appendPiTail, buildPiDocsBlock } from "../../src/pi/system-prompt.ts";

// The one legitimate deep import in the repo: `buildSystemPrompt` isn't
// exported from pi-coding-agent's root barrel at all, and unlike pi-tui
// (which has no `exports` map — see tests/history/mouse.test.ts),
// pi-coding-agent's package.json DOES declare one, so a bare
// "@earendil-works/pi-coding-agent/dist/core/system-prompt.js" specifier is
// rejected outright. Resolving the root entry first and importing its
// sibling file by an absolute file:// path sidesteps the exports map — that
// enforcement only applies to specifier-based resolution, not to a concrete
// file path. tests/pi/ is exempt from the boundary test's deep-import rule
// for exactly this reason.
const entryPath = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const systemPromptModulePath = join(dirname(entryPath), "core", "system-prompt.js");
const { buildSystemPrompt } = (await import(pathToFileURL(systemPromptModulePath).href)) as {
  buildSystemPrompt: (options: BuildSystemPromptOptions) => string;
};

const FIXTURE_SKILL = {
  name: "demo-skill",
  description: "A demo skill for the canary fixture.",
  filePath: "/repo/project/.agents/skills/demo-skill/SKILL.md",
  baseDir: "/repo/project/.agents/skills/demo-skill",
  disableModelInvocation: false,
} as unknown as Skill;

/** A representative options fixture exercising all four appended pieces. */
function fixtureOptions(): Pick<
  BuildSystemPromptOptions,
  "appendSystemPrompt" | "contextFiles" | "skills" | "selectedTools" | "cwd"
> {
  return {
    appendSystemPrompt: "Extra rules for this project. Follow them exactly.",
    cwd: "/Users/tester/repo",
    contextFiles: [
      { path: "/Users/tester/repo/AGENTS.md", content: "Repo-wide conventions live here." },
    ],
    skills: [FIXTURE_SKILL],
    selectedTools: ["read", "bash"],
  };
}

describe("system-prompt: appendPiTail vs the real buildSystemPrompt (real pi-coding-agent)", () => {
  it("matches the real customPrompt branch's output for a representative fixture", () => {
    const rendered = "RENDERED CUSTOM PROMPT BODY";
    const options = fixtureOptions();

    const jpiResult = appendPiTail(rendered, options, formatSkillsForPrompt);
    const realResult = buildSystemPrompt({ customPrompt: rendered, ...options });

    expect(jpiResult).toBe(realResult);
  });

  it("still matches with no appendSystemPrompt/contextFiles/skills — just the tail", () => {
    const rendered = "BARE BODY";
    const options: Pick<BuildSystemPromptOptions, "cwd"> = { cwd: "/repo" };

    const jpiResult = appendPiTail(rendered, options, formatSkillsForPrompt);
    const realResult = buildSystemPrompt({ customPrompt: rendered, ...options });

    expect(jpiResult).toBe(realResult);
  });

  it("still matches when bash is the only skill file loader", () => {
    const rendered = "BODY";
    const options = { ...fixtureOptions(), selectedTools: ["bash"] };

    const jpiResult = appendPiTail(rendered, options, formatSkillsForPrompt);
    const realResult = buildSystemPrompt({ customPrompt: rendered, ...options });

    expect(jpiResult).toBe(realResult);
    expect(jpiResult).toContain(
      "Use bash to load a skill's file when the task matches its description.",
    );
  });
});

describe("system-prompt: buildPiDocsBlock vs the real stock doc block (real pi-coding-agent)", () => {
  it("reproduces stock pi's doc block verbatim, as a substring of the real stock prompt", () => {
    const paths = {
      readmePath: getReadmePath(),
      docsPath: getDocsPath(),
      examplesPath: getExamplesPath(),
    };
    const jpiBlock = buildPiDocsBlock(paths);

    // No `customPrompt` — real buildSystemPrompt takes its stock branch.
    const realStockPrompt = buildSystemPrompt({ cwd: "/repo" });

    expect(realStockPrompt).toContain(jpiBlock);
  });
});
