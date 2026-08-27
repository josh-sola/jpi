import type { BuildSystemPromptOptions, Skill } from "@earendil-works/pi-coding-agent";

/**
 * Reproduces the `customPrompt` branch of pi's own `buildSystemPrompt`
 * (dist/core/system-prompt.js), which is not exported through the package's
 * public entry point. Keep this in sync with that branch: appended system
 * prompt text, the `<project_context>` block, the skills section, and the
 * trailing "Current working directory" line, in that order.
 */
export function appendPiTail(
  renderedPrompt: string,
  options: Pick<
    BuildSystemPromptOptions,
    "appendSystemPrompt" | "contextFiles" | "skills" | "selectedTools" | "cwd"
  >,
  formatSkillsForPrompt: (skills: Skill[]) => string,
): string {
  let prompt = renderedPrompt;

  if (options.appendSystemPrompt) {
    prompt += `\n\n${options.appendSystemPrompt}`;
  }

  const contextFiles = options.contextFiles ?? [];
  if (contextFiles.length > 0) {
    prompt += "\n\n<project_context>\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    for (const { path: filePath, content } of contextFiles) {
      prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
    }
    prompt += "</project_context>\n";
  }

  const skills = options.skills ?? [];
  const hasRead = !options.selectedTools || options.selectedTools.includes("read");
  if (hasRead && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills);
  }

  const promptCwd = options.cwd.replace(/\\/g, "/");
  prompt += `\nCurrent working directory: ${promptCwd}`;

  return prompt;
}
