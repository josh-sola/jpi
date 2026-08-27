import { projectSlug, Store } from "../../src/core/index.ts";

export { projectSlug };

export function getMemoryDirectory(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory?: string,
): string {
  return new Store("memories", env, homeDirectory).path(projectSlug(cwd));
}
