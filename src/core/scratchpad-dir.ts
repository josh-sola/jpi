import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectSlug } from "./project-slug.ts";

// The root carries the uid because /tmp is world-shared on Linux; a fixed
// name would collide across users. macOS tmpdir() is already per-user.
export function scratchpadRoot(tempRoot: string = tmpdir()): string {
  const uid = process.getuid?.() ?? "user";
  return join(tempRoot, `jpi-scratchpad-${uid}`);
}

export function scratchpadDir(cwd: string, sessionId: string, tempRoot?: string): string {
  const sanitized = sessionId.replace(/[^A-Za-z0-9._-]/g, "-");
  const session =
    sanitized === "" || sanitized === "." || sanitized === ".." ? "session" : sanitized;
  return join(scratchpadRoot(tempRoot), projectSlug(cwd), session);
}
