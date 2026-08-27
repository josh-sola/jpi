import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { errorMessage, getAgentDirectory, seedIfMissing } from "../../src/core/index.ts";

import { REVIEW_POLICY } from "./policy.ts";

export const GUARDIAN_PROMPT_FILENAME = "GUARDIAN.md";

export function getGuardianPromptPath(env?: NodeJS.ProcessEnv, homeDirectory?: string): string {
  return join(getAgentDirectory(env, homeDirectory), GUARDIAN_PROMPT_FILENAME);
}

export function buildSystemPrompt(basePrompt: string, policy: string[]): string {
  if (policy.length === 0) return basePrompt;
  return `${basePrompt}\n\nAdditional trusted reviewer instructions:\n${policy.map((line) => `- ${line}`).join("\n")}`;
}

export type PromptNotifier = (message: string, level: "warning") => void;

// Re-seeding here (on top of the session-start seed) means a file deleted
// mid-session comes back before the next review reads it.
export async function loadGuardianPromptBase(
  promptPath: string,
  notify?: PromptNotifier,
): Promise<string> {
  try {
    await seedIfMissing(promptPath, REVIEW_POLICY);
    return await readFile(promptPath, "utf8");
  } catch (err) {
    const message = errorMessage(err);
    notify?.(
      `Guardian: failed to load ${promptPath} (${message}); using the built-in review policy.`,
      "warning",
    );
    return REVIEW_POLICY;
  }
}
