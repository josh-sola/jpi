import { mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

export function buildScratchpadSection(dir: string): string {
  return `# Scratchpad Directory

IMPORTANT: Always use this scratchpad directory for temporary files instead of \`/tmp\` or other system temp directories:
\`${dir}\`

Use this directory for ALL temporary file needs:
- Storing intermediate results or data during multi-step tasks
- Writing temporary scripts or configuration files
- Saving outputs that don't belong in the user's project
- Creating working files during analysis or processing
- Any file that would otherwise go to \`/tmp\`

Only use \`/tmp\` if the user explicitly requests it.

The scratchpad directory is session-specific, isolated from the user's project, and can generally be used without review prompts.`;
}

export async function ensureScratchpadDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Deletes session dirs under `root` (two levels down: `<slug>/<session>`)
 * whose mtime is older than `ttlDays`, skipping `keepDir`. Every fs error is
 * swallowed — this cleanup must never break a session — and stray entries
 * that aren't directories (a rogue plain file, a missing root) are ignored
 * rather than treated as errors.
 */
export async function sweepStale(
  root: string,
  ttlDays: number,
  now: number,
  keepDir: string,
): Promise<void> {
  const ttlMs = ttlDays * DAY_MS;

  let slugNames: string[];
  try {
    slugNames = await readdir(root);
  } catch {
    return;
  }

  for (const slugName of slugNames) {
    const slugDir = join(root, slugName);

    try {
      if (!(await stat(slugDir)).isDirectory()) continue;
    } catch {
      continue;
    }

    let sessionNames: string[];
    try {
      sessionNames = await readdir(slugDir);
    } catch {
      continue;
    }

    for (const sessionName of sessionNames) {
      const sessionDir = join(slugDir, sessionName);
      if (sessionDir === keepDir) continue;

      try {
        const sessionStat = await stat(sessionDir);
        if (!sessionStat.isDirectory()) continue;
        if (now - sessionStat.mtimeMs > ttlMs) {
          await rm(sessionDir, { recursive: true, force: true });
        }
      } catch {
        // Swallow: cleanup must never break a session.
      }
    }

    try {
      await rmdir(slugDir);
    } catch {
      // Not empty, or already gone — leave it for the next sweep.
    }
  }
}
