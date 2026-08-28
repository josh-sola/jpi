/**
 * agent-tool.ts — the `Agent` tool: description text, parameter schema,
 * Claude Code-style rendering, and the execute handler (resume /
 * background-spawn / foreground-spawn paths, split into named helpers below).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  defineTool,
  type ExtensionContext,
  getAgentDir,
  type Theme as PiTheme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  bulletState,
  type BulletState,
  createResultLine,
  errorMessage,
} from "../../src/core/index.ts";
import { renderAgentName } from "./agent-color.ts";
import { isTopLevelAgent } from "./agent-manager.ts";
import { getDefaultMaxTurns, normalizeMaxTurns, SUBAGENT_TOOL_NAMES } from "./agent-runner.ts";
import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getAvailableTypes,
  resolveSpawnType,
  resolveType,
} from "./agent-types.ts";
import type { SubagentsRuntime } from "./index.ts";
import {
  isolationParam,
  resolveAgentInvocationConfig,
  resolveJoinMode,
} from "./invocation-config.ts";
import { describeModel, resolveModel } from "./model-resolver.ts";
import { checkModelScope } from "./model-scope.ts";
import {
  createOutputFilePath,
  ensureOutputFile,
  getOutputTranscriptDefault,
  streamToOutputFile,
  writeInitialEntry,
} from "./output-file.ts";
import { getForegroundOutcomeNote, partialOutputSuffix } from "./status-note.ts";
import type {
  AgentConfig,
  AgentInvocation,
  AgentRecord,
  SubagentType,
  ThinkingLevel,
} from "./types.ts";
import {
  type AgentActivity,
  type AgentDetails,
  buildInvocationTags,
  describeActivity,
  fgPreservingNestedStyles,
  formatCost,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  SPINNER,
  type UICtx,
} from "./ui/agent-widget.ts";
import { getLifetimeCost, getLifetimeTotal, type LifetimeUsage } from "./usage.ts";
import { isWorktreeIsolationEnabled } from "./worktree.ts";

/**
 * Advertised thinking levels, ordered to mirror pi-ai's EXTENDED_THINKING_LEVELS
 * (`off` + every `ThinkingLevel`). Single source for the Agent tool description,
 * the generated-agent template, and the `/agents` wizard so these lists can't
 * drift behind pi again (#147). Availability of any level still depends on the
 * host pi version and the selected model — pi clamps unsupported levels down.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Tool execute return value for a text response. */
export function textResult(msg: string, details?: AgentDetails) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

/** Format an agent's lifetime token total, or "" when zero. */
export function formatLifetimeTokens(o: { lifetimeUsage: LifetimeUsage }): string {
  const t = getLifetimeTotal(o.lifetimeUsage);
  return t > 0 ? formatTokens(t) : "";
}

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by both foreground and background paths to avoid duplication.
 */
