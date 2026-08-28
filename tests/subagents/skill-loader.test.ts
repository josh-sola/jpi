import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { preloadSkills, type PreloadedSkill } from "../../modules/subagents/skill-loader.ts";

// preloadSkills maps 1:1 over its input names, so indexing into its result at a
// position we know we passed a name for is always in bounds.
function at(skills: PreloadedSkill[], index: number): PreloadedSkill {
  const skill = skills[index];
  if (skill === undefined) {
    throw new Error(`expected a preloaded skill at index ${index}`);
  }
  return skill;
}

describe("preloadSkills", () => {
  let tmpDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-skill-test-"));
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(tmpDir, "user-agent-dir");
  });

  afterEach(() => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const projectRoot = () => join(tmpDir, ".agents", "skills");
  const globalRoot = () => join(process.env.PI_CODING_AGENT_DIR!, "skills");

  function writeFlat(root: string, name: string, content: string, ext = ".md") {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, name + ext), content);
  }

  function writeSkillDir(root: string, name: string, content: string) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), content);
  }

  it("returns empty array for empty skill list", () => {
    expect(preloadSkills([], tmpDir)).toEqual([]);
  });

  it("loads a top-level flat .md skill from project", () => {
    writeFlat(projectRoot(), "api-conventions", "# API Conventions");
    const result = preloadSkills(["api-conventions"], tmpDir);
    expect(at(result, 0).content).toContain("API Conventions");
  });

  it("ignores .txt files (only .md is supported)", () => {
    writeFlat(projectRoot(), "error-handling", "should not load", ".txt");
    expect(at(preloadSkills(["error-handling"], tmpDir), 0).content).toContain("not found");
  });

  it("ignores extensionless files (only .md is supported)", () => {
    writeFlat(projectRoot(), "bare-skill", "should not load", "");
    expect(at(preloadSkills(["bare-skill"], tmpDir), 0).content).toContain("not found");
  });

  it("loads a top-level <name>/SKILL.md from project", () => {
    writeSkillDir(projectRoot(), "writing-go", "# Writing Go");
    expect(at(preloadSkills(["writing-go"], tmpDir), 0).content).toContain("Writing Go");
  });

  it("loads a top-level <name>/SKILL.md from getAgentDir()/skills", () => {
    writeSkillDir(globalRoot(), "writing-python", "# Writing Python");
    expect(at(preloadSkills(["writing-python"], tmpDir), 0).content).toContain("Writing Python");
  });

  it("loads a flat .md from getAgentDir()/skills", () => {
    writeFlat(globalRoot(), "shell-tips", "use rg");
    expect(at(preloadSkills(["shell-tips"], tmpDir), 0).content).toBe("use rg");
  });

  it("finds nested <subdir>/<name>/SKILL.md in getAgentDir()/skills", () => {
    writeSkillDir(join(globalRoot(), "dev-tools"), "using-modern-cli", "# Modern CLI");
    expect(at(preloadSkills(["using-modern-cli"], tmpDir), 0).content).toContain("Modern CLI");
  });

  it("finds nested <subdir>/<name>/SKILL.md", () => {
    writeSkillDir(join(projectRoot(), "dev-tools"), "using-modern-cli", "# Modern CLI");
    expect(at(preloadSkills(["using-modern-cli"], tmpDir), 0).content).toContain("Modern CLI");
  });

  it("prefers project over global", () => {
    writeSkillDir(projectRoot(), "shared", "from-project");
    writeSkillDir(globalRoot(), "shared", "from-global");
    expect(at(preloadSkills(["shared"], tmpDir), 0).content).toBe("from-project");
  });

  it("prefers shallower match (lex tie-break)", () => {
    // Different depths — shallower wins.
    writeSkillDir(join(projectRoot(), "z-deep", "nested"), "collide", "deep");
    writeSkillDir(join(projectRoot(), "a-shallow"), "collide", "shallow");
    expect(at(preloadSkills(["collide"], tmpDir), 0).content).toBe("shallow");

    // Same depth — alphabetical wins.
    writeSkillDir(join(projectRoot(), "b-sibling"), "tie", "b");
    writeSkillDir(join(projectRoot(), "a-sibling"), "tie", "a");
    expect(at(preloadSkills(["tie"], tmpDir), 0).content).toBe("a");
  });

  it("descends past a same-named dir that lacks SKILL.md to find a deeper match", () => {
    // .pi/skills/foo exists empty; .pi/skills/foo/inner/foo/SKILL.md is the real skill.
    mkdirSync(join(projectRoot(), "foo"), { recursive: true });
    writeSkillDir(join(projectRoot(), "foo", "inner"), "foo", "deeper");
    expect(at(preloadSkills(["foo"], tmpDir), 0).content).toBe("deeper");
  });

  it("does not descend into a sibling skill directory (skills don't nest)", () => {
    // .pi/skills/outer is itself a skill; .pi/skills/outer/target/SKILL.md must NOT be found.
    writeSkillDir(projectRoot(), "outer", "outer-skill");
    writeSkillDir(join(projectRoot(), "outer"), "target", "hidden");
    expect(at(preloadSkills(["target"], tmpDir), 0).content).toContain("not found");
  });

  it("skips node_modules during recursion", () => {
    writeSkillDir(join(projectRoot(), "node_modules", "some-pkg"), "leaked", "should not load");
    expect(at(preloadSkills(["leaked"], tmpDir), 0).content).toContain("not found");
  });

  it("skips dotfile directories during recursion", () => {
    writeSkillDir(join(projectRoot(), ".hidden-tree"), "buried", "should not load");
    expect(at(preloadSkills(["buried"], tmpDir), 0).content).toContain("not found");
  });

  it("returns fallback for missing skills", () => {
    const result = preloadSkills(["nonexistent"], tmpDir);
    expect(at(result, 0).name).toBe("nonexistent");
    expect(at(result, 0).content).toContain("not found");
  });

  it("loads multiple skills", () => {
    writeFlat(projectRoot(), "a", "Content A");
    writeSkillDir(projectRoot(), "b", "Content B");
    const result = preloadSkills(["a", "b"], tmpDir);
    expect(result.map((r) => r.content)).toEqual([
      "Content A",
      expect.stringContaining("Content B"),
    ]);
  });

  it("skips skill names with path traversal (..)", () => {
    expect(at(preloadSkills(["../../etc/passwd"], tmpDir), 0).content).toContain("path traversal");
  });

  it("skips skill names with forward slash", () => {
    expect(at(preloadSkills(["sub/dir"], tmpDir), 0).content).toContain("path traversal");
  });

  it("skips skill names with backslash", () => {
    expect(at(preloadSkills(["sub\\dir"], tmpDir), 0).content).toContain("path traversal");
  });

  it("skips skill names with spaces", () => {
    expect(at(preloadSkills(["my skill"], tmpDir), 0).content).toContain("path traversal");
  });

  it("skips skill names starting with a dot", () => {
    expect(at(preloadSkills([".hidden"], tmpDir), 0).content).toContain("path traversal");
  });

  it("skips empty skill names", () => {
    expect(at(preloadSkills([""], tmpDir), 0).content).toContain("path traversal");
  });

  it("skips skill names exceeding 128 characters", () => {
    const longName = "a".repeat(129);
    expect(at(preloadSkills([longName], tmpDir), 0).content).toContain("path traversal");
  });

  it("loads valid skills alongside skipped unsafe ones", () => {
    writeFlat(projectRoot(), "legit", "Good content");
    const result = preloadSkills(["../evil", "legit"], tmpDir);
    expect(at(result, 0).content).toContain("path traversal");
    expect(at(result, 1).content).toBe("Good content");
  });

  it("rejects symlinked flat .md files", () => {
    mkdirSync(projectRoot(), { recursive: true });
    const secret = join(tmpDir, "secret.md");
    writeFileSync(secret, "TOP SECRET");
    symlinkSync(secret, join(projectRoot(), "evil.md"));
    const result = preloadSkills(["evil"], tmpDir);
    expect(at(result, 0).content).toContain("not found");
    expect(at(result, 0).content).not.toContain("TOP SECRET");
  });

  it("rejects symlinked skill directories", () => {
    mkdirSync(projectRoot(), { recursive: true });
    const realDir = join(tmpDir, "real-skill");
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "SKILL.md"), "TOP SECRET");
    symlinkSync(realDir, join(projectRoot(), "evil-dir"));
    const result = preloadSkills(["evil-dir"], tmpDir);
    expect(at(result, 0).content).toContain("not found");
    expect(at(result, 0).content).not.toContain("TOP SECRET");
  });

  it("rejects symlinked skill root", () => {
    // <cwd>/.agents/skills → symlink to a directory that holds real-looking skills.
    const realRoot = join(tmpDir, "elsewhere");
    mkdirSync(realRoot, { recursive: true });
    writeFileSync(join(realRoot, "leaked-flat.md"), "TOP SECRET FLAT");
    mkdirSync(join(realRoot, "leaked-dir"), { recursive: true });
    writeFileSync(join(realRoot, "leaked-dir", "SKILL.md"), "TOP SECRET DIR");
    mkdirSync(join(tmpDir, ".agents"), { recursive: true });
    symlinkSync(realRoot, projectRoot());

    const flatResult = at(preloadSkills(["leaked-flat"], tmpDir), 0).content;
    expect(flatResult).toContain("not found");
    expect(flatResult).not.toContain("TOP SECRET");

    const dirResult = at(preloadSkills(["leaked-dir"], tmpDir), 0).content;
    expect(dirResult).toContain("not found");
    expect(dirResult).not.toContain("TOP SECRET");
  });

  it("rejects symlinked SKILL.md inside a real skill directory", () => {
    const skillDir = join(projectRoot(), "evil-inner");
    mkdirSync(skillDir, { recursive: true });
    const secret = join(tmpDir, "secret.md");
    writeFileSync(secret, "TOP SECRET");
    symlinkSync(secret, join(skillDir, "SKILL.md"));
    const result = preloadSkills(["evil-inner"], tmpDir);
    expect(at(result, 0).content).toContain("not found");
    expect(at(result, 0).content).not.toContain("TOP SECRET");
  });
});
