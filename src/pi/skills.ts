/**
 * skills.ts — Pi's skill-discovery layout: the 4 discovery roots (project,
 * user, cross-tool, legacy — in precedence order) and the `<name>/SKILL.md`
 * layout rule, including "skills don't nest" (a directory that itself
 * contains SKILL.md is a skill; discovery doesn't descend into it).
 *
 * Roots, in precedence order:
 *   - <cwd>/.agents/skills       (project, cross-tool Agent Skills spec — https://agentskills.io)
 *   - getAgentDir()/skills       (user, default ~/.pi/agent/skills — Pi's standard)
 *   - ~/.agents/skills           (user, cross-tool Agent Skills spec)
 *   - ~/.pi/skills               (legacy global, pre-Pi)
 *
 * Layout per root:
 *   - <root>/<name>.md            (flat file at the top level)
 *   - <root>/.../<name>/SKILL.md  (directory skill, may be nested — Pi's standard)
 *
 * Recursion skips dotfile entries and node_modules. A directory that itself
 * contains SKILL.md is a skill — we don't descend into it (Pi: skills don't
 * nest).
 *
 * Deliberately deviates from Pi in one place: this REJECTS symlinks (roots,
 * flat .md files, and SKILL.md files) as a defense against symlink attacks
 * that read outside the discovery roots. Pi itself follows them.
 */

import type { Dirent } from "node:fs";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** Discovery roots, in precedence order. */
export function skillDiscoveryRoots(cwd: string, agentDir: string = getAgentDir()): string[] {
  return [
    join(cwd, ".agents", "skills"), // project — Agent Skills spec
    join(agentDir, "skills"), // user — Pi standard
    join(homedir(), ".agents", "skills"), // user — Agent Skills spec
    join(homedir(), ".pi", "skills"), // legacy global, pre-Pi
  ];
}

function isSymlink(filePath: string): boolean {
  try {
    return lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Reads a file, rejecting symlinks — the deviation from Pi's own behavior (see module doc). */
function safeReadFile(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined;
  if (isSymlink(filePath)) return undefined;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }
}

/** Finds `name`'s skill content under a single discovery root, or undefined. */
export function findSkillInRoot(root: string, name: string): string | undefined {
  if (isSymlink(root)) return undefined; // reject symlinked roots entirely
  const flat = safeReadFile(join(root, `${name}.md`))?.trim();
  if (flat !== undefined) return flat;
  return findSkillDirectory(root, name);
}

/** BFS under `root` for a directory named `name` containing `SKILL.md`. Pi-conforming filters. */
function findSkillDirectory(root: string, name: string): string | undefined {
  if (!existsSync(root)) return undefined;
  const queue: string[] = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;

    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    // Deterministic byte-order traversal — locale-independent.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      // Symlinked dirs already filtered by entry.isDirectory() — Dirent uses lstat semantics.
      const path = join(current, entry.name);
      const skillMd = join(path, "SKILL.md");
      const isSkillDir = existsSync(skillMd);

      if (isSkillDir) {
        if (entry.name === name) {
          const content = safeReadFile(skillMd)?.trim();
          if (content !== undefined) return content;
        }
        continue; // Pi rule: skills don't nest — don't descend into a skill dir
      }

      queue.push(path);
    }
  }
  return undefined;
}