export function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  const state: AgentActivity = {
    activeTools: new Map(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    session: undefined,
  };

  const callbacks = {
    onToolActivity: (activity: { type: "start" | "end"; toolName: string }) => {
      if (activity.type === "start") {
        state.activeTools.set(activity.toolName + "_" + Date.now(), activity.toolName);
      } else {
        for (const [key, name] of state.activeTools) {
          if (name === activity.toolName) {
            state.activeTools.delete(key);
            break;
          }
        }
        state.toolUses++;
      }
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: any) => {
      state.session = session;
    },
    // Spend is accumulated on the AgentRecord (agent-manager), which is what
    // every surface reads; this callback exists here only to repaint on it.
    onAssistantUsage: (_usage: LifetimeUsage) => {
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}

export function renderRunningAgentStatus(
  frame: string,
  statsText: string,
  activity: string,
  theme: PiTheme,
): Container {
  const container = new Container();
  container.addChild(
    new Text(theme.fg("accent", frame) + (statsText ? " " + statsText : ""), 0, 0),
  );
  container.addChild(createResultLine(activity, theme));
  return container;
}

/**
 * `⏺ <name>(desc)` header for the Agent tool call line. Not `createToolHeader`:
 * that bolds and width-fits `name` as plain text, which corrupts a badged
 * agent name (already-styled ANSI, e.g. from `renderAgentName`) — both by
 * double-bolding over its own color codes and by measuring/clipping raw
 * string length instead of visible width. This mirrors its one-line, clip-
 * don't-wrap contract via `truncateToWidth`, which is ANSI-aware, instead.
 */
class AgentCallHeader implements Component {
  #state: BulletState = "pending";
  #name = "";
  #desc = "";
  #theme: PiTheme | undefined;

  update(state: BulletState, name: string, desc: string, theme: PiTheme): void {
    this.#state = state;
    this.#name = name;
    this.#desc = desc;
    this.#theme = theme;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.#theme) return [""];
    const bulletColor =
      this.#state === "success" ? "success" : this.#state === "error" ? "error" : "muted";
    const line = `${this.#theme.fg(bulletColor, "⏺ ")}${this.#name}(${this.#theme.fg("muted", this.#desc)})`;
    return [truncateToWidth(line, width)];
  }
}

function createAgentCallHeader(
  state: BulletState,
  name: string,
  desc: string,
  theme: PiTheme,
  reuse?: Component,
): Component {
  const header = reuse instanceof AgentCallHeader ? reuse : new AgentCallHeader();
  header.update(state, name, desc, theme);
  return header;
}

/**
 * Format an agent's tool scope for the Agent tool description.
 *
 * This suffix describes BUILT-IN scope only — extension tools are resolved when
 * the agent runs (extensions can register asynchronously), so they cannot be
 * enumerated while the description is being built. That is why an agent with
 * `tools: "*, ext:mcp/search"` renders "*" and always has.
 *
 * Two distinctions matter, both of them capability claims the orchestrator acts on:
 *
 * - absent vs empty. `builtinToolNames: undefined` means the agent never narrowed
 *   its tools (the shipped defaults); `[]` is what `tools: none` and an `ext:`-only
 *   `tools:` parse to, and the runtime really does hand those agents no built-ins.
 *   Rendering both "*" tells the orchestrator a tool-less agent can run `bash`.
 * - empty-with-extensions vs empty-without. Zero built-ins does NOT imply zero
 *   tools: `tools: none` alongside `extensions:` still surfaces every extension
 *   tool (see tests/fixtures/.agents/agents/tools-none.md, which expects three). Calling
 *   that "none" understates the agent instead of overstating it — better, but still
 *   wrong, and it would route work away from the only agent able to do it. "none"
 *   is therefore reserved for agents that genuinely can call nothing: `isolated`
 *   agents and those with `extensions: false`.
 */
export function formatToolsSuffix(cfg: AgentConfig | undefined): string {
  const tools = cfg?.builtinToolNames;
  if (!tools) return "*";
  if (tools.length === 0) {
    // `isolated` overrides extensions to false in the runner, so both mean the
    // agent has no extension tools either — and then it truly has nothing.
    const noExtensionTools = cfg?.isolated === true || cfg?.extensions === false;
    return noExtensionTools ? "none" : "no built-ins, extension tools only";
  }
  const isFullSet =
    tools.length === BUILTIN_TOOL_NAMES.length &&
    BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
  return isFullSet ? "*" : tools.join(", ");
}

/** Derive a short model label from a model string. */
export function getModelLabelFromConfig(model: string): string {
  // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
  const name = model.includes("/") ? model.split("/").pop()! : model;
  // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
  return name.replace(/-\d{8}$/, "");
}

/** First sentence of an agent description — for the compact type list. */
function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/s);
  return (match ? match[0] : text).replace(/\s+/g, " ").trim();
}

/** Build the full type list text dynamically from available agents only. */
function buildTypeListText(): string {
  const available = getAvailableTypes();

  return available
    .map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model
        ? ` (${getModelLabelFromConfig(cfg.model)})`
        : cfg?.modelDefault
          ? ` (default: ${getModelLabelFromConfig(cfg.modelDefault)})`
          : "";
      const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
    })
    .join("\n");
}

/** Compact type list: one line per agent, first sentence only. */
function buildCompactTypeListText(): string {
  return getAvailableTypes()
    .map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
    })
    .join("\n");
}

/** Build AgentDetails from a base + record-specific fields. */
function buildDetails(
  base: Pick<AgentDetails, "displayName" | "description" | "subagentType" | "modelName" | "tags">,
  record: {
    toolUses: number;
    startedAt: number;
    completedAt?: number | undefined;
    status: string;
    error?: string | undefined;
    id?: string | undefined;
    session?: any;
    lifetimeUsage: LifetimeUsage;
  },
  activity?: AgentActivity,
  overrides?: Partial<AgentDetails>,
): AgentDetails {
  return {
    ...base,
    toolUses: record.toolUses,
    tokens: formatLifetimeTokens(record),
    // Raw, and unconditional: `tokens` is preformatted because it is one stat,
    // but a cost is joined by "·" in one surface, "," in another and "|" in a
    // third — so it travels as a number and each renderer punctuates its own.
    cost: getLifetimeCost(record.lifetimeUsage),
    turnCount: activity?.turnCount,
    maxTurns: activity?.maxTurns,
    durationMs: (record.completedAt ?? Date.now()) - record.startedAt,
    status: record.status as AgentDetails["status"],
    agentId: record.id,
    error: record.error,
    ...overrides,
  };
}

/**
 * Launch a detached resume of an existing agent and wire everything a
 * re-running agent needs: transcript anchoring, activity tracking, join-mode
 * batching, the widget/fleet refresh, and the `subagents:created` event.
 *
 * Shared by the Agent tool's `resume` + `run_in_background` branch and the
 * `@handle message` prompt mention — they differ only in how they report the
 * outcome. Returns the record, or undefined when the manager refused because
 * the agent is still running (see AgentManager.resume).
 *
 * Callers must have already established that the record has a session.
 */
