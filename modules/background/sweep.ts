import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/** A pid is alive unless killing it with signal 0 confirms ESRCH; EPERM (owned by another user) still counts as alive. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isErrnoException(error) && error.code === "ESRCH");
  }
}

function parseTrailingPid(dirName: string): number | undefined {
  const match = /-(\d+)$/.exec(dirName);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Deletes session dirs under `root` (two levels down: `<projectSlug>/<session>-<pid>`)
 * whose mtime is older than `ttlDays` AND whose trailing `-<pid>` names a process
 * that is no longer alive. `keepDir` (the current session's own dir) is always left
 * alone, and a dir whose name carries no parsable pid is left alone too. Every fs
 * error is swallowed — this cleanup must never break a session.
 */
export async function sweepStaleSessions(
  root: string,
  ttlDays: number,
  now: number,
  keepDir: string,
  isAlive: (pid: number) => boolean = isPidAlive,
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

      const pid = parseTrailingPid(sessionName);
      if (pid === undefined) continue;

      try {
        const sessionStat = await stat(sessionDir);
        if (!sessionStat.isDirectory()) continue;
        if (now - sessionStat.mtimeMs <= ttlMs) continue;
        if (isAlive(pid)) continue;
        await rm(sessionDir, { recursive: true, force: true });
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
