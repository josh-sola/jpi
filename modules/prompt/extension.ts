import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { release } from "node:os";
import { join } from "node:path";

import type { BuildSystemPromptOptions, Skill } from "@earendil-works/pi-coding-agent";

import { getDefaultTemplatePath, getSystemPromptPath } from "./paths.ts";
import { seedIfMissing } from "./seed.ts";
import { appendPiTail } from "./system-prompt-tail.ts";
import { interpolate } from "./template.ts";
import {
  buildEnvironment,
  buildGuidelines,
  buildPiDocsBlock,
  buildToolList,
  type PiDocsPaths,
} from "./variables.ts";

type NotifyLevel = "info" | "warning" | "error";

export type BeforeAgentStartEvent = {
  systemPrompt: string;
  systemPromptOptions: BuildSystemPromptOptions;
};

export type BeforeAgentStartContext = {
  ui: {
    notify(message: string, level?: NotifyLevel): void;
  };
};

export type PromptExtension = {
  onBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: BeforeAgentStartContext,
  ): Promise<{ systemPrompt: string }>;
};

export type PromptExtensionDeps = {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  formatSkillsForPrompt: (skills: Skill[]) => string;
  getPiDocsPaths: () => PiDocsPaths;
  now?: () => Date;
};

export function createPromptExtension(deps: PromptExtensionDeps): PromptExtension {
  const templatePath = getSystemPromptPath(deps.env, deps.homeDirectory);
  const defaultTemplatePath = getDefaultTemplatePath();
  const now = deps.now ?? (() => new Date());

  return {
    async onBeforeAgentStart(event, ctx) {
      try {
        const defaultContent = await readFile(defaultTemplatePath, "utf8");
        await seedIfMissing(templatePath, defaultContent);

        const template = await readFile(templatePath, "utf8");
        const options = event.systemPromptOptions;

        const variables: Record<string, string> = {
          TOOL_LIST: buildToolList(options),
          GUIDELINES: buildGuidelines(options),
          PI_DOCS: buildPiDocsBlock(deps.getPiDocsPaths()),
          ENVIRONMENT: buildEnvironment({
            cwd: options.cwd,
            isGitRepo: existsSync(join(options.cwd, ".git")),
            platform: process.platform,
            osRelease: release(),
            today: now().toISOString().slice(0, 10),
          }),
        };

        const rendered = interpolate(template, variables);
        const systemPrompt = appendPiTail(rendered, options, deps.formatSkillsForPrompt);

        return { systemPrompt };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(
          `jpi-prompt: failed to render ${templatePath} (${message}); using the stock system prompt.`,
          "warning",
        );
        return { systemPrompt: event.systemPrompt };
      }
    },
  };
}