export async function startBackgroundResume(
  rt: SubagentsRuntime,
  ctx: ExtensionContext,
  existing: AgentRecord,
  prompt: string,
  opts: {
    outputTranscript: boolean;
    maxTurns?: number | undefined;
    toolCallId?: string | undefined;
  },
): Promise<AgentRecord | undefined> {
  const id = existing.id;
  const joinMode = resolveJoinMode(rt.getDefaultJoinMode(), true);
  // Assigned unconditionally: the completion notification carries this as
  // `<tool-use-id>`, so a mention-resume (which passes none) has to CLEAR the
  // id left by the spawn that created the record. Keeping it would point the
  // orchestrator's new result at a tool call that was answered runs ago.
  existing.toolCallId = opts.toolCallId;
  if (joinMode) existing.joinMode = joinMode;
  // Reuse the agent's transcript rather than starting a fresh one: the
  // path is deterministic per agent+session, so writing an initial entry
  // would truncate the previous run's turns (see ensureOutputFile).
  if (opts.outputTranscript) {
    existing.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
    ensureOutputFile(existing.outputFile);
  }
  // Anchor streaming past the turns already on disk, captured BEFORE the
  // run starts. The resumed prompt lands as an ordinary user message at
  // this index, so it is written exactly once.
  const transcriptAnchor = existing.session?.messages.length ?? 0;

  const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(opts.maxTurns);
  // resumeAgent has no onSessionCreated — the session predates this run —
  // so seed it directly, or the widget shows no context % for the agent.
  bgState.session = existing.session;

  // No `signal`: a background spawn deliberately omits it, and a detached
  // resume must behave the same. Passing it would abort this agent when
  // the parent turn is interrupted (user Esc), while agents started with
  // run_in_background in that same turn keep going.
  const record = await rt.manager.resume(id, prompt, undefined, {
    isBackground: true,
    onToolActivity: bgCallbacks.onToolActivity,
    onAssistantUsage: bgCallbacks.onAssistantUsage,
    // Fires when the run actually starts — immediately, or on queue
    // drain. Wiring it here (rather than after resume() returns) means a
    // resume stopped while still queued never started streaming, so
    // there is no subscription left behind for a later run to trip over.
    onStarted: () => {
      const rec = rt.manager.getRecord(id);
      if (rec?.session && rec.outputFile) {
        rec.outputCleanup = streamToOutputFile(
          rec.session,
          rec.outputFile,
          id,
          ctx.cwd,
          transcriptAnchor,
        );
      }
    },
  });
  if (!record) return undefined;

  if (joinMode != null && joinMode !== "async") {
    rt.currentBatchAgents.push({ id, joinMode });
    if (rt.batchFinalizeTimer) clearTimeout(rt.batchFinalizeTimer);
    rt.batchFinalizeTimer = setTimeout(() => rt.finalizeBatch(), 100);
  }

  rt.agentActivity.set(id, bgState);
  // This agent already finished once, so the widget holds a finished-age
  // for it that is past the linger limit — without clearing it, the
  // resumed run's ✓/✗ line never renders and the agent just vanishes.
  rt.widget.markRunning(id);
  rt.ensureTimers();
  rt.widget.update();
  rt.fleet.update();

  // Resume ignores subagent_type (the record keeps the type it was
  // spawned with), so report the record's own identity — a "created"
  // event carrying the caller's type would re-register the agent under
  // the wrong one in cross-extension mirrors keyed by id.
  rt.pi.events.emit("subagents:created", {
    id,
    type: existing.type,
    description: existing.description,
    isBackground: true,
  });

  return record;
}

/** Plan computed once per `execute()` call, shared by the resume / background / foreground helpers. */
interface AgentSpawnPlan {
  subagentType: SubagentType;
  fallbackNote: string;
  displayName: string;
  // The resolved `Model` to run on — same loose typing `ctx.model` itself
  // carries through this file's other call sites.
  model: any;
  thinking: ThinkingLevel | undefined;
  inheritContext: boolean | undefined;
  isolated: boolean | undefined;
  isolation: any;
  effectiveMaxTurns: number | undefined;
  agentInvocation: AgentInvocation;
  detailBase: Pick<
    AgentDetails,
    "displayName" | "description" | "subagentType" | "modelName" | "tags"
  >;
  detailBaseFor: (rec: AgentRecord | undefined) => AgentSpawnPlan["detailBase"];
  outputTranscript: boolean;
  attachTranscript: (rec: AgentRecord | undefined, agentId: string) => void;
}

