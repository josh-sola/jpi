import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

import {
  errorMessage,
  isRecord,
  isWithinRoot,
  type InferNode,
  type WithEnabled,
} from "../../src/core/index.ts";
import type { guardianSchema } from "./index.ts";
import { BUILT_IN_READONLY_TOOLS, isReadOnlyCommand } from "./readonly.ts";
import { splitCommand } from "./split.ts";

export type ReviewerModelSpec = {
  raw: string;
  provider: string;
  modelId: string;
};

export type BashAllowPattern = {
  source: string;
  regex: RegExp;
};

export type ReviewConfig = {
  path: string;
  model?: ReviewerModelSpec;
  allowTools: string[];
  allowBash: BashAllowPattern[];
  allowMcp: string[];
  readonly: boolean;
  scratchpad: boolean;
  policy: string[];
  timeoutMs: number;
};

// The loader's Config carries the injected `enabled` gate field; the review
// pipeline below never reads it (the module hard-gates on it before setup runs).
export type GuardianConfigValue = InferNode<WithEnabled<typeof guardianSchema>>;

export function parseReviewerModel(value: unknown): ReviewerModelSpec | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;

  const provider = raw.slice(0, slash).trim();
  const modelId = raw.slice(slash + 1).trim();
  if (!provider || !modelId) return undefined;

  return { raw, provider, modelId };
}

export function mapConfigValue(
  value: GuardianConfigValue,
  path: string,
  issues: string[],
): ReviewConfig {
  const model = parseReviewerModel(value.model);
  if (!model) issues.push('model must be set to "provider/model-id"');

  const allowBash: BashAllowPattern[] = [];
  for (const source of value.allow.bash) {
    try {
      allowBash.push({ source, regex: new RegExp(source) });
    } catch (error) {
      const message = errorMessage(error);
      issues.push(`allow.bash contains an invalid regex (${source}): ${message}`);
    }
  }

  return {
    path,
    ...(model !== undefined && { model }),
    allowTools: value.allow.tool,
    allowBash,
    allowMcp: value.allow.mcp,
    readonly: value.allow.readonly,
    scratchpad: value.allow.scratchpad,
    policy: value.policy,
    timeoutMs: value.timeoutMs,
  };
}

function matchesWholeCommand(regex: RegExp, command: string): boolean {
  const match = regex.exec(command);
  if (!match) return false;
  return match.index === 0 && match[0].length === command.length;
}

// pi-mcp-adapter names server tools in one of three shapes: a namespace-proxy
// tool ("mcp__" + server, dashes to underscores), or a directly registered
// per-tool name ("server_tool" or "mcp__server_tool").
export function matchesMcpServer(toolName: string, server: string): boolean {
  if (toolName === `mcp__${server.replaceAll("-", "_")}`) return true;
  if (toolName.startsWith(`${server}_`)) return true;
  if (toolName.startsWith(`mcp__${server}_`)) return true;
  return false;
}

// pi-mcp-adapter's "mcp" gateway tool resolves one mode per call, and action,
// tool, and connect outrank the metadata modes (describe, instructions,
// search, list, status) — so only their absence guarantees a metadata-only
// call. action also covers auth-start/auth-complete, which run an OAuth flow.
export function isMcpGatewayIntrospection(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return input.tool === undefined && input.connect === undefined && input.action === undefined;
}

function isCommandTextAllowlisted(config: ReviewConfig, text: string): boolean {
  const split = splitCommand(text);
  if (split.kind === "opaque") {
    return config.allowBash.some((pattern) => matchesWholeCommand(pattern.regex, text));
  }

  // Most-restrictive-wins: every segment needs its own justification, so one
  // unsafe half of a split command can never ride on a safe sibling.
  return split.segments.every(
    (segment) =>
      (config.readonly && isReadOnlyCommand(segment.argv)) ||
      config.allowBash.some((pattern) => matchesWholeCommand(pattern.regex, segment.text)),
  );
}

// run's `file` resolves against the session cwd, never run's own `path`
// param (which only sets the staged copy's execution cwd) — the same
// resolution prepareRun uses, so the allowlist judges the bytes that run.
function readRunScriptText(input: Record<string, unknown>, cwd: string): string | undefined {
  if (typeof input.script === "string") return input.script;
  if (typeof input.file !== "string") return undefined;
  try {
    const target = isAbsolute(input.file) ? input.file : resolve(cwd, input.file);
    return readFileSync(target, "utf8");
  } catch {
    // An unreadable file stays reviewed rather than throwing out of the gate.
    return undefined;
  }
}

function isRunAllowlisted(config: ReviewConfig, input: unknown, cwd: string): boolean {
  if (!isRecord(input)) return false;
  if (input.language !== "zsh") return false;
  if (Array.isArray(input.dependencies) && input.dependencies.length > 0) return false;

  const hasScript = typeof input.script === "string";
  const hasFile = typeof input.file === "string";
  if (hasScript === hasFile) return false; // both or neither: the tool itself rejects this shape

  const text = readRunScriptText(input, cwd);
  if (text === undefined) return false;

  return isCommandTextAllowlisted(config, text);
}

export function isToolAllowlisted(
  config: ReviewConfig,
  event: Pick<ToolCallEvent, "toolName" | "input">,
  cwd: string = process.cwd(),
): boolean {
  if (config.allowTools.includes(event.toolName)) return true;
  if (config.readonly && BUILT_IN_READONLY_TOOLS.has(event.toolName)) return true;
  if (config.readonly && event.toolName === "mcp" && isMcpGatewayIntrospection(event.input))
    return true;
  if (config.allowMcp.some((server) => matchesMcpServer(event.toolName, server))) return true;
  if (event.toolName === "run") return isRunAllowlisted(config, event.input, cwd);
  if (event.toolName !== "bash") return false;

  const input: unknown = event.input;
  const command = isRecord(input) && typeof input.command === "string" ? input.command : undefined;
  if (!command) return false;

  return isCommandTextAllowlisted(config, command);
}

// write/edit tool inputs both carry `path`, resolved against the handler's
// cwd by pi's own tool implementation, so it is resolved the same way here.
function getPathToolTarget(event: Pick<ToolCallEvent, "toolName" | "input">): string | undefined {
  if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
  const input: unknown = event.input;
  return isRecord(input) && typeof input.path === "string" ? input.path : undefined;
}

export function isScratchpadWrite(
  config: Pick<ReviewConfig, "scratchpad">,
  event: Pick<ToolCallEvent, "toolName" | "input">,
  cwd: string,
  scratchpadRootFn: () => string,
): boolean {
  if (!config.scratchpad) return false;
  const target = getPathToolTarget(event);
  if (!target) return false;
  return isWithinRoot(scratchpadRootFn(), resolve(cwd, target));
}
