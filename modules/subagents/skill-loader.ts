/**
 * skill-loader.ts — Preload named skills.
 *
 * Discovery layout (roots, `<name>/SKILL.md` rule, "skills don't nest",
 * symlink rejection) lives in `src/pi/skills.ts` — pi's own skill-discovery
 * conventions, mirrored there since pi doesn't export a lookup. This module
 * owns the jpi-specific part: resolving a name to a not-found message when
 * nothing matches, for embedding into an agent's prompt.
 */

import { findSkillInRoot, skillDiscoveryRoots } from "../../src/pi/index.ts";
import { isUnsafeName } from "./fs-safety.ts";

export interface PreloadedSkill {
  name: string;
  content: string;
}

export function preloadSkills(skillNames: string[], cwd: string): PreloadedSkill[] {
  return skillNames.map((name) => ({ name, content: loadSkillContent(name, cwd) }));
}

function loadSkillContent(name: string, cwd: string): string {
  if (isUnsafeName(name)) {
    return `(Skill "${name}" skipped: name contains path traversal characters)`;
  }
  for (const root of skillDiscoveryRoots(cwd)) {
    const content = findSkillInRoot(root, name);
    if (content !== undefined) return content;
  }
  return `(Skill "${name}" not found in .agents/skills/ or global skill locations)`;
}
