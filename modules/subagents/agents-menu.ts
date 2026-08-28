/**
 * agents-menu.ts — the `/agents` interactive menu: running agents, the agent
 * type list and detail view, the create wizard, and settings.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  type ExtensionCommandContext,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { isTopLevelAgent } from "./agent-manager.ts";
import {
  buildNewAgentFile,
  disableInContent,
  enableInContent,
  isEmptyStub,
  locateAgentFile,
  personalAgentsDir,
  serializeAgentFile,
} from "./agent-file-toggle.ts";
import {
  getDefaultMaxTurns,
  getGraceTurns,
  getRememberAgents,
  setDefaultMaxTurns,
  setGraceTurns,
  setRememberAgents,
} from "./agent-runner.ts";
import { getModelLabelFromConfig, THINKING_LEVELS } from "./agent-tool.ts";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getAllTypes,
  getAvailableTypes,
  isDefaultsDisabled,
  getFallbackSubagent,
  NO_FALLBACK,
  setFallbackSubagent,
} from "./agent-types.ts";
import type { SubagentsRuntime } from "./index.ts";
import { getOutputTranscriptDefault, setOutputTranscriptDefault } from "./output-file.ts";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "./nested-tools.ts";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "./model-scope.ts";
import { type ModelRegistry, resolveModel } from "./model-resolver.ts";
import { selectItem } from "./ui/select-item.ts";
import type {
  AgentConfig,
  AgentMentionMode,
  AgentRecord,
  JoinMode,
  ViewerMarkdownMode,
  WidgetMode,
} from "./types.ts";
import type { ToolDescriptionMode } from "./settings.ts";
import { formatDuration, getDisplayName } from "./ui/agent-widget.ts";
import { isWorktreeIsolationEnabled, setWorktreeIsolationEnabled } from "./worktree.ts";

function getModelLabel(rt: SubagentsRuntime, type: string, registry?: ModelRegistry): string {
  const cfg = getAgentConfig(type);
  if (!cfg?.model) return "inherit"; // no model configured → really inherits parent
  const label = getModelLabelFromConfig(cfg.model);
  if (!registry) return label;
  const resolved = resolveModel(cfg.model, registry);
  // Configured but unresolvable: the runtime silently falls back to the parent
  // model, so flag it (and the fallback) rather than hiding the config.
  if (typeof resolved === "string") return `${label} (unavailable, fallback: inherit)`;
  // Surface what it actually resolved to when that differs from the config —
  // e.g. a provider fallback or a looser version pin. Cosmetic separator/date
  // differences are normalized away so an effectively-identical match stays quiet.
  const resolvedFull = `${resolved.provider}/${resolved.id}`;
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\./g, "-")
      .replace(/-\d{8}$/, "");
  if (norm(cfg.model) === norm(resolvedFull)) return label;
  return `${label} (→ ${resolvedFull.replace(/-\d{8}$/, "")})`;
}

async function showAgentsMenu(rt: SubagentsRuntime, ctx: ExtensionCommandContext) {
  rt.reloadCustomAgents();
  const allNames = getAllTypes();

  // Build select options
  const options: string[] = [];

  // Running agents entry (only if there are active agents)
  const agents = rt.manager.listAgents().filter(isTopLevelAgent);
  if (agents.length > 0) {
    const running = agents.filter((a) => a.status === "running" || a.status === "queued").length;
    const done = agents.filter((a) => a.status === "completed" || a.status === "steered").length;
    options.push(`Running agents (${agents.length}) — ${running} running, ${done} done`);
  }

  // Agent types list
  if (allNames.length > 0) {
    options.push(`Agent types (${allNames.length})`);
  }

  // Actions
  options.push("Create new agent");
  options.push("Settings");

  const noAgentsMsg =
    allNames.length === 0 && agents.length === 0
      ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
        "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
        "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
      : "";

  if (noAgentsMsg) {
    ctx.ui.notify(noAgentsMsg, "info");
  }

  const choice = await ctx.ui.select("Agents", options);
  if (!choice) return;

  if (choice.startsWith("Running agents (")) {
    await showRunningAgents(rt, ctx);
    await showAgentsMenu(rt, ctx);
  } else if (choice.startsWith("Agent types (")) {
    await showAllAgentsList(rt, ctx);
    await showAgentsMenu(rt, ctx);
  } else if (choice === "Create new agent") {
    await showCreateWizard(rt, ctx);
  } else if (choice === "Settings") {
    await showSettings(rt, ctx);
    await showAgentsMenu(rt, ctx);
  }
}

async function showAllAgentsList(rt: SubagentsRuntime, ctx: ExtensionCommandContext) {
  const allNames = getAllTypes();
  if (allNames.length === 0) {
    ctx.ui.notify("No agents.", "info");
    return;
  }

  // Source indicators: defaults unmarked, custom agents get • (project) or ◦ (global)
  // Disabled agents get ✕ prefix
  const sourceIndicator = (cfg: AgentConfig | undefined) => {
    const disabled = cfg?.enabled === false;
    if (cfg?.source === "project") return disabled ? "✕• " : "•  ";
    if (cfg?.source === "global") return disabled ? "✕◦ " : "◦  ";
    if (disabled) return "✕  ";
    return "   ";
  };

  // One row per agent (name in the left column, model on the right); the
  // full description renders below the highlighted row via SettingsList,
  // exactly like the Settings menu — so long descriptions never wrap the list.
  const items: SettingItem[] = allNames.map((name) => {
    const cfg = getAgentConfig(name);
    const disabled = cfg?.enabled === false;
    const model = getModelLabel(rt, name, ctx.modelRegistry);
    return {
      id: name,
      label: `${sourceIndicator(cfg)}${name}`,
      currentValue: model,
      description: disabled ? "(disabled)" : (cfg?.description ?? name),
      // Single-value list so Enter "activates" the row (fires onChange with the
      // agent's id) without offering anything to actually cycle.
      values: [model],
    };
  });

  const hasCustom = allNames.some((n) => {
    const c = getAgentConfig(n);
    return c && !c.isDefault && c.enabled !== false;
  });
  const hasDisabled = allNames.some((n) => getAgentConfig(n)?.enabled === false);
  const legendParts: string[] = [];
  if (hasCustom) legendParts.push("• = project  ◦ = global");
  if (hasDisabled) legendParts.push("✕ = disabled");

  const selected = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
    const slTheme = getSettingsListTheme();
    const list = new SettingsList(
      items,
      Math.min(items.length, 12),
      slTheme,
      (id) => done(id), // Enter/Space on a row → return that agent's name
      () => done(undefined), // Esc → cancel
    );
    const container = new Container();
    container.addChild(new Text("Agent types", 0, 0));
    if (legendParts.length)
      container.addChild(new Text(slTheme.hint(legendParts.join("  ")), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => list.handleInput?.(data),
    };
  });

  if (selected && getAgentConfig(selected)) {
    await showAgentDetail(rt, ctx, selected);
    await showAllAgentsList(rt, ctx);
  }
}

async function showRunningAgents(rt: SubagentsRuntime, ctx: ExtensionCommandContext) {
  const agents = rt.manager.listAgents().filter(isTopLevelAgent);
  if (agents.length === 0) {
    ctx.ui.notify("No agents.", "info");
    return;
  }

  // Numbered + item-paired. Two same-type agents spawned together with the
  // same description render identically here, and resolving the choice by
  // string match would open whichever came first.
  const record = await selectItem(ctx.ui, "Running agents", agents, (a) => {
    const dn = getDisplayName(a.type);
    const dur = formatDuration(a.startedAt, a.completedAt);
    return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
  });
  if (!record) return;

  await viewAgentConversation(rt, ctx, record);
  // Back-navigation: re-show the list
  await showRunningAgents(rt, ctx);
}

async function viewAgentConversation(
  rt: SubagentsRuntime,
  ctx: ExtensionCommandContext,
  record: AgentRecord,
) {
  if (!record.session) {
    ctx.ui.notify(
      `Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`,
      "info",
    );
    return;
  }

  const { ConversationViewer, VIEWPORT_HEIGHT_PCT } = await import("./ui/conversation-viewer.ts");
  const session = record.session;
  const activity = rt.agentActivity.get(record.id);

  await ctx.ui.custom<undefined>(
    (tui, theme, keybindings, done) => {
      return new ConversationViewer(
        tui,
        session,
        record,
        activity,
        theme,
        done,
        () => {
          if (rt.manager.abort(record.id)) {
            ctx.ui.notify(`Stopped "${record.description}".`, "info");
          }
        },
        keybindings,
        (message: string) => rt.manager.steer(record.id, message),
        rt.isShowCostEnabled(),
        rt.getViewerMarkdown,
        (mode) => rt.chooseViewerMarkdown(mode, ctx),
      );
    },
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` },
    },
  );
}

async function showAgentDetail(rt: SubagentsRuntime, ctx: ExtensionCommandContext, name: string) {
  const cfg = getAgentConfig(name);
  if (!cfg) {
    ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
    return;
  }

  const file = locateAgentFile(name, cfg.sourcePath);
  const isDefault = cfg.isDefault === true;
  const disabled = cfg.enabled === false;

  let menuOptions: string[];
  if (disabled && file) {
    // Disabled agent with a file — offer Enable
    menuOptions = isDefault
      ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
      : ["Enable", "Edit", "Delete", "Back"];
  } else if (isDefault && !file) {
    // Default agent with no .md override
    menuOptions = ["Eject (export as .md)", "Disable", "Back"];
  } else if (isDefault && file) {
    // Default agent with .md override (ejected)
    menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
  } else {
    // User-defined agent
    menuOptions = ["Edit", "Disable", "Delete", "Back"];
  }

  const choice = await ctx.ui.select(name, menuOptions);
  if (!choice || choice === "Back") return;

  if (choice === "Edit" && file) {
    const content = readFileSync(file.path, "utf-8");
    const edited = await ctx.ui.editor(`Edit ${name}`, content);
    if (edited !== undefined && edited !== content) {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file.path, edited, "utf-8");
      rt.reloadCustomAgents();
      ctx.ui.notify(`Updated ${file.path}`, "info");
    }
  } else if (choice === "Delete") {
    if (file) {
      const confirmed = await ctx.ui.confirm(
        "Delete agent",
        `Delete ${name} from ${file.location} (${file.path})?`,
      );
      if (confirmed) {
        unlinkSync(file.path);
        rt.reloadCustomAgents();
        ctx.ui.notify(`Deleted ${file.path}`, "info");
      }
    }
  } else if (choice === "Reset to default" && file) {
    const confirmed = await ctx.ui.confirm(
      "Reset to default",
      `Delete override ${file.path} and restore embedded default?`,
    );
    if (confirmed) {
      unlinkSync(file.path);
      rt.reloadCustomAgents();
      ctx.ui.notify(`Restored default ${name}`, "info");
    }
  } else if (choice.startsWith("Eject")) {
    await ejectAgent(rt, ctx, name, cfg);
  } else if (choice === "Disable") {
    await disableAgent(rt, ctx, name);
  } else if (choice === "Enable") {
    await enableAgent(rt, ctx, name);
  }
}

/** Eject a default agent: write its embedded config as a .md file. */
async function ejectAgent(
  rt: SubagentsRuntime,
  ctx: ExtensionCommandContext,
  name: string,
  cfg: AgentConfig,
) {
  const targetDir = personalAgentsDir();
  mkdirSync(targetDir, { recursive: true });

  const targetPath = join(targetDir, `${name}.md`);
  if (existsSync(targetPath)) {
    const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
    if (!overwrite) return;
  }

  const content = serializeAgentFile(cfg);

  const { writeFileSync } = await import("node:fs");
  writeFileSync(targetPath, content, "utf-8");
  rt.reloadCustomAgents();
  ctx.ui.notify(`Ejected ${name} to ${targetPath}`, "info");
}

