import { join } from "node:path";

import { memoriesRoot, projectSlug } from "../../src/core/index.ts";

export { projectSlug };

export function getMemoryDirectory(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory?: string,
): string {
  return join(memoriesRoot(env, homeDirectory), projectSlug(cwd));
}
