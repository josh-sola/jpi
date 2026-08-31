import type { BuildSystemPromptOptions, Skill } from "@earendil-works/pi-coding-agent";

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/**
 * One line per tool pi actually surfaced a snippet for, matching the tool
 * set stock pi's own "Available tools" list is built from.
 */
export function buildToolList(
  options: Pick<BuildSystemPromptOptions, "selectedTools" | "toolSnippets">,
): string {
  const tools = options.selectedTools ?? DEFAULT_TOOLS;
  const snippets = options.toolSnippets ?? {};
  return tools
    .filter((name) => !!snippets[name])
    .map((name) => `- ${name}: ${snippets[name]}`)
    .join("\n");
}

export function buildGuidelines(
  options: Pick<BuildSystemPromptOptions, "promptGuidelines">,
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const guideline of options.promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    lines.push(`- ${normalized}`);
  }
  return lines.join("\n");
}

export type PiDocsPaths = {
  readmePath: string;
  docsPath: string;
  examplesPath: string;
};

/**
 * Reproduces stock pi's "Pi documentation" block verbatim so the agent's
 * self-documentation pointers survive a custom system prompt.
 */
export function buildPiDocsBlock(paths: PiDocsPaths): string {
  return `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${paths.readmePath}
- Additional docs: ${paths.docsPath}
- Examples: ${paths.examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
}

export type EnvironmentParams = {
  cwd: string;
  isGitRepo: boolean;
  platform: string;
  osRelease: string;
  today: string;
};

export function buildEnvironment(params: EnvironmentParams): string {
  return [
    `Working directory: ${params.cwd}`,
    `Is git repo: ${params.isGitRepo ? "yes" : "no"}`,
    `Platform: ${params.platform}`,
    `OS version: ${params.osRelease}`,
    `Today's date: ${params.today}`,
  ].join("\n");
}

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