/** Disable an agent: set enabled: false in its .md file, or create a stub for built-in defaults. */
async function disableAgent(rt: SubagentsRuntime, ctx: ExtensionCommandContext, name: string) {
  const file = locateAgentFile(name, getAgentConfig(name)?.sourcePath);
  if (file) {
    // Existing file — set enabled: false in frontmatter (idempotent)
    const content = readFileSync(file.path, "utf-8");
    const { content: updated, outcome } = disableInContent(content);
    if (outcome === "already-disabled") {
      ctx.ui.notify(`${name} is already disabled.`, "info");
      return;
    }
    if (outcome === "no-frontmatter") {
      // Nothing to edit — say so rather than rewriting the file unchanged and
      // reporting success for a change that never happened.
      ctx.ui.notify(`Cannot disable ${name}: ${file.path} has no frontmatter block.`, "error");
      return;
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file.path, updated, "utf-8");
    rt.reloadCustomAgents();
    ctx.ui.notify(`Disabled ${name} (${file.path})`, "info");
    return;
  }

  // No file (built-in default) — create a stub
  const targetDir = personalAgentsDir();
  mkdirSync(targetDir, { recursive: true });

  const targetPath = join(targetDir, `${name}.md`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(targetPath, "---\nenabled: false\n---\n", "utf-8");
  rt.reloadCustomAgents();
  ctx.ui.notify(`Disabled ${name} (${targetPath})`, "info");
}

/** Enable a disabled agent by removing enabled: false from its frontmatter. */
async function enableAgent(rt: SubagentsRuntime, ctx: ExtensionCommandContext, name: string) {
  const file = locateAgentFile(name, getAgentConfig(name)?.sourcePath);
  if (!file) return;

  const content = readFileSync(file.path, "utf-8");
  const { content: updated, changed } = enableInContent(content);
  if (!changed && !isEmptyStub(updated)) {
    // The file carries no `enabled: false` to remove, so it was never disabled
    // by us — reporting success here would hide a no-op.
    ctx.ui.notify(`${name} is not disabled in ${file.path}.`, "info");
    return;
  }
  const { writeFileSync } = await import("node:fs");

  // If the file was just a stub ("---\n---\n"), delete it to restore the built-in default
  if (isEmptyStub(updated)) {
    unlinkSync(file.path);
    rt.reloadCustomAgents();
    ctx.ui.notify(`Enabled ${name} (removed ${file.path})`, "info");
  } else {
    writeFileSync(file.path, updated, "utf-8");
    rt.reloadCustomAgents();
    ctx.ui.notify(`Enabled ${name} (${file.path})`, "info");
  }
}

async function showCreateWizard(rt: SubagentsRuntime, ctx: ExtensionCommandContext) {
  const targetDir = personalAgentsDir();

  const method = await ctx.ui.select("Creation method", [
    "Generate with Claude (recommended)",
    "Manual configuration",
  ]);
  if (!method) return;

  if (method.startsWith("Generate")) {
    await showGenerateWizard(rt, ctx, targetDir);
  } else {
    await showManualWizard(rt, ctx, targetDir);
  }
}

async function showGenerateWizard(
  rt: SubagentsRuntime,
  ctx: ExtensionCommandContext,
  targetDir: string,
) {
  const description = await ctx.ui.input("Describe what this agent should do");
  if (!description) return;

  const name = await ctx.ui.input("Agent name (filename, no spaces)");
  if (!name) return;

  mkdirSync(targetDir, { recursive: true });

  const targetPath = join(targetDir, `${name}.md`);
  if (existsSync(targetPath)) {
    const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
    if (!overwrite) return;
  }

  ctx.ui.notify("Generating agent definition...", "info");

  const generatePrompt = `Create a custom pi sub-agent definition file based on this description: "${description}"

Write a markdown file to: ${targetPath}

The file format is a markdown file with YAML frontmatter and a system prompt body:

\`\`\`markdown
---
description: <one-line description shown in UI>
color: <optional agent name badge color: red, blue, green, yellow, purple, orange, pink, cyan, an Agency Agents alias, or quoted "#RRGGBB">
tools: <comma-separated built-in tools: read, bash, edit, write, grep, find, ls. Use "none" for no tools. Omit for all tools>
model: <optional model as "provider/modelId", e.g. "anthropic/claude-haiku-4-5". Omit to inherit parent model>
thinking: <optional thinking level: ${THINKING_LEVELS.join(", ")}. Omit to inherit>
max_turns: <optional max agentic turns. 0 or omit for unlimited (default)>
prompt_mode: <"replace" (body IS the full system prompt) or "append" (body is appended to default prompt). Default: replace>
extensions: <true (inherit all MCP/extension tools), false (none), or comma-separated names. Default: true>
skills: <true (inherit all), false (none), or comma-separated skill names to preload into prompt. Default: true>
disallowed_tools: <comma-separated tool names to block, even if otherwise available. Omit for none>
inherit_context: <true to fork parent conversation into agent so it sees chat history. Default: false>
run_in_background: <pin this agent to background (true) or foreground (false). Omit to follow the backgroundByDefault setting, which is background>
output_transcript: <false to write no transcript file or path for this agent. Independent of persist_session. Default: true>
isolated: <true for no extension/MCP tools, only built-in tools. Default: false>${
    // Offering the field on a project that turned worktrees off would bake a
    // request that is refused at spawn time into a file that outlives the
    // session — the #231 pathology (models fill the fields they are shown)
    // one layer up. Built per invocation, so this read is live.
    isWorktreeIsolationEnabled()
      ? `\nisolation: <"worktree" to run in isolated git worktree; "off" to refuse one even when the caller asks. Omit for normal>`
      : ""
  }
---

<system prompt body — instructions for the agent>
\`\`\`

Guidelines for choosing settings:
- For read-only tasks (review, analysis): tools: read, bash, grep, find, ls
- For code modification tasks: include edit, write
- Use prompt_mode: append if the agent should keep the default system prompt and add specialization on top
- Use prompt_mode: replace for fully custom agents with their own personality/instructions
- Set inherit_context: true if the agent needs to know what was discussed in the parent conversation
- Set isolated: true if the agent should NOT have access to MCP servers or other extensions
- Set output_transcript: false to skip writing this agent's transcript; this alone doesn't keep the run off disk (persist_session, and a kept isolation: worktree, still write) — set those too if that's the goal
- Only include frontmatter fields that differ from defaults — omit fields where the default is fine

Write the file using the write tool. Only write the file, nothing else.`;

  const { record } = await rt.manager.spawnAndWait(rt.pi, ctx, "general-purpose", generatePrompt, {
    description: `Generate ${name} agent`,
    maxTurns: 5,
    // Exempt from maxConcurrentForeground. This runs from a modal wizard, not
    // a tool call: it passes no signal, and Esc in `ctx.ui` never reaches the
    // manager — so a user waiting behind a full pool would have no way to
    // cancel at all. It is also one human action that cannot fan out, which
    // is what the limit exists to bound. It still counts once started.
    bypassQueue: true,
  });

  if (record.status === "error") {
    ctx.ui.notify(`Generation failed: ${record.error}`, "warning");
    return;
  }

  rt.reloadCustomAgents();

  if (existsSync(targetPath)) {
    ctx.ui.notify(`Created ${targetPath}`, "info");
  } else {
    ctx.ui.notify(
      "Agent generation completed but file was not created. Check the agent output.",
      "warning",
    );
  }
}

async function showManualWizard(
  rt: SubagentsRuntime,
  ctx: ExtensionCommandContext,
  targetDir: string,
) {
  // 1. Name
  const name = await ctx.ui.input("Agent name (filename, no spaces)");
  if (!name) return;

  // 2. Description
  const description = await ctx.ui.input("Description (one line)");
  if (!description) return;

  // 3. Tools
  const toolChoice = await ctx.ui.select("Tools", [
    "all",
    "none",
    "read-only (read, bash, grep, find, ls)",
    "custom...",
  ]);
  if (!toolChoice) return;

  let tools: string;
  if (toolChoice === "all") {
    tools = BUILTIN_TOOL_NAMES.join(", ");
  } else if (toolChoice === "none") {
    tools = "none";
  } else if (toolChoice.startsWith("read-only")) {
    tools = "read, bash, grep, find, ls";
  } else {
    const customTools = await ctx.ui.input(
      "Tools (comma-separated)",
      BUILTIN_TOOL_NAMES.join(", "),
    );
    if (!customTools) return;
    tools = customTools;
  }

  // 4. Model
  const modelChoice = await ctx.ui.select("Model", [
    "inherit (parent model)",
    "haiku",
    "sonnet",
    "opus",
    "custom...",
  ]);
  if (!modelChoice) return;

  let model: string | undefined;
  if (modelChoice === "haiku") model = "anthropic/claude-haiku-4-5";
  else if (modelChoice === "sonnet") model = "anthropic/claude-sonnet-4-6";
  else if (modelChoice === "opus") model = "anthropic/claude-opus-4-6";
  else if (modelChoice === "custom...") {
    model = (await ctx.ui.input("Model (provider/modelId)")) || undefined;
  }

  // 5. Thinking
  // "inherit" is a UI-only pseudo-choice (omit the field); the rest mirror pi.
  const thinkingChoice = await ctx.ui.select("Thinking level", ["inherit", ...THINKING_LEVELS]);
  if (!thinkingChoice) return;

  // 6. System prompt
  const systemPrompt = await ctx.ui.editor("System prompt", "");
  if (systemPrompt === undefined) return;

  const content = buildNewAgentFile({
    description,
    tools,
    model,
    thinking: thinkingChoice === "inherit" ? undefined : thinkingChoice,
    systemPrompt,
  });

  mkdirSync(targetDir, { recursive: true });
  const targetPath = join(targetDir, `${name}.md`);

  if (existsSync(targetPath)) {
    const overwrite = await ctx.ui.confirm("Overwrite", `${targetPath} already exists. Overwrite?`);
    if (!overwrite) return;
  }

  const { writeFileSync } = await import("node:fs");
  writeFileSync(targetPath, content, "utf-8");
  rt.reloadCustomAgents();
  ctx.ui.notify(`Created ${targetPath}`, "info");
}

const NUMERIC_IDS = new Set([
  "maxConcurrent",
  "maxConcurrentForeground",
  "defaultMaxTurns",
  "graceTurns",
  "maxSubagentDepth",
]);

async function showSettings(rt: SubagentsRuntime, ctx: ExtensionCommandContext) {
  function buildItems(): SettingItem[] {
    const mc = rt.manager.getMaxConcurrent();
    const mcf = rt.manager.getMaxConcurrentForeground();
    const dmt = getDefaultMaxTurns() ?? 0;
    const gt = getGraceTurns();
    const msd = getMaxSubagentDepth();
    // Label what unset actually does — it targets general-purpose even when
    // that is unregistered (the permissive hardcoded tier), so showing "none"
    // there would advertise strict dispatch for the most permissive state.
    // `values` still offers only resolvable targets, so the user cannot
    // persist a fallback that would hard-error on every dispatch.
    const fallbackValue = getFallbackSubagent() ?? "general-purpose";
    const fallbackValues = [...new Set([...getAvailableTypes(), NO_FALLBACK])];

    return [
      {
        id: "maxConcurrent",
        label: "Max concurrency",
        description: "Max concurrent background agents (Enter to type)",
        currentValue: String(mc),
        values: [String(mc)],
      },
      {
        id: "maxConcurrentForeground",
        label: "Max foreground concurrency",
        description: "Max concurrent foreground (blocking) agents (0 = unlimited, Enter to type)",
        currentValue: String(mcf),
        values: [String(mcf)],
      },
      {
        id: "defaultMaxTurns",
        label: "Default max turns",
        description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
        currentValue: String(dmt),
        values: [String(dmt)],
      },
      {
        id: "graceTurns",
        label: "Grace turns",
        description: "Grace turns after wrap-up steer (Enter to type)",
        currentValue: String(gt),
        values: [String(gt)],
      },
      {
        id: "maxSubagentDepth",
        label: "Nested depth",
        description:
          "Hard cap on nested delegation — main is 0, its subagents 1 (0/1 = nesting off, Enter to type)",
        currentValue: String(msd),
        values: [String(msd)],
      },
      {
        id: "joinMode",
        label: "Join mode",
        description: "Default join mode for background agents",
        currentValue: rt.getDefaultJoinMode(),
        values: ["smart", "async", "group"],
      },
      {
        id: "backgroundByDefault",
        label: "Background by default",
        description:
          "An Agent call that doesn't say runs detached (off = blocks the turn and returns inline)",
        currentValue: rt.getBackgroundByDefault() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "scopeModels",
        label: "Scope models",
        description: "Validate subagent models against scoped models (/scoped-models)",
        currentValue: isScopeModelsEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "strictAgentFiles",
        label: "Strict agent files",
        description:
          "Fail startup on an unreadable/unparseable agent .md instead of skipping it with a warning",
        currentValue: rt.getStrictAgentFiles() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "disableDefaultAgents",
        label: "Disable defaults",
        description:
          "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
        currentValue: isDefaultsDisabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "fallbackSubagent",
        label: "Fallback agent",
        description: `Agent used when subagent_type is unknown, disabled, or ambiguous; "${NO_FALLBACK}" rejects the call instead (strict dispatch)`,
        currentValue: fallbackValue,
        values: fallbackValues,
      },
      {
        id: "outputTranscript",
        label: "Output transcript",
        description:
          "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
        currentValue: getOutputTranscriptDefault() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "worktreeIsolation",
        label: "Worktree isolation",
        description:
          "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the Agent tool spec on next pi session.",
        currentValue: isWorktreeIsolationEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "reportUsage",
        label: "Report usage to session",
        description:
          "Add subagent tokens and cost to this session's own totals, so pi's footer and /cost stop reading a delegating session as nearly free. Reported on the next tool result (agents that finish in the background are counted on the one after). Context-window % is unaffected.",
        currentValue: rt.isReportUsageEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "showCost",
        label: "Show cost",
        description:
          "Show an estimated `~$0.0042` beside subagent token counts in the widget, fleet view, results and notifications. Priced by pi from the model's rates — omitted entirely for a model it has no rates for.",
        currentValue: rt.isShowCostEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "showModel",
        label: "Show model",
        description:
          "Name the model driving each agent, and the thinking level it is running at, on the widget's running rows. The Agent tool result and the conversation viewer show the pair either way — this adds it to the widget, where the row is already dense.",
        currentValue: rt.isShowModelEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "viewerMarkdown",
        label: "Viewer markdown",
        description:
          "How much of the conversation viewer renders as Markdown. assistant = assistant text only (default); all = tool results too, for tools that emit Markdown — accepting that a Markdown pass over a diff or a log eats `#` comments, swallows a `---` line and re-fences indented output; off = everything verbatim. `m` in the viewer cycles the same setting (footer: raw / md / md+).",
        currentValue: rt.getViewerMarkdown(),
        values: ["off", "assistant", "all"],
      },
      {
        id: "fleetView",
        label: "Fleet view",
        description:
          "Claude Code-style main+subagents list below the editor (↓/← to navigate, Enter to view)",
        currentValue: rt.isFleetViewEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "agentMentions",
        label: "Agent mentions",
        description:
          "Route `@handle message` at the prompt to that agent. model = an off-screen clone of this conversation calls the Agent tool, so the agent gets a context-written prompt, a transcript and per-tool detail, and the chat stays clean; direct = started here from your text, no model call. Messaging and resuming are direct either way.",
        currentValue: rt.getAgentMentionMode(),
        values: ["model", "direct", "off"],
      },
      {
        id: "rememberAgents",
        label: "Remember agents",
        description:
          "Persist subagent sessions so `@handle` can resume one long after it finished (they also appear in /resume)",
        currentValue: getRememberAgents() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "widgetMode",
        label: "Widget",
        description:
          "Above-editor agent widget: all = every agent; background = hide foreground (they already render inline); off = hide the widget.",
        currentValue: rt.getWidgetMode(),
        values: ["all", "background", "off"],
      },
      {
        id: "toolDescriptionMode",
        label: "Tool description",
        description:
          "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (<agent dir>/agent-tool-description.md with {{placeholders}})",
        currentValue: rt.getToolDescriptionMode(),
        values: ["full", "compact", "custom"],
      },
    ];
  }

  function applyValue(id: string, value: string) {
    if (id === "maxConcurrent") {
      const n = parseInt(value, 10);
      if (n >= 1) {
        rt.manager.setMaxConcurrent(n);
        void rt.notifyApplied(ctx, `Max concurrency set to ${n}`);
      }
    } else if (id === "maxConcurrentForeground") {
      // 0 is meaningful here, unlike maxConcurrent above: it means unlimited.
      const n = parseInt(value, 10);
      if (n >= 0) {
        rt.manager.setMaxConcurrentForeground(n);
        void rt.notifyApplied(
          ctx,
          n === 0
            ? "Max foreground concurrency set to unlimited"
            : `Max foreground concurrency set to ${n}`,
        );
      }
    } else if (id === "defaultMaxTurns") {
      const n = parseInt(value, 10);
      if (n === 0) {
        setDefaultMaxTurns(undefined);
        void rt.notifyApplied(ctx, "Default max turns set to unlimited");
      } else if (n >= 1) {
        setDefaultMaxTurns(n);
        void rt.notifyApplied(ctx, `Default max turns set to ${n}`);
      }
    } else if (id === "graceTurns") {
      const n = parseInt(value, 10);
      if (n >= 1) {
        setGraceTurns(n);
        void rt.notifyApplied(ctx, `Grace turns set to ${n}`);
      }
    } else if (id === "maxSubagentDepth") {
      const n = parseInt(value, 10);
      if (n >= 0) {
        setMaxSubagentDepth(n);
        void rt.notifyApplied(
          ctx,
          n <= 1
            ? "Nested delegation disabled"
            : `Nested depth set to ${n}. Applies to agents started from now on.`,
        );
      }
    } else if (id === "joinMode") {
      rt.setDefaultJoinMode(value as JoinMode);
      void rt.notifyApplied(ctx, `Default join mode set to ${value}`);
    } else if (id === "backgroundByDefault") {
      const enabled = value === "on";
      rt.setBackgroundByDefault(enabled);
      void rt.notifyApplied(
        ctx,
        enabled
          ? "Agent calls run in the background unless they pass run_in_background: false"
          : "Agent calls block and return inline unless they pass run_in_background: true",
      );
    } else if (id === "scopeModels") {
      const enabled = value === "on";
      setScopeModelsEnabled(enabled);
      void rt.notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "strictAgentFiles") {
      const enabled = value === "on";
      rt.setStrictAgentFiles(enabled);
      void rt.notifyApplied(
        ctx,
        `Strict agent files ${enabled ? "enabled" : "disabled"}. Takes effect on next pi session.`,
      );
    } else if (id === "disableDefaultAgents") {
      const enabled = value === "on";
      rt.setDisableDefaultAgents(enabled);
      void rt.notifyApplied(
        ctx,
        `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`,
      );
    } else if (id === "fallbackSubagent") {
      setFallbackSubagent(value);
      void rt.notifyApplied(
        ctx,
        value === NO_FALLBACK
          ? "Unknown or disabled agent types will now be rejected"
          : `Unknown agent types will fall back to ${value}`,
      );
    } else if (id === "outputTranscript") {
      const enabled = value === "on";
      setOutputTranscriptDefault(enabled);
      void rt.notifyApplied(
        ctx,
        `Output transcript ${enabled ? "enabled" : "disabled"} by default`,
      );
    } else if (id === "worktreeIsolation") {
      const enabled = value === "on";
      setWorktreeIsolationEnabled(enabled);
      // The refusal is live, but the tool schema is built at registration, so
      // the isolation parameter only appears/disappears next session.
      void rt.notifyApplied(
        ctx,
        `Worktree isolation ${enabled ? "enabled" : "disabled"}. Tool parameter updates on next pi session.`,
      );
    } else if (id === "toolDescriptionMode") {
      rt.setToolDescriptionMode(value as ToolDescriptionMode);
      void rt.notifyApplied(
        ctx,
        `Tool description set to ${value}. Takes effect on next pi session.`,
      );
    } else if (id === "reportUsage") {
      const enabled = value === "on";
      rt.setReportUsage(enabled);
      void rt.notifyApplied(
        ctx,
        enabled
          ? "Subagent usage now counted in this session's totals"
          : "Subagent usage no longer counted in this session's totals",
      );
    } else if (id === "showCost") {
      const enabled = value === "on";
      rt.setShowCost(enabled);
      void rt.notifyApplied(ctx, `Cost display ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "showModel") {
      const enabled = value === "on";
      rt.setShowModel(enabled);
      void rt.notifyApplied(ctx, `Model display ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "viewerMarkdown") {
      rt.setViewerMarkdown(value as ViewerMarkdownMode);
      void rt.notifyApplied(ctx, `Viewer markdown set to ${value}`);
    } else if (id === "fleetView") {
      const enabled = value === "on";
      rt.setFleetViewEnabled(enabled);
      void rt.notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "agentMentions") {
      const mode = value as AgentMentionMode;
      rt.setAgentMentionMode(mode);
      void rt.notifyApplied(
        ctx,
        mode === "off"
          ? "Agent mentions disabled"
          : mode === "model"
            ? "Agent mentions on — a conversation clone starts a mentioned agent off-screen"
            : "Agent mentions on — a mentioned agent starts here, with no model call",
      );
    } else if (id === "rememberAgents") {
      const enabled = value === "on";
      setRememberAgents(enabled);
      void rt.notifyApplied(ctx, `Remember agents ${enabled ? "enabled" : "disabled"}`);
    } else if (id === "widgetMode") {
      rt.setWidgetMode(value as WidgetMode);
      void rt.notifyApplied(ctx, `Widget set to ${value}`);
    }
  }

  let list: SettingsList;
  // Track current selection index directly (SettingsList doesn't expose it).
  // Updated on arrow keys so Enter knows which field is selected immediately.
  let currentIndex = 0;

  const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
    const items = buildItems();

    list = new SettingsList(
      items,
      items.length + 2,
      getSettingsListTheme(),
      (id, newValue) => {
        applyValue(id, newValue);
      },
      () => done(undefined as undefined),
    );

    const container = new Container();
    container.addChild(new Text("⚙  Subagent Settings", 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        // Track navigation so Enter knows the current field
        if (matchesKey(data, "up")) {
          currentIndex = Math.max(0, currentIndex - 1);
        } else if (matchesKey(data, "down")) {
          currentIndex = Math.min(items.length - 1, currentIndex + 1);
        }

        // Enter on numeric field → close and prompt for typed input
        if (matchesKey(data, Key.enter) && NUMERIC_IDS.has(items[currentIndex].id)) {
          done(items[currentIndex].id);
          return;
        }
        list.handleInput?.(data);
      },
    };
  });

  // If a numeric field ID was returned, prompt for typed input
  if (result && NUMERIC_IDS.has(result)) {
    const current =
      result === "maxConcurrent"
        ? String(rt.manager.getMaxConcurrent())
        : result === "maxConcurrentForeground"
          ? String(rt.manager.getMaxConcurrentForeground())
          : result === "defaultMaxTurns"
            ? String(getDefaultMaxTurns() ?? 0)
            : result === "maxSubagentDepth"
              ? String(getMaxSubagentDepth())
              : String(getGraceTurns());

    const label =
      result === "maxConcurrent"
        ? "Max concurrency (1+)"
        : result === "maxConcurrentForeground"
          ? "Max foreground concurrency (0 = unlimited)"
          : result === "defaultMaxTurns"
            ? "Default max turns (0 = unlimited)"
            : result === "maxSubagentDepth"
              ? "Nested depth (0/1 = nesting off)"
              : "Grace turns (1+)";

    // Loop until user enters a valid integer or cancels (Esc / null).
    // Silently trims whitespace; rejects non-numeric input by re-prompting.
    let input: string | undefined = await ctx.ui.input(label, current);
    while (input != null) {
      const trimmed = input.trim();
      const n = Number(trimmed);
      if (trimmed !== "" && Number.isInteger(n)) {
        applyValue(result, String(n));
        await showSettings(rt, ctx);
        return;
      }
      // Invalid — re-prompt with the user's last entry so they can edit it
      input = await ctx.ui.input(label, trimmed);
    }
  }
}

/** Register the `/agents` command. */
export function wireAgentsMenu(rt: SubagentsRuntime): void {
  rt.pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => {
      await showAgentsMenu(rt, ctx);
    },
  });
}
