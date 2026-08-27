import { execFileSync } from "node:child_process";
import path from "node:path";

// Matches Claude Code's ~/.claude/projects/-Users-... naming so a leading "/"
// becomes a leading "-" rather than being dropped. Every other character
// outside Store's allowed name set is also dashed, so the slug is always a
// valid Store path segment.
//
// Inside a git repo, the slug is derived from the main worktree root, not the
// raw cwd, so linked worktrees and subdirectories of one clone share state.
// Git calls are cached per cwd since callers may re-resolve on every render.
const slugCache = new Map<string, string>();

function resolveProjectRoot(cwd: string): string {
  try {
    const gitCommonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    ).trim();
    if (path.basename(gitCommonDir) === ".git") {
      return path.dirname(gitCommonDir);
    }
  } catch {
    // Not a repo, nonexistent cwd, git missing, etc. — fall through to raw cwd.
  }
  return cwd;
}

function sanitize(raw: string): string {
  return raw.replace(/\//g, "-").replace(/[^A-Za-z0-9._-]/g, "-");
}

export function projectSlug(cwd: string): string {
  const cached = slugCache.get(cwd);
  if (cached !== undefined) return cached;

  const slug = sanitize(resolveProjectRoot(cwd));
  slugCache.set(cwd, slug);
  return slug;
}