/** Result headline for the resume branch (both background and inline). */
async function handleResumePath(
  rt: SubagentsRuntime,
  ctx: ExtensionContext,
  toolCallId: string | undefined,
  signal: AbortSignal | undefined,
  params: Record<string, any>,
  plan: AgentSpawnPlan,
  runInBackground: boolean,
) {
  const existing = rt.manager.getRecord(params.resume);
  if (!existing || !isTopLevelAgent(existing)) {
    return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
  }
  if (!existing.session) {
    return textResult(`Agent "${params.resume}" has no active session to resume.`);
  }

  // Background resume: detached run that notifies on completion, mirroring
  // a background spawn. Previously run_in_background was silently ignored
  // on resume (this branch returned before the background branch below),
  // so a resumed agent always blocked the main loop until it finished.
  if (runInBackground) {
    const id = existing.id;
    // A detached resume hands control back while the record stays
    // "running", so nothing stops the model from resuming the same agent
    // again mid-run. manager.resume() refuses that (it would orphan the
    // live run's abort controller); say why here, where the model can act
    // on it, instead of letting it read as a generic failure.
    if (existing.status === "running" || existing.status === "queued") {
      return textResult(
        `Agent "${params.resume}" is still ${existing.status} — it can only be resumed once its current run finishes.\n` +
          `Use steer_subagent to send it a message mid-run, or get_subagent_result to wait for it.`,
      );
    }

    const record = await startBackgroundResume(rt, ctx, existing, params.prompt, {
      outputTranscript: plan.outputTranscript,
      maxTurns: plan.effectiveMaxTurns,
      toolCallId,
    });
    if (!record) {
      return textResult(`Failed to resume agent "${params.resume}".`);
    }

    const isQueued = record.status === "queued";
    return textResult(
      `Agent ${isQueued ? "queued" : "resumed"} in background.\n` +
        `Agent ID: ${id}\n` +
        `Type: ${existing.type}\n` +
        (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
        (isQueued ? `Position: queued (max ${rt.manager.getMaxConcurrent()} concurrent)\n` : "") +
        `\nYou will be notified when this agent completes.\n` +
        `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.`,
      {
        ...plan.detailBaseFor(record),
        toolUses: record.toolUses,
        tokens: "",
        durationMs: 0,
        status: "background" as const,
        agentId: id,
      },
    );
  }

  const record = await rt.manager.resume(params.resume, params.prompt, signal);
  if (!record) {
    return textResult(`Failed to resume agent "${params.resume}".`);
  }
  // A failed resume surfaces the error, plus any partial output THIS
  // resume produced (never the previous turn's answer, #144).
  if (record.status === "error") {
    return textResult(
      `Agent failed: ${record.error}${partialOutputSuffix(record)}`,
      buildDetails(plan.detailBaseFor(record), record),
    );
  }
  return textResult(
    record.result?.trim() || "No output.",
    buildDetails(plan.detailBaseFor(record), record),
  );
}

/** Background (detached) spawn — returns immediately with the agent's id. */
async function handleBackgroundSpawn(
  rt: SubagentsRuntime,
  ctx: ExtensionContext,
  toolCallId: string | undefined,
  params: Record<string, any>,
  plan: AgentSpawnPlan,
) {
  const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(plan.effectiveMaxTurns);

  // Wrap onSessionCreated to wire output file streaming.
  // The callback lazily reads record.outputFile (set right after spawn)
  // rather than closing over a value that doesn't exist yet.
  let id: string;
  const origBgOnSession = bgCallbacks.onSessionCreated;
  bgCallbacks.onSessionCreated = (session: any) => {
    origBgOnSession(session);
    const rec = rt.manager.getRecord(id);
    if (rec?.outputFile) {
      rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
    }
  };

  // A throw here means the agent never started. Let it out: pi marks a
  // tool call failed only when execute throws, and a returned message
  // reads to the model as a subagent that ran and reported this (#179).
  id = rt.manager.spawn(rt.pi, ctx, plan.subagentType, params.prompt, {
    description: params.description,
    name: params.name as string | undefined,
    model: plan.model,
    maxTurns: plan.effectiveMaxTurns,
    isolated: plan.isolated,
    inheritContext: plan.inheritContext,
    thinkingLevel: plan.thinking,
    isBackground: true,
    isolation: plan.isolation,
    invocation: plan.agentInvocation,
    rootSessionId: ctx.sessionManager.getSessionId(),
    ...bgCallbacks,
  });

  // Set output file + join mode synchronously after spawn, before the
  // event loop yields — onSessionCreated is async so this is safe.
  const joinMode = resolveJoinMode(rt.getDefaultJoinMode(), true);
  const record = rt.manager.getRecord(id);
  if (record && joinMode) {
    record.joinMode = joinMode;
    record.toolCallId = toolCallId;
    plan.attachTranscript(record, id);
  }

  // With isolation: "worktree" the agent isn't running yet — the repo
  // copy is an awaited git call. Wait for it here, after the synchronous
  // wiring above, so a strict-isolation failure still fails THIS tool
  // call instead of being reported as a subagent that ran (#179).
  await rt.manager.awaitStartup(id);

  if (joinMode == null || joinMode === "async") {
    // Foreground/no join mode or explicit async — not part of any batch
  } else {
    // smart or group — add to current batch
    rt.currentBatchAgents.push({ id, joinMode });
    // Debounce: reset timer on each new agent so parallel tool calls
    // dispatched across multiple event loop ticks are captured together
    if (rt.batchFinalizeTimer) clearTimeout(rt.batchFinalizeTimer);
    rt.batchFinalizeTimer = setTimeout(() => rt.finalizeBatch(), 100);
  }

  rt.agentActivity.set(id, bgState);
  rt.ensureTimers();
  rt.widget.update();
  rt.fleet.update();

  // Emit created event
  rt.pi.events.emit("subagents:created", {
    id,
    type: plan.subagentType,
    description: params.description,
    isBackground: true,
  });

  const isQueued = record?.status === "queued";
  return textResult(
    `${plan.fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
      `Agent ID: ${id}\n` +
      `Type: ${plan.displayName}\n` +
      `Description: ${params.description}\n` +
      (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
      (isQueued ? `Position: queued (max ${rt.manager.getMaxConcurrent()} concurrent)\n` : "") +
      `\nYou will be notified when this agent completes.\n` +
      `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
      `Do not duplicate this agent's work.`,
    {
      ...plan.detailBaseFor(record),
      toolUses: 0,
      tokens: "",
      durationMs: 0,
      status: "background" as const,
      agentId: id,
    },
  );
}

/** Foreground (synchronous) spawn — streams progress via `onUpdate` until the agent settles. */
async function handleForegroundSpawn(
  rt: SubagentsRuntime,
  ctx: ExtensionContext,
  toolCallId: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
  params: Record<string, any>,
  plan: AgentSpawnPlan,
) {
  let spinnerFrame = 0;
  const startedAt = Date.now();
  let fgId: string | undefined;
  // Set only while the spawn is parked on a foreground concurrency slot
  // (maxConcurrentForeground); undefined the rest of the time, including
  // always when the limit is unset.
  let queuedAhead: number | undefined;

  const streamUpdate = () => {
    // Spend from the record, everything else from the live tracker. `fgId`
    // is set in onSessionCreated below, which fires before the first
    // assistant message — so nothing is spent while this reads zero.
    const fgRecord = fgId ? rt.manager.getRecord(fgId) : undefined;
    const details: AgentDetails = {
      ...plan.detailBaseFor(fgRecord),
      toolUses: fgState.toolUses,
      tokens: fgRecord ? formatLifetimeTokens(fgRecord) : "",
      cost: fgRecord ? getLifetimeCost(fgRecord.lifetimeUsage) : 0,
      turnCount: fgState.turnCount,
      maxTurns: fgState.maxTurns,
      durationMs: Date.now() - startedAt,
      // Deliberately still "running" while queued: the renderer routes any
      // status it doesn't know to raw text (see the catch-all below), which
      // would drop the spinner and read as hung. Only the activity line
      // changes — "thinking…" would be a lie for an agent that has not
      // started and may not for minutes.
      status: "running",
      activity:
        queuedAhead === undefined
          ? describeActivity(fgState.activeTools, fgState.responseText)
          : `queued — waiting for a foreground slot${queuedAhead > 0 ? ` (${queuedAhead} ahead)` : ""}`,
      spinnerFrame: spinnerFrame % SPINNER.length,
    };
    onUpdate?.({
      content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
      details: details as any,
    });
  };

  const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(
    plan.effectiveMaxTurns,
    streamUpdate,
  );

  // Wire session creation: register in widget + stream to output file.
  // The output file path is set synchronously after spawn (below),
  // before onSessionCreated fires — same pattern as background agents.
  const origOnSession = fgCallbacks.onSessionCreated;
  fgCallbacks.onSessionCreated = (session: any) => {
    origOnSession(session);
    // It really started — stop reporting it as queued, and repaint now
    // rather than leaving the stale line up for the next spinner tick.
    // Guarded, so a spawn that never queued emits no extra update.
    if (queuedAhead !== undefined) {
      queuedAhead = undefined;
      streamUpdate();
    }
    for (const a of rt.manager.listAgents()) {
      if (a.session === session) {
        fgId = a.id;
        rt.agentActivity.set(a.id, fgState);
        rt.ensureTimers();
        rt.fleet.update();
        break;
      }
    }
    // Stream conversation to output file (foreground agent logging)
    if (fgId) {
      const rec = rt.manager.getRecord(fgId);
      if (rec?.outputFile) {
        rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
      }
    }
  };

  // Animate spinner at ~80ms (smooth rotation through 10 braille frames)
  const spinnerInterval = setInterval(() => {
    spinnerFrame++;
    streamUpdate();
  }, 80);

  streamUpdate();

  let record: AgentRecord;
  let detached = false;
  try {
    const fgResult = await rt.manager.spawnAndWait(
      rt.pi,
      ctx,
      plan.subagentType,
      params.prompt,
      {
        description: params.description,
        name: params.name as string | undefined,
        model: plan.model,
        maxTurns: plan.effectiveMaxTurns,
        isolated: plan.isolated,
        inheritContext: plan.inheritContext,
        thinkingLevel: plan.thinking,
        isolation: plan.isolation,
        invocation: plan.agentInvocation,
        signal,
        rootSessionId: ctx.sessionManager.getSessionId(),
        // Deliberately does NOT set fgId: that drives agentActivity, the
        // widget and the `finally` cleanup below, none of which should see an
        // agent that has no session and may never get one.
        onQueued: (_id, ahead) => {
          queuedAhead = ahead;
          streamUpdate();
        },
        ...fgCallbacks,
      },
      (fgAgentId) => {
        // onSpawned: called synchronously after spawn, before onSessionCreated fires.
        // Set up the output file so streamToOutputFile can pick it up.
        const fgRec = rt.manager.getRecord(fgAgentId);
        plan.attachTranscript(fgRec, fgAgentId);
      },
    );
    record = fgResult.record;
    detached = fgResult.detached;
  } finally {
    // Runs on both paths, so a startup throw — which now propagates, see
    // the background spawn above (#179) — no longer leaves the spinner
    // ticking or a finished agent on the widget.
    clearInterval(spinnerInterval);
    if (fgId) {
      rt.agentActivity.delete(fgId);
      rt.widget.markFinished(fgId);
      rt.fleet.onAgentFinished(fgId);
    }
  }

  // ctrl+b fired mid-run: the call returns now, the run keeps going
  // untouched, and its own completion notification fires later — the
  // same enrollment a background spawn does at spawn time (toolCallId
  // for notification linking, agentActivity + a cleared finished-age so
  // the widget keeps showing it as a live background row).
  if (detached) {
    record.toolCallId = toolCallId;
    if (fgId) {
      rt.agentActivity.set(fgId, fgState);
      rt.widget.markRunning(fgId);
      rt.ensureTimers();
    }
    rt.widget.update();
    rt.fleet.update();
    return textResult(
      `${plan.fallbackNote}Agent moved to background.\n` +
        `Agent ID: ${record.id}\n` +
        `Type: ${plan.displayName}\n` +
        `Description: ${params.description}\n` +
        (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
        `\nYou will be notified when this agent completes.\n` +
        `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.`,
      {
        ...plan.detailBaseFor(record),
        toolUses: fgState.toolUses,
        tokens: formatLifetimeTokens(record),
        durationMs: Date.now() - startedAt,
        status: "background" as const,
        agentId: record.id,
      },
    );
  }

  // Get final token count — from the record, like the cost below it, so the
  // two describe the same work when the agent delegated to nested children.
  const tokenText = formatLifetimeTokens(record);

  const details = buildDetails(plan.detailBaseFor(record), record, fgState, { tokens: tokenText });

  if (record.status === "error") {
    // Error headline + any partial output the run produced before failing.
    return textResult(
      `${plan.fallbackNote}Agent failed: ${record.error}${partialOutputSuffix(record)}`,
      details,
    );
  }

  const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
  const statsParts = [`${record.toolUses} tool uses`];
  if (tokenText) statsParts.push(tokenText);
  if (rt.isShowCostEnabled()) {
    const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
    if (costText) statsParts.push(costText);
  }
  return textResult(
    `${plan.fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status)}.\n\n` +
      (record.result?.trim() || "No output."),
    details,
  );
}

/**
 * Build and register the `Agent` tool. Returns both the bare tool definition
 * (used nowhere else) and the usage-reporting-wrapped one the `@handle`
 * mention clone calls (see mention-clone.ts's header for why it must be the
 * registered tool, not a second implementation).
 */
export function createAgentTool(rt: SubagentsRuntime) {
  // `isolationParam` drops the field from the schema when the project set
  // `worktreeIsolation: false`, so the prose has to go with it. Left in, it
  // would teach the model to pass a parameter that isn't declared — accepted
  // (TypeBox sets no `additionalProperties: false`) and then silently dropped
  // by the resolver. With no per-result note by design, the model would have
  // every reason to go on reporting a worktree path that was never created.
  const isolationGuideline = isWorktreeIsolationEnabled()
    ? `\n- Use isolation: "worktree" to give the agent its own git worktree (safe parallel file modifications); leave it unset, or pass "off", for none. The worktree is removed when the agent made no changes; if it made changes, the worktree is kept on disk, uncommitted, and its path is named in the result.`
    : "";

  const isolationCompactGuideline = isWorktreeIsolationEnabled()
    ? `\n- isolation: "worktree" gives the agent its own git worktree, removed if unchanged; if changed, kept uncommitted and its path named in the result.`
    : "";

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .agents/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parallel work: one message, multiple Agent calls — they run concurrently.
- Subagents run in the background by default; you'll be notified when one completes. Pass run_in_background: false only when your very next action depends on the result and nothing else could usefully happen while it runs. Never fabricate or predict a pending agent's results — if the user asks before the notification arrives, say it's still running.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.${isolationCompactGuideline}`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .agents/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Workspace-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently. If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
- Agents run in the background by default. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Pass \`run_in_background: false\` only when your very next action depends on the agent's result and nothing else could usefully happen while it runs — e.g., a research agent whose finding gates the edit you're about to make. Otherwise let it run in the background (the default) — this includes fire-and-forget work, independent investigations, and anything where the user might hand you something else in the meantime. Wanting the result "next" is not enough on its own.
- **Don't race**: after launching a background agent, you know nothing about its results. Never fabricate or predict them in any format — not as prose, summary, or structured output. The completion notification arrives in a later turn; it is never something you write yourself. If the user asks before it lands, say the agent is still running — give status, not a guess.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.${isolationGuideline}

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  // `toolDescriptionMode: "custom"` — user-authored description with live
  // dynamic parts; missing/empty falls back to "full" (a stale fallback beats
  // a blank tool description). Only the prose is customizable — the parameter
  // schema stays code-owned.
  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      isolationGuideline: () => isolationGuideline,
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(
        `[jpi-subagents] agent-tool-description.md: unknown placeholder ${raw} left as-is`,
      );
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    const path = join(getAgentDir(), "agent-tool-description.md");
    try {
      if (!existsSync(path)) return undefined;
      const text = readFileSync(path, "utf-8").trim();
      if (text) return renderToolDescriptionTemplate(text);
      console.warn(`[jpi-subagents] ${path} is empty — ignoring`);
    } catch (err) {
      console.warn(`[jpi-subagents] failed to read ${path}: ${errorMessage(err)}`);
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = rt.getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn(
        '[jpi-subagents] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"',
      );
    }
    return fullAgentToolDescription;
  })();

  const agentTool = defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    // Unset defaults to "default": pi wraps the whole tool in a Box(1,1)
    // painted with the tool*Bg tokens regardless of custom renderCall/
    // renderResult (ToolExecutionComponent.getRenderShell()). With the jpi
    // theme those tokens are "", so the tint is invisible, but the Box still
    // pads a blank line above/below and indents the content — this opts out.
    renderShell: "self",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      name: Type.Optional(
        Type.String({
          description:
            'Optional memorable name for this agent, e.g. "auth-audit", so it can be addressed as `@name` at the prompt and by steer_subagent / get_subagent_result. Letters, digits, `_` and `-`. Worth setting when several agents of the same type run at once; omit for one-off work. The agent stays reachable by its type either way.',
        }),
      ),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .agents/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides agent default.`,
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description:
            "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description:
            "Defaults to true — the agent runs detached, returning its ID immediately, and you are notified on completion. Set false only when your very next action depends on the result; the call then blocks and returns the agent's full output inline.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description:
            "Optional agent ID to resume from. Continues from previous context. Resumes detached like any other spawn; pass run_in_background: false to block and get the result inline. An agent can only be resumed once its current run has finished — use steer_subagent to reach one mid-run.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description:
            "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
      ...isolationParam(isWorktreeIsolationEnabled()),
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme, context) {
      const name = renderAgentName(args.subagent_type, theme, {
        fallbackColor: "toolTitle",
        bold: true,
      });
      const desc = args.description ?? "";
      return createAgentCallHeader(bulletState(context), name, desc, theme, context.lastComponent);
    },

    renderResult(result, { expanded, isPartial }, theme, renderContext) {
      const details = result.details as AgentDetails | undefined;
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      // Pi reports pre-execution failures (extension block, abort, argument
      // validation) as `{ content: [reason], details: {} }` with isError set —
      // no status to render, so show the reason instead of inventing one (#199).
      if (renderContext.isError || !details?.status) {
        return new Text(text, 0, 0);
      }

      // Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(d.modelName);
        if (d.tags) parts.push(...d.tags);
        if (d.turnCount != null && d.turnCount > 0) {
          parts.push(formatTurns(d.turnCount, d.maxTurns));
        }
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        if (rt.isShowCostEnabled()) {
          const costText = formatCost(d.cost ?? 0);
          if (costText) parts.push(costText);
        }
        return parts
          .map((p) => fgPreservingNestedStyles(theme, "dim", p))
          .join(" " + theme.fg("dim", "·") + " ");
      };

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0]!;
        const s = stats(details);
        return renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
      }

      // ---- Background agent launched ----
      if (details.status === "background") {
        return createResultLine(`Running in background (ID: ${details.agentId})`, theme);
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let statusLine = icon + (s ? " " + s : "");
        statusLine += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        const container = new Container();
        container.addChild(new Text(statusLine, 0, 0));

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            const detailLines = lines.map((l) => theme.fg("dim", `  ${l}`));
            if (resultText.split("\n").length > 50) {
              detailLines.push(
                theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)"),
              );
            }
            container.addChild(new Text(detailLines.join("\n"), 0, 0));
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          container.addChild(createResultLine(doneText, theme));
        }
        return container;
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        const s = stats(details);
        const statusLine = theme.fg("dim", "■") + (s ? " " + s : "");
        const container = new Container();
        container.addChild(new Text(statusLine, 0, 0));
        container.addChild(createResultLine("Stopped", theme));
        return container;
      }

      // Anything left ("queued", or a status added later) has no rendering of
      // its own — the turn-limit wording below must not be the catch-all.
      if (details.status !== "error" && details.status !== "aborted") {
        return new Text(text, 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      const s = stats(details);
      const statusLine = theme.fg("error", "✗") + (s ? " " + s : "");
      const container = new Container();
      container.addChild(new Text(statusLine, 0, 0));

      if (details.status === "error") {
        container.addChild(
          createResultLine(`Error: ${details.error ?? "unknown"}`, theme, "error"),
        );
      } else {
        container.addChild(createResultLine("Aborted (max turns exceeded)", theme, "warning"));
      }

      return container;
    },

    // ---- Execute ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      // Ensure we have UI context for widget rendering
      rt.widget.setUICtx(ctx.ui as UICtx);

      // Reload custom agents so new project/global .md files are picked up without restart
      rt.reloadCustomAgents();

      const rawType = params.subagent_type as SubagentType;
      // Single decision point for dispatch (#183): unknown, disabled and
      // case-ambiguous types are refused here, BEFORE anything spawns, so a
      // background call can't start running the wrong agent while the caller
      // is still unaware. `fallbackSubagent` decides whether an unresolvable
      // type falls back or fails closed.
      const dispatch = resolveSpawnType(rawType);
      // `resume` replays a stored session and ignores `subagent_type` entirely,
      // but the parameter is required by the schema — so gating it here would
      // make a live agent unresumable the moment its type is deleted, disabled,
      // or gains a case-clashing sibling. Only a real spawn is gated.
      if (!dispatch.ok && !params.resume) return textResult(dispatch.message);
      const subagentType = dispatch.ok ? dispatch.type : rawType;
      // Resume deliberately gets no note: it replays the stored session and
      // ignores `subagent_type` entirely, so a note about type substitution
      // would be describing something that didn't happen.
      const fallbackNote =
        dispatch.ok && dispatch.fellBackFrom !== undefined
          ? `Note: Unknown agent type "${dispatch.fellBackFrom}" — using ${resolveType(subagentType) ? subagentType : "the fallback agent config"}.\n\n`
          : "";

      const displayName = getDisplayName(subagentType);

      // Get agent config (if any)
      const customConfig = getAgentConfig(subagentType);

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: rt.getBackgroundByDefault(),
      });

      // Resolve model from agent config first; tool-call params only fill gaps.
      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") {
          if (resolvedConfig.modelFromParams) return textResult(resolved);
          // config-specified: silent fallback to parent
        } else {
          model = resolved;
        }
      }

      // Scope validation: the effective resolved model is checked against the
      // user's enabledModels list. Policy (hard error vs warn-and-proceed) lives
      // in model-scope.ts so the nested delegation tools apply the same rule.
      const scopeVerdict = checkModelScope({
        model,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: resolvedConfig.modelFromParams,
        agentLabel: customConfig?.displayName ?? subagentType,
        modelInput: resolvedConfig.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message);
      if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;
      // Whether this spawn writes its .output transcript. Per-agent
      // frontmatter (`output_transcript`) wins; otherwise the project/global
      // default applies. `attachTranscript` below is the SOLE gate — every
      // downstream consumer keys off record.outputFile being set, so no spawn
      // path can re-enable the transcript by accident.
      const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt, ctx.cwd);
      };

      // Unconditional, not "only when it differs from the parent": a thinking
      // level reads as a property of a model, and an agent that inherited the
      // parent's model used to show the level with nothing to attach it to.
      // This is the pre-session snapshot — agent-manager overwrites it with the
      // effective values the moment a session reports them.
      const { modelName, modelId } = model
        ? describeModel(model)
        : { modelName: undefined, modelId: undefined };
      // What the caller SPELLED, kept only if it names a different model than the
      // one that won. Model input is fuzzy — `"haiku"` and
      // `"anthropic/claude-haiku-4-5"` are the same model — so comparing the two
      // strings would disclose an override that never happened. A spelling that
      // resolves to nothing is still worth disclosing: it cannot have taken effect.
      const askedModel = ((asked: string | undefined) => {
        if (!asked) return undefined;
        const resolvedAsked = resolveModel(asked, ctx.modelRegistry);
        if (typeof resolvedAsked === "string") return asked;
        return resolvedAsked.provider === model?.provider && resolvedAsked.id === model?.id
          ? undefined
          : asked;
      })(resolvedConfig.overridden?.model);
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const agentInvocation: AgentInvocation = {
        modelName,
        modelId,
        thinking,
        // Only set where the agent file outranked the caller, so the surfaces can
        // disclose a parameter that was accepted but could not take effect (#182).
        requestedThinking: resolvedConfig.overridden?.thinking,
        requestedModel: askedModel,
        // Explicit value only — the default fallback would just add noise.
        // Normalize so `0` (unlimited) doesn't surface as a misleading "max turns: 0".
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        inheritContext,
        runInBackground,
        isolation,
      };
      const { tags: invocationTags } = buildInvocationTags(agentInvocation);
      const detailBase = {
        displayName,
        description: params.description,
        subagentType,
        modelName,
        tags: invocationTags.length > 0 ? invocationTags : undefined,
      };

      /**
       * `detailBase` for a record that exists, which outranks it: the base is a
       * snapshot of what this call REQUESTED, and pi may have resolved a
       * different model or clamped the thinking level (agent-manager writes the
       * effective values back when the session reports them). Resume goes
       * further and ignores the model/thinking parameters outright — it runs on
       * the session it is reopening — so rendering the base there advertises
       * settings the run never used.
       */
      const detailBaseFor = (rec: AgentRecord | undefined): typeof detailBase => {
        if (!rec?.invocation) return detailBase;
        const type = rec.type;
        const { modelName: recModelName, tags } = buildInvocationTags(rec.invocation);
        return {
          displayName: getDisplayName(type),
          description: rec.description,
          subagentType: type,
          modelName: recModelName,
          tags: tags.length > 0 ? tags : undefined,
        };
      };

      const plan: AgentSpawnPlan = {
        subagentType,
        fallbackNote,
        displayName,
        model,
        thinking,
        inheritContext,
        isolated,
        isolation,
        effectiveMaxTurns,
        agentInvocation,
        detailBase,
        detailBaseFor,
        outputTranscript,
        attachTranscript,
      };

      // Resume existing agent
      if (params.resume) {
        return handleResumePath(rt, ctx, toolCallId, signal, params, plan, runInBackground);
      }

      // Background execution
      if (runInBackground) {
        return handleBackgroundSpawn(rt, ctx, toolCallId, params, plan);
      }

      // Foreground (synchronous) execution — stream progress via onUpdate
      return handleForegroundSpawn(rt, ctx, toolCallId, signal, onUpdate, params, plan);
    },
  });

  const registeredAgentTool = rt.registerToolReportingUsage(agentTool);

  return { agentTool, registeredAgentTool };
}
