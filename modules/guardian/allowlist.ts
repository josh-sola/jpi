import { resolve } from "node:path";

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

export function isToolAllowlisted(
  config: ReviewConfig,
  event: Pick<ToolCallEvent, "toolName" | "input">,
): boolean {
  if (config.allowTools.includes(event.toolName)) return true;
  if (config.readonly && BUILT_IN_READONLY_TOOLS.has(event.toolName)) return true;
  if (config.readonly && event.toolName === "mcp" && isMcpGatewayIntrospection(event.input))
    return true;
  if (config.allowMcp.some((server) => matchesMcpServer(event.toolName, server))) return true;
  if (event.toolName !== "bash") return false;

  const input: unknown = event.input;
  const command = isRecord(input) && typeof input.command === "string" ? input.command : undefined;
  if (!command) return false;

  const split = splitCommand(command);
  if (split.kind === "opaque") {
    return config.allowBash.some((pattern) => matchesWholeCommand(pattern.regex, command));
  }

  // Most-restrictive-wins: every segment needs its own justification, so one
  // unsafe half of a split command can never ride on a safe sibling.
  return split.segments.every(
    (segment) =>
      (config.readonly && isReadOnlyCommand(segment.argv)) ||
      config.allowBash.some((pattern) => matchesWholeCommand(pattern.regex, segment.text)),
  );
}

// pi-internal(tool-path-resolution): write/edit tool inputs both carry
// `path`, resolved against the handler's cwd by pi's own tool implementation,
// so it is resolved the same way here.
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
