import { randomUUID } from "node:crypto";

import type {
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type {
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import {
  errorMessage,
  scratchpadRoot,
  seedIfMissing,
  truncateMiddle,
  type Config,
  type NotifyLevel,
  type WithEnabled,
} from "../../src/core/index.ts";
import {
  isScratchpadWrite,
  isToolAllowlisted,
  mapConfigValue,
  type ReviewConfig,
  type ReviewerModelSpec,
} from "./allowlist.ts";
import type { guardianSchema } from "./index.ts";
import { REVIEW_POLICY } from "./policy.ts";
import { buildSystemPrompt, getGuardianPromptPath, loadGuardianPromptBase } from "./prompt.ts";
import { buildReviewRequest, type GrantRecord } from "./review-request.ts";
import { getReviewerText, normalizeReason, parseReviewerDecision } from "./reviewer-response.ts";
import { summarizeToolCall, type SessionEntryLike } from "./transcript.ts";

// The root barrel exports ToolCallEventResult but omits this sibling type
// (a gap in pi-coding-agent 0.84.3); mirror it until upstream fixes the export.
interface ToolResultEventResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  usage?: Usage;
}

export const COMMAND_NAME = "guardian";
export const STATUS_KEY = "@jpi-guardian/review-mode";
const MAX_REVIEW_TOKENS = 220;
const MAX_SESSION_GRANTS = 20;
const MAX_DENY_DIALOG_TITLE_CHARS = 200;

// jpi-status passes setStatus values through to the terminal unmodified, so
// the short status carries its own truecolor SGR sequence.
function coloredStatus(hex: string, text: string): string {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

const STATUS_OFF = coloredStatus("#949494", "⏸ manual mode on");
const STATUS_CONFIG_ERROR = coloredStatus("#cf8c88", "✕ auto config error");
const STATUS_UNKNOWN_MODEL = coloredStatus("#cf8c88", "✕ unknown model");
const STATUS_NO_AUTH = coloredStatus("#cf8c88", "✕ no review auth");
const STATUS_ON = coloredStatus("#f8c633", "⏵⏵ auto mode on");

type StatusLevel = "info" | "warning";

export type StatusSnapshot = {
  short: string;
  detail: string;
  level: StatusLevel;
};

export type ReviewContext = {
  cwd: string;
  signal?: AbortSignal;
  hasUI?: boolean;
  ui?: {
    notify(message: string, level: NotifyLevel): void;
    setStatus(key: string, value: string | undefined): void;
    // Mirrors pi's ExtensionUIContext dialog methods. Optional: older hosts
    // (or tests) may not implement them, in which case a denial falls back
    // to the plain (no-dialog) path.
    select?(
      title: string,
      options: string[],
      opts?: { signal?: AbortSignal },
    ): Promise<string | undefined>;
    input?(
      title: string,
      placeholder?: string,
      opts?: { signal?: AbortSignal },
    ): Promise<string | undefined>;
  };
  sessionManager: {
    getBranch(): SessionEntryLike[];
  };
  modelRegistry: {
    find(provider: string, modelId: string): unknown;
    hasConfiguredAuth(model: unknown): boolean;
    complete(
      model: unknown,
      context: unknown,
      options?: Record<string, unknown>,
    ): Promise<AssistantMessage>;
  };
};

export type ReviewCommandContext = ReviewContext & {
  ui: {
    notify(message: string, level: NotifyLevel): void;
    setStatus(key: string, value: string | undefined): void;
  };
};

export type ControllerOptions = {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  now?: () => number;
  createSessionId?: () => string;
  scratchpadRoot?: () => string;
};

type ReviewConfigState = {
  config: ReviewConfig;
  issues: string[];
};

function freezeToolInput(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeToolInput(child, seen);
  Object.freeze(value);
}

export function mergeUsage(base: Usage | undefined, extra: Usage | undefined): Usage | undefined {
  if (!base) return extra;
  if (!extra) return base;

  return {
    input: base.input + extra.input,
    output: base.output + extra.output,
    cacheRead: base.cacheRead + extra.cacheRead,
    cacheWrite: base.cacheWrite + extra.cacheWrite,
    ...(base.cacheWrite1h !== undefined || extra.cacheWrite1h !== undefined
      ? { cacheWrite1h: (base.cacheWrite1h ?? 0) + (extra.cacheWrite1h ?? 0) }
      : {}),
    ...(base.reasoning !== undefined || extra.reasoning !== undefined
      ? { reasoning: (base.reasoning ?? 0) + (extra.reasoning ?? 0) }
      : {}),
    totalTokens: base.totalTokens + extra.totalTokens,
    cost: {
      input: base.cost.input + extra.cost.input,
      output: base.cost.output + extra.cost.output,
      cacheRead: base.cost.cacheRead + extra.cost.cacheRead,
      cacheWrite: base.cost.cacheWrite + extra.cost.cacheWrite,
      total: base.cost.total + extra.cost.total,
    },
  };
}

function buildConfigGuidance(detail: string, path: string): ToolCallEventResult {
  return {
    block: true,
    reason: `Auto-review is enabled but unavailable: ${detail}. Fix ${path}, run /${COMMAND_NAME} reload, or use /${COMMAND_NAME} off for this session.`,
  };
}

function buildReviewFailure(reason: string, terminate: boolean): ToolCallEventResult {
  return {
    block: true,
    reason: terminate
      ? `Auto-review could not review this call again (${reason}). Stop here and ask the user instead of retrying or working around the gate.`
      : `Auto-review could not review this call (${reason}). Retry once. If review fails again, ask the user instead of working around it.`,
    terminate,
  };
}

function buildDenial(reason: string, terminate: boolean): ToolCallEventResult {
  const guidance = terminate
    ? " Stop here and ask the user before any further attempts."
    : " You may try a materially safer alternative or ask the user.";
  return {
    block: true,
    reason: `Auto-review denied this call: ${reason}. Do not workaround or circumvent this denial.${guidance}`,
    terminate,
  };
}

function buildOpenCircuit(reason: string): ToolCallEventResult {
  return {
    block: true,
    reason: `Auto-review stopped this agent run after ${reason}. Ask the user before making more tool calls.`,
    terminate: true,
  };
}

export type ReviewerModelResolution =
  | { kind: "config-issue"; issue: string }
  | { kind: "unknown-model"; modelSpec: ReviewerModelSpec }
  | { kind: "no-auth"; modelSpec: ReviewerModelSpec }
  | { kind: "ready"; modelSpec: ReviewerModelSpec; model: unknown };

// getStatusSnapshot and handleToolCall both need the same three-step check
// (config issues → unknown model → no auth) before the reviewer model can
// run; they map the result to different shapes, so the check lives here once.
export function resolveReviewerModel(
  ctx: Pick<ReviewContext, "modelRegistry">,
  config: Pick<ReviewConfig, "model">,
  issues: string[],
): ReviewerModelResolution {
  if (issues.length > 0 || !config.model) {
    return { kind: "config-issue", issue: issues[0]! };
  }

  const modelSpec = config.model;
  const model = ctx.modelRegistry.find(modelSpec.provider, modelSpec.modelId);
  if (!model) return { kind: "unknown-model", modelSpec };

  if (!ctx.modelRegistry.hasConfiguredAuth(model)) return { kind: "no-auth", modelSpec };

  return { kind: "ready", modelSpec, model };
}

export class AutoReviewController {
  readonly cfg: Config<WithEnabled<typeof guardianSchema>>;
  readonly now: () => number;
  readonly reviewSessionId: string;
  readonly scratchpadRootFn: () => string;
  readonly promptPath: string;

  configState: ReviewConfigState | undefined;
  sessionEnabledOverride: boolean | undefined;
  consecutiveExplicitDenials = 0;
  consecutiveReviewFailures = 0;
  openCircuitReason: string | undefined;
  readonly pendingUsage = new Map<string, Usage>();
  // Set only when the reviewer model actually ran and allowed the call, so
  // the transcript annotation never appears for allowlisted or denied calls.
  readonly reviewDurations = new Map<string, number>();
  // Lives for the whole session (never cleared by resetAgentRun/resetBreakers):
  // a user's explicit override of a denial stays in force for later calls in
  // the same session, capped so the reviewer prompt can't grow unbounded.
  readonly sessionGrants: GrantRecord[] = [];

  constructor(cfg: Config<WithEnabled<typeof guardianSchema>>, options: ControllerOptions = {}) {
    this.cfg = cfg;
    this.now = options.now ?? Date.now;
    this.reviewSessionId = (options.createSessionId ?? randomUUID)();
    this.scratchpadRootFn = options.scratchpadRoot ?? scratchpadRoot;
    this.promptPath = getGuardianPromptPath(options.env, options.homeDirectory);
  }

  // Best-effort: a failed seed here is not fatal, since loadPromptBase seeds
  // again (and falls back to REVIEW_POLICY) on the next review.
  async seedPrompt(): Promise<void> {
    await seedIfMissing(this.promptPath, REVIEW_POLICY).catch(() => undefined);
  }

  async loadPromptBase(ctx: ReviewContext): Promise<string> {
    const notify =
      ctx.hasUI && ctx.ui
        ? (message: string, level: "warning") => ctx.ui!.notify(message, level)
        : undefined;
    return loadGuardianPromptBase(this.promptPath, notify);
  }

  async reloadConfig(): Promise<ReviewConfigState> {
    const { value, issues } = await this.cfg.load();
    const mergedIssues = [...issues];
    const config = mapConfigValue(value, this.cfg.path, mergedIssues);
    const state = { config, issues: mergedIssues };
    this.configState = state;
    return state;
  }

  async ensureConfig(): Promise<ReviewConfigState> {
    if (!this.configState) return this.reloadConfig();
    return this.configState;
  }

  resetBreakers(): void {
    this.consecutiveExplicitDenials = 0;
    this.consecutiveReviewFailures = 0;
    this.openCircuitReason = undefined;
  }

  resetAgentRun(): void {
    this.resetBreakers();
    this.pendingUsage.clear();
  }

  resetDenials(): void {
    this.consecutiveExplicitDenials = 0;
  }

  recordGrant(toolName: string, summary: string): void {
    this.sessionGrants.push({ toolName, summary, timestamp: this.now() });
    if (this.sessionGrants.length > MAX_SESSION_GRANTS) this.sessionGrants.shift();
  }

  resetReviewFailures(): void {
    this.consecutiveReviewFailures = 0;
  }

  // A reviewer failure must not reset the denial streak: otherwise alternating
  // denials and failures would keep both breakers below their thresholds forever.
  recordReviewFailure(reason: string): ToolCallEventResult {
    this.consecutiveReviewFailures += 1;
    const terminate = this.consecutiveReviewFailures >= 2;
    if (terminate) this.openCircuitReason = "two consecutive reviewer failures";
    return buildReviewFailure(reason, terminate);
  }

  // The module only runs when jpi.kdl's `enabled` gate is true (the loader
  // hard-gates before setup runs), so the only remaining off switch is this
  // session's own /guardian on|off toggle.
  isEffectivelyEnabled(): boolean {
    return this.sessionEnabledOverride ?? true;
  }

  async getStatusSnapshot(ctx: ReviewContext): Promise<StatusSnapshot> {
    const state = await this.ensureConfig();
    const { config, issues } = state;

    if (!this.isEffectivelyEnabled()) {
      return {
        short: STATUS_OFF,
        detail: "Auto-review is off for this session.",
        level: "info",
      };
    }

    const resolved = resolveReviewerModel(ctx, config, issues);
    switch (resolved.kind) {
      case "config-issue":
        return {
          short: STATUS_CONFIG_ERROR,
          detail: `Auto-review needs a valid ${config.path}: ${resolved.issue}.`,
          level: "warning",
        };
      case "unknown-model":
        return {
          short: STATUS_UNKNOWN_MODEL,
          detail: `Auto-review reviewer model ${resolved.modelSpec.raw} is not available. Update ${config.path} and run /${COMMAND_NAME} reload, or use /${COMMAND_NAME} off.`,
          level: "warning",
        };
      case "no-auth":
        return {
          short: STATUS_NO_AUTH,
          detail: `Auto-review reviewer auth is not ready for ${resolved.modelSpec.raw}. Fix auth or ${config.path}, then run /${COMMAND_NAME} reload, or use /${COMMAND_NAME} off.`,
          level: "warning",
        };
      case "ready":
        return {
          short: STATUS_ON,
          detail: `Auto-review is on with ${resolved.modelSpec.raw}.`,
          level: "info",
        };
    }
  }

  applyStatus(ctx: ReviewContext, status: StatusSnapshot): void {
    if (!ctx.hasUI || !ctx.ui) return;
    ctx.ui.setStatus(STATUS_KEY, status.short);
  }

  async notifyStatus(ctx: ReviewCommandContext): Promise<void> {
    const status = await this.getStatusSnapshot(ctx);
    this.applyStatus(ctx, status);
    ctx.ui.notify(status.detail, status.level);
  }

  async handleCommand(rawArgs: string, ctx: ReviewCommandContext): Promise<void> {
    const command = rawArgs.trim().toLowerCase() || "status";

    // Every recognized subcommand mutates (or doesn't) then reports the
    // resulting status the same way; only the mutation differs per command.
    const mutations: Record<string, () => void | Promise<void>> = {
      status: () => {},
      on: () => {
        this.sessionEnabledOverride = true;
        this.resetBreakers();
      },
      off: () => {
        this.sessionEnabledOverride = false;
        this.resetBreakers();
      },
      reload: async () => {
        await this.reloadConfig();
      },
    };

    const mutate = mutations[command];
    if (!mutate) {
      ctx.ui.notify(`Usage: /${COMMAND_NAME} [status|on|off|reload]`, "warning");
      return;
    }

    await mutate();
    await this.notifyStatus(ctx);
  }

  rememberUsage(toolCallId: string, usage: Usage | undefined): void {
    if (!usage) return;
    this.pendingUsage.set(
      toolCallId,
      mergeUsage(this.pendingUsage.get(toolCallId), usage) as Usage,
    );
  }

  async handleToolCall(
    event: ToolCallEvent,
    ctx: ReviewContext,
  ): Promise<ToolCallEventResult | undefined> {
    const state = await this.ensureConfig();
    const { config, issues } = state;

    if (!this.isEffectivelyEnabled()) {
      this.resetBreakers();
      return undefined;
    }

    if (this.openCircuitReason) return buildOpenCircuit(this.openCircuitReason);

    if (isToolAllowlisted(config, event)) {
      freezeToolInput(event.input);
      return undefined;
    }

    if (isScratchpadWrite(config, event, ctx.cwd, this.scratchpadRootFn)) {
      freezeToolInput(event.input);
      return undefined;
    }

    const resolved = resolveReviewerModel(ctx, config, issues);
    if (resolved.kind === "config-issue") return buildConfigGuidance(resolved.issue, config.path);
    if (resolved.kind === "unknown-model")
      return buildConfigGuidance(
        `reviewer model ${resolved.modelSpec.raw} is not available`,
        config.path,
      );
    if (resolved.kind === "no-auth")
      return buildConfigGuidance(
        `reviewer auth is not ready for ${resolved.modelSpec.raw}`,
        config.path,
      );

    const { model } = resolved;

    const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;

    const basePrompt = await this.loadPromptBase(ctx);

    const startedAt = this.now();
    let response: AssistantMessage;
    try {
      response = await ctx.modelRegistry.complete(
        model,
        {
          systemPrompt: buildSystemPrompt(basePrompt, config.policy),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: await buildReviewRequest(ctx, event, this.sessionGrants) },
              ],
              timestamp: startedAt,
            },
          ],
        },
        {
          cacheRetention: "short",
          maxTokens: MAX_REVIEW_TOKENS,
          reasoningEffort: "minimal",
          sessionId: this.reviewSessionId,
          signal,
          timeoutMs: config.timeoutMs,
        },
      );
    } catch (error) {
      if (timeoutSignal.aborted && !ctx.signal?.aborted) {
        return this.recordReviewFailure(`timeout after ${config.timeoutMs}ms`);
      }
      const message = normalizeReason(errorMessage(error));
      return this.recordReviewFailure(message || "reviewer error");
    }
    const durationMs = this.now() - startedAt;

    this.rememberUsage(event.toolCallId, response.usage);

    if (response.stopReason === "aborted" && timeoutSignal.aborted && !ctx.signal?.aborted) {
      return this.recordReviewFailure(`timeout after ${config.timeoutMs}ms`);
    }

    if (response.stopReason === "error") {
      return this.recordReviewFailure(normalizeReason(response.errorMessage || "reviewer error"));
    }

    if (response.stopReason !== "stop") {
      return this.recordReviewFailure(`reviewer stopped with ${response.stopReason}`);
    }

    const decision = parseReviewerDecision(getReviewerText(response));
    if (!decision) {
      return this.recordReviewFailure("invalid reviewer output");
    }

    this.resetReviewFailures();
    if (decision.decision === "allow") {
      this.resetDenials();
      freezeToolInput(event.input);
      this.reviewDurations.set(event.toolCallId, durationMs);
      return undefined;
    }

    return this.resolveDenial(ctx, event, decision.reason);
  }

  private async resolveDenial(
    ctx: ReviewContext,
    event: ToolCallEvent,
    reviewerReason: string,
  ): Promise<ToolCallEventResult | undefined> {
    if (ctx.hasUI && ctx.ui && typeof ctx.ui.select === "function") {
      try {
        const title = truncateMiddle(
          `Guardian denied ${event.toolName}: ${reviewerReason}`,
          MAX_DENY_DIALOG_TITLE_CHARS,
          "…",
        );
        const choice = await ctx.ui.select(
          title,
          ["Allow (session grant)", "Deny", "Deny with note"],
          { ...(ctx.signal !== undefined && { signal: ctx.signal }) },
        );

        if (choice === "Allow (session grant)") {
          this.recordGrant(event.toolName, summarizeToolCall(event.toolName, event.input));
          this.resetDenials();
          freezeToolInput(event.input);
          return undefined;
        }

        if (choice === "Deny" || choice === "Deny with note") {
          let reason = `${reviewerReason} The user reviewed this denial and upheld it.`;
          if (choice === "Deny with note") {
            const note = await ctx.ui.input?.("Note for the agent (optional)", undefined, {
              ...(ctx.signal !== undefined && { signal: ctx.signal }),
            });
            if (note && note.trim().length > 0) reason += ` User note: ${note}`;
          }
          return this.denyToolCall(reason);
        }

        // undefined means dismissed or aborted — the user made no decision,
        // so the reason deliberately omits the upheld-by-user sentence.
        return this.denyToolCall(reviewerReason);
      } catch {
        return this.denyToolCall(reviewerReason);
      }
    }

    return this.denyToolCall(reviewerReason);
  }

  private denyToolCall(reason: string): ToolCallEventResult {
    this.consecutiveExplicitDenials += 1;
    // Pi only terminates early when every tool result in the current batch sets
    // terminate, so an allowed sibling in a parallel batch delays the stop by one
    // batch. The open circuit still blocks (and terminates) every later call.
    const terminate = this.consecutiveExplicitDenials >= 3;
    if (terminate) this.openCircuitReason = "three denials without an approved call";
    return buildDenial(reason, terminate);
  }

  handleToolResult(event: ToolResultEvent): ToolResultEventResult | undefined {
    const usage = this.pendingUsage.get(event.toolCallId);
    if (!usage) return undefined;
    this.pendingUsage.delete(event.toolCallId);
    const merged = mergeUsage(event.usage, usage);
    return { ...(merged !== undefined && { usage: merged }) };
  }

  // Returns the measured reviewer duration for a call the reviewer actually
  // allowed, and forgets it, so a result can only ever be annotated once.
  takeReviewDuration(toolCallId: string): number | undefined {
    const durationMs = this.reviewDurations.get(toolCallId);
    if (durationMs === undefined) return undefined;
    this.reviewDurations.delete(toolCallId);
    return durationMs;
  }

  handleToolResultMessage(message: ToolResultMessage): { message: ToolResultMessage } | undefined {
    const usage = this.pendingUsage.get(message.toolCallId);
    if (!usage) return undefined;
    this.pendingUsage.delete(message.toolCallId);
    const merged = mergeUsage(message.usage, usage);
    return { message: { ...message, ...(merged !== undefined && { usage: merged }) } };
  }
}
