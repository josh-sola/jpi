/**
 * pi-agents — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 *
 * This file builds the shared runtime state ONCE (`rt`, a `SubagentsRuntime`)
 * and wires each concern's module against it — the Agent tool (agent-tool.ts),
 * get_subagent_result/steer_subagent (result-tools.ts), the cross-extension RPC
 * handlers (rpc-handlers.ts), the completion notifications (notifications.ts)
 * and the `/agents` menu (agents-menu.ts). What stays here is what has to:
 * session lifecycle, `@handle` mentions, the manager/widget/fleet construction,
 * and the settings this module owns directly.
 */

import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { errorMessage } from "../../src/core/index.ts";
import type { ModuleContext } from "../../src/core/module.ts";
import { AgentManager, isTopLevelAgent } from "./agent-manager.ts";
import {
  getDefaultMaxTurns,
  getGraceTurns,
  getRememberAgents,
  normalizeMaxTurns,
  resolveEffectiveMaxTurns,
  setDefaultMaxTurns,
  setGraceTurns,
  setRememberAgents,
} from "./agent-runner.ts";
import {
  createActivityTracker,
  createAgentTool,
  renderRunningAgentStatus,
  startBackgroundResume,
} from "./agent-tool.ts";
export { renderRunningAgentStatus };
import {
  getAgentConfig,
  getAvailableTypes,
  getConfig,
  getFallbackSubagent,
  isDefaultsDisabled,
  NO_FALLBACK,
  registerAgents,
  resolveSpawnType,
  setDefaultsDisabled,
  setFallbackSubagent,
} from "./agent-types.ts";
import { wireAgentsMenu } from "./agents-menu.ts";
import { inChildSessionContext } from "./child-context.ts";
import { loadCustomAgents } from "./custom-agents.ts";
import { wireFleetFooterProvider } from "./fleet-footer-bridge.ts";
import type { GroupJoinManager } from "./group-join.ts";
import { resolveKeyId } from "./key-id.ts";
import {
  describeMention,
  handleBase,
  isReservedHandle,
  parseMention,
  resolveHandleToType,
  stripAgentPrefix,
} from "./mention.ts";
import { runMentionClone } from "./mention-clone.ts";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "./model-scope.ts";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "./nested-tools.ts";
import { wireNotifications } from "./notifications.ts";
import { getOutputTranscriptDefault, setOutputTranscriptDefault } from "./output-file.ts";
import { unwireRpcHandlers, wireRpcHandlers, type RpcHandle } from "./rpc-handlers.ts";
import { wireResultTools } from "./result-tools.ts";
import {
  applySettings,
  type SubagentsSchema,
  type SubagentsSettings,
  saveAndEmitChanged,
  type ToolDescriptionMode,
} from "./settings.ts";
import type {
  AgentMentionMode,
  AgentRecord,
  JoinMode,
  ViewerMarkdownMode,
  WidgetMode,
} from "./types.ts";
import { createMentionProvider, mentionRoster, type TypeInfo } from "./ui/agent-mention.ts";
import { type AgentActivity, AgentWidget, type UICtx } from "./ui/agent-widget.ts";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.ts";
import { getLifetimeTotal, PendingUsagePool, toReportedUsage } from "./usage.ts";
import {
  getWorktreeCleanupPeriodDays,
  isWorktreeIsolationEnabled,
  setWorktreeCleanupPeriodDays,
  setWorktreeIsolationEnabled,
} from "./worktree.ts";

// ---- Shared runtime context ----

/**
 * Shared mutable state and cross-cutting operations, built once in
 * `setupSubagents` and threaded explicitly into agent-tool.ts, result-tools.ts,
 * rpc-handlers.ts, notifications.ts and agents-menu.ts — instead of
 * re-plumbing a dozen positional parameters through each of them.
 *
 * Most fields are plain closures over `let` state declared in `setupSubagents`
 * (matching the module's previous single-function shape); only
 * `currentBatchAgents`/`batchFinalizeTimer` are genuine mutable properties,
 * since agent-tool.ts's background-spawn and resume paths push/reassign them
 * directly. `groupJoin`/`scheduleNudge`/`cancelNudge`/`sendIndividualNudge`/
 * `disposeNudges` are optional because `wireNotifications` populates them
 * partway through setup — every caller of those five runs only after setup
 * has finished, so a non-null assertion at the call site is safe.
 */
export interface SubagentsRuntime {
  readonly pi: ExtensionAPI;
  readonly moduleCtx: ModuleContext<SubagentsSchema>;
  readonly manager: AgentManager;
  readonly agentActivity: Map<string, AgentActivity>;
  readonly widget: AgentWidget;
  readonly fleet: FleetList;
  readonly pendingUsage: PendingUsagePool;

  /** The active session's ExtensionContext, or undefined between sessions. */
  getCurrentCtx(): ExtensionContext | undefined;

  /** Reload agents from project/global custom agent dirs and merge with defaults. */
  reloadCustomAgents(strict?: boolean): void;

  /**
   * Resolve a tool's `agent_id` as an id OR a handle, so the model addresses
   * agents by the same names the user types. Only live records — a tombstone
   * has nothing to steer or read.
   */
  resolveAgentRef(ref: string): AgentRecord | undefined;

  /** Resolve the agent type and spawn. Trusts its options — every caller must be in-process or gone through `spawnTopLevel` first. */
  spawnResolved(piRef: any, ctxRef: any, type: string, prompt: string, options: any): string;
  /** `spawnResolved`, with the internal-only options a caller must never forge stripped first. */
  spawnTopLevel(piRef: any, ctxRef: any, type: string, prompt: string, options: any): string;

  /** `widget.ensureTimer(); fleet.ensureTimer();` — the pairing repeated at every spawn/resume site. */
  ensureTimers(): void;

  // ---- batch tracking for smart join mode ----
  currentBatchAgents: { id: string; joinMode: JoinMode }[];
  batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
  finalizeBatch(): void;

  /** Wrap a tool so its results carry back pending subagent spend, register it, and return the wrapped tool. */
  registerToolReportingUsage<T extends { execute: (...args: any[]) => any }>(tool: T): T;

  // ---- notifications — populated by wireNotifications ----
  groupJoin?: GroupJoinManager;
  scheduleNudge?(key: string, send: () => void, delay?: number): void;
  cancelNudge?(key: string): void;
  sendIndividualNudge?(record: AgentRecord): void;
  disposeNudges?(): void;

  // ---- settings this module owns as local state ----
  getStrictAgentFiles(): boolean;
  setStrictAgentFiles(b: boolean): void;
  isReportUsageEnabled(): boolean;
  setReportUsage(b: boolean): void;
  isShowCostEnabled(): boolean;
  setShowCost(b: boolean): void;
  isShowModelEnabled(): boolean;
  setShowModel(b: boolean): void;
  getViewerMarkdown(): ViewerMarkdownMode;
  setViewerMarkdown(mode: ViewerMarkdownMode): void;
  chooseViewerMarkdown(mode: ViewerMarkdownMode, ctx?: ExtensionCommandContext): void;
  getWidgetMode(): WidgetMode;
  setWidgetMode(mode: WidgetMode): void;
  isFleetViewEnabled(): boolean;
  setFleetViewEnabled(b: boolean): void;
  getAgentMentionMode(): AgentMentionMode;
  setAgentMentionMode(mode: AgentMentionMode): void;
  getDefaultJoinMode(): JoinMode;
  setDefaultJoinMode(mode: JoinMode): void;
  getBackgroundByDefault(): boolean;
  setBackgroundByDefault(b: boolean): void;
  setDisableDefaultAgents(b: boolean): void;
  getToolDescriptionMode(): ToolDescriptionMode;
  setToolDescriptionMode(mode: ToolDescriptionMode): void;

  /** Persist settings, silent on success; warns via `ctx` only on a failed write. */
  persistSettings(ctx: ExtensionCommandContext | undefined, changeMsg: string): Promise<void>;
  /** Persist settings and always notify `ctx` with the outcome. */
  notifyApplied(ctx: ExtensionCommandContext, successMsg: string): Promise<void>;
}

// ---- Shared helpers ----

/** Default `background-shortcut` — also the fallback for an unparseable configured value. */
const DEFAULT_BACKGROUND_SHORTCUT = "ctrl+b";

/** Helper: build event data for lifecycle events from an AgentRecord. */
function buildEventData(record: AgentRecord) {
  const durationMs = record.completedAt
    ? record.completedAt - record.startedAt
    : Date.now() - record.startedAt;
  // All three fields are lifetime-accumulated (Σ over every assistant message_end),
  // so they survive compaction together — input + output ≤ total always.
  // tokens is omitted when nothing was ever produced (e.g. agent errored before
  // any message_end fired), preserving prior payload shape.
  const u = record.lifetimeUsage;
  const total = getLifetimeTotal(u);
  const tokens = total > 0 ? { input: u.input, output: u.output, total } : undefined;
  // The whole run's spend as a pi `Usage` — pi's convention for handing spend
  // to a consumer, so `usage.cost.total` and `usage.cacheRead` are where a
  // listener already expects them and anything pi adds to `Usage` arrives
  // without a change here. Omitted when nothing was spent, so "spent nothing"
  // and "never ran" stay distinguishable. Ungated by `showCost`: that setting
  // governs what a human is shown, not what the event carries.
  //
  // `tokens` above is the other convention, kept as it shipped: a flat view
  // model like pi's own `SessionStats`, carrying the DISPLAY total, which
  // excludes cacheRead (#38). The two answer different questions and neither
  // derives from the other.
  const usage = toReportedUsage(u);
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    result: record.result,
    error: record.error,
    status: record.status,
    toolUses: record.toolUses,
    durationMs,
    tokens,
    usage,
  };
}

/**
 * The subagents module's `setup`, wired into the `JpiModule` contract by
 * `module.ts`. Named `moduleCtx`, not `ctx` — many handlers below take their
 * own per-call `ctx: ExtensionCommandContext`, and this outer one must stay
 * reachable rather than shadowed by those.
 */
export default async function setupSubagents(
  pi: ExtensionAPI,
  moduleCtx: ModuleContext<SubagentsSchema>,
): Promise<void> {
  // Child AgentSessions load normal extensions. Re-entering this extension there
  // would create another manager and leak handlers. Nested orchestration is
  // injected as scoped custom tools by the existing manager instead.
  if (inChildSessionContext()) return;

  // The loader already loaded this before calling setup() — reused here (and by
  // the applySettings call further down) rather than reading jpi.kdl again. Load
  // issues are surfaced once, centrally, by the loader itself.
  const loadedSettings = moduleCtx.value;
  let strictAgentFiles = loadedSettings.strictAgentFiles;

  /** Reload agents from project/global custom agent dirs and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = (strict = false) => {
    const userAgents = loadCustomAgents(process.cwd(), strict);
    registerAgents(userAgents);
  };

  // Initial load — the only strict one. A bad edit mid-session must not kill the
  // session on the next unrelated spawn, so every later reload keeps warning.
  reloadCustomAgents(strictAgentFiles);

  // ---- Agent activity tracking + widget ----
  const agentActivity = new Map<string, AgentActivity>();

  // ---- Usage reporting (both off by default; see SubagentsSettings) ----
  /** Attach subagent spend to tool results, so the parent session counts it. */
  let reportUsage = false;
  function isReportUsageEnabled(): boolean {
    return reportUsage;
  }
  function setReportUsage(b: boolean): void {
    reportUsage = b;
    // Whatever accumulated while it was on is stale the moment it goes off:
    // draining it later would bill the parent for a window the user opted out
    // of, in one lump, on some unrelated later tool call.
    if (!b) pendingUsage.drain();
  }
  /** Show `~$X` next to token counts in the subagent surfaces. */
  let showCost = false;
  function isShowCostEnabled(): boolean {
    return showCost;
  }
  function setShowCost(b: boolean): void {
    showCost = b;
    widget.update();
    fleet.update();
  }
  /** Name the model and thinking level on the widget's running rows. */
  let showModel = false;
  function isShowModelEnabled(): boolean {
    return showModel;
  }
  function setShowModel(b: boolean): void {
    showModel = b;
    widget.update();
  }
  /**
   * How much of the conversation viewer renders as Markdown. Read through a
   * getter by the viewer rather than captured like `showCost`, because the
   * viewer's `m` key writes back here while the overlay is on screen.
   */
  let viewerMarkdown: ViewerMarkdownMode = "assistant";
  function getViewerMarkdown(): ViewerMarkdownMode {
    return viewerMarkdown;
  }
  function setViewerMarkdown(mode: ViewerMarkdownMode): void {
    viewerMarkdown = mode;
  }
  /**
   * The viewer's `m` key, from either entry point: set the mode and persist it,
   * so the key and `/agents → Settings` stay one setting rather than one per
   * entry point. `ctx` carries only the warning a failed write notifies with,
   * and the fleet list may be acting without one.
   */
  function chooseViewerMarkdown(mode: ViewerMarkdownMode, ctx?: ExtensionCommandContext): void {
    setViewerMarkdown(mode);
    void persistSettings(ctx, `Viewer markdown set to ${mode}`);
  }
  /** Key that converts every currently-blocking top-level `Agent` call to background (ctrl+b). */
  let backgroundShortcut = DEFAULT_BACKGROUND_SHORTCUT;
  function getBackgroundShortcut(): string {
    return backgroundShortcut;
  }
  function setBackgroundShortcut(keyId: string): void {
    backgroundShortcut = resolveKeyId(keyId, DEFAULT_BACKGROUND_SHORTCUT);
  }
  const pendingUsage = new PendingUsagePool();

  // Background completion: route through group join or send individual nudge
  const manager = new AgentManager(
    (record) => {
      // Owned children — nested — report only through their owner: the
      // parent's scoped tools. Keep them out of top-level lifecycle,
      // transcript, notification, and UI channels.
      if (!isTopLevelAgent(record)) return;

      // Emit lifecycle event based on terminal status
      const isError =
        record.status === "error" || record.status === "stopped" || record.status === "aborted";
      const eventData = buildEventData(record);
      if (isError) {
        pi.events.emit("subagents:failed", eventData);
      } else {
        pi.events.emit("subagents:completed", eventData);
      }

      // Persist final record for cross-extension history reconstruction
      pi.appendEntry("subagents:record", {
        id: record.id,
        type: record.type,
        description: record.description,
        status: record.status,
        result: record.result,
        error: record.error,
        startedAt: record.startedAt,
        completedAt: record.completedAt,
      });

      // Skip notification if result was already consumed via get_subagent_result
      if (record.resultConsumed) {
        agentActivity.delete(record.id);
        widget.markFinished(record.id);
        fleet.onAgentFinished(record.id);
        widget.update();
        return;
      }

      // If this agent is pending batch finalization (debounce window still open),
      // don't send an individual nudge — finalizeBatch will pick it up retroactively.
      if (rt.currentBatchAgents.some((a) => a.id === record.id)) {
        widget.update();
        return;
      }

      const result = rt.groupJoin!.onAgentComplete(record);
      if (result === "pass") {
        rt.sendIndividualNudge!(record);
      }
      // 'held' → do nothing, group will fire later
      // 'delivered' → group callback already fired
      widget.update();
    },
    undefined,
    (record) => {
      if (!isTopLevelAgent(record)) return;
      // Agent-tool spawns refresh these surfaces in their tool handler, but RPC
      // spawns enter through the manager directly.
      if (currentCtx?.hasUI) {
        ensureTimers();
        widget.update();
        fleet.update();
      }
      // Emit started event when agent transitions to running (including from queue)
      pi.events.emit("subagents:started", {
        id: record.id,
        type: record.type,
        description: record.description,
      });
    },
    (record, info) => {
      if (!isTopLevelAgent(record)) return;
      // Emit compacted event when agent's session compacts (preserves count on record).
      pi.events.emit("subagents:compacted", {
        id: record.id,
        type: record.type,
        description: record.description,
        reason: info.reason,
        tokensBefore: info.tokensBefore,
        compactionCount: record.compactionCount,
      });
    },
    (_record, usage) => {
      // Every assistant message from every agent — nested included, exactly once.
      // Parked here until a tool result can carry it back to the parent session;
      // see `PendingUsagePool`. Skipped entirely when the feature is off, so no
      // pool grows in a session that will never drain it.
      if (reportUsage) pendingUsage.add(usage);
    },
  );

  /** `widget.ensureTimer(); fleet.ensureTimer();` — repeated at every spawn/resume site. */
  function ensureTimers(): void {
    widget.ensureTimer();
    fleet.ensureTimer();
  }

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  //
  // Claim the slot only if it's free: subagent sessions re-activate this
  // extension in the same process (session.bindExtensions in agent-runner.ts),
  // and unconditionally overwriting would point the registry at a short-lived
  // child manager — and the child's shutdown would then delete the root
  // session's entry. The first activation (the root session) wins; child
  // activations leave it alone.
  const MANAGER_KEY = Symbol.for("pi-subagents:manager");
  // Process-external callers may supply arbitrary options. Nested ownership and
  // config-root metadata are internal capabilities issued only by scoped tools.
  /**
   * Resolve the agent type and spawn. Trusts its options — every caller must
   * either be in-process or have gone through `spawnTopLevel` first.
   */
  const spawnResolved = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    // Cross-extension callers get the same dispatch contract as the LLM (#183).
    // The RPC layer already throws for an unresolvable model rather than falling
    // back silently; a bad agent type should not be quieter. Throws become error
    // envelopes at the RPC boundary. Reload first so an agent file added mid
    // session is spawnable here too, not only through the Agent tool.
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    // Every programmatic spawn lands here — cross-extension RPC, both `@handle`
    // mention paths, and the `Symbol.for("pi-subagents:manager")` registry — and
    // none came through the Agent tool, which is where the UI activity tracker is
    // otherwise created. Without one the widget and FleetView have no tool name
    // and no turn count, so the row reads `thinking…` for the agent's whole life
    // while the header's tool-use count climbs beside it (#181). Double-tracking
    // is not possible: the Agent tool calls `manager.spawn` directly. The tracker
    // callbacks are the funnel's own — a caller's are not honoured, since a
    // half-wired tracker renders worse than none.
    //
    // The turn limit is resolved rather than read off `options`, which a mention
    // spawn deliberately omits so the agent's own config can decide: a tracker
    // built with `undefined` renders `↻3` where the Agent tool renders `↻3≤20`.
    // Like the tool's own, it is a prediction — editing the agent file mid-run
    // leaves the displayed ceiling stale.
    const { state, callbacks } = createActivityTracker(
      resolveEffectiveMaxTurns(dispatch.type, options?.maxTurns),
    );
    // Repaints are left to the manager's `onStart` callback, which already starts
    // the widget/fleet timers for agents that enter this way.
    const id = manager.spawn(piRef, ctxRef, dispatch.type, prompt, { ...options, ...callbacks });
    agentActivity.set(id, state);
    return id;
  };

  const spawnTopLevel = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    const safeOptions = { ...options };
    delete safeOptions.parentAgentId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    // Also internal: it names a transcript directory, so a forged value would
    // be a path-traversal primitive.
    delete safeOptions.rootSessionId;
    // Worse than rootSessionId: this one names a file to OPEN and replay as a
    // conversation. Only the mention dispatcher may set it, and only from a
    // path this extension itself recorded — never from anything a caller sent.
    delete safeOptions.resumeSessionFile;
    // Bypasses handle allocation, so a forged value would duplicate a live
    // agent's name and make `@handle` ambiguous. Same rule: dispatcher only.
    delete safeOptions.reclaim;
    // Every spawn through here is DETACHED — the caller gets an id back and
    // awaits nothing. A forged `blocking` would charge it to the foreground
    // pool and could defer it behind a queue whose gate nobody is holding.
    delete safeOptions.blocking;
    return spawnResolved(piRef, ctxRef, type, prompt, safeOptions);
  };

  /**
   * Resolve a tool's `agent_id` as an id OR a handle, so the model addresses
   * agents by the same names the user types. Ids are tried first, keeping the
   * existing behaviour exact — a handle is only consulted when the string is
   * not an id at all. Only live records: a tombstone has nothing to steer and
   * no result to read. Callers still enforce the nested-ownership rejection.
   */
  const resolveAgentRef = (ref: string): AgentRecord | undefined => {
    const byId = manager.getRecord(ref);
    if (byId) return byId;
    const resolved = manager.resolveMention(ref);
    return resolved?.kind === "live" ? resolved.record : undefined;
  };

  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: spawnTopLevel,
    getRecord: (id: string) => {
      const record = manager.getRecord(id);
      return record !== undefined && isTopLevelAgent(record) ? record : undefined;
    },
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  // RPC handlers + the `subagents:ready` broadcast are wired on `session_start`
  // (a bound lifecycle event), not at factory time. pi runs every extension
  // factory before the `extensions:` filter and only fires lifecycle events for
  // survivors, so a child session that filtered pi-subagents out never reaches
  // session_start — and must not advertise or answer RPC it can't service
  // (currentCtx would stay undefined → spawn always "No active session"). Gating
  // here makes a filtered session behave like an absent one (#142).
  let rpcHandle: RpcHandle | undefined;
  /** Whether the `@handle` autocomplete wrapper has been stacked on pi's provider. */
  let mentionProviderRegistered = false;
  /** Whether the fleet-footer provider handshake (`fleet-footer-bridge.js`) has been wired. */
  let fleetBridgeWired = false;

  // Claim widget/fleet before `rt` — their constructors need `manager` and
  // `agentActivity`, already built above; `rt` needs them, built next.
  // ---- Live widget: show running agents above editor. ----
  // widgetMode (default "background") selects what the widget shows: "all" =
  // every agent; "background" = hide foreground (they already render inline as
  // the Agent tool result, so showing them here too is a duplicate, #118), keep
  // everything else; "off" = hide the widget entirely. Read live at render time.
  let widgetMode: WidgetMode = "background";
  function getWidgetMode(): WidgetMode {
    return widgetMode;
  }
  const widget = new AgentWidget(
    manager,
    agentActivity,
    getWidgetMode,
    isShowCostEnabled,
    isShowModelEnabled,
  );
  function setWidgetMode(m: WidgetMode): void {
    widgetMode = m;
    widget.update();
  }

  // Claude Code-style FleetView: navigable list of main + subagents below the editor.
  // The last two arguments keep a conversation overlay opened here identical to
  // one opened from `/agents`: same setting on the way in, same persist out.
  const fleet = new FleetList(
    manager,
    agentActivity,
    isShowCostEnabled,
    getViewerMarkdown,
    (mode) =>
      chooseViewerMarkdown(mode, currentCtx as unknown as ExtensionCommandContext | undefined),
  );
  let fleetViewEnabled = true;
  function isFleetViewEnabled(): boolean {
    return fleetViewEnabled;
  }
  function setFleetViewEnabled(b: boolean): void {
    fleetViewEnabled = b;
    fleet.setEnabled(b);
  }

  /**
   * ctrl+b (configurable): convert every currently-blocking top-level `Agent`
   * call into a background one. Only consumes the key when it actually detached
   * something — otherwise the key must fall through untouched, since ctrl+b has
   * no other meaning here and the editor may want it.
   */
  function handleBackgroundShortcut(data: string): { consume?: boolean } | undefined {
    if (isKeyRelease(data)) return undefined;
    if (!matchesKey(data, backgroundShortcut as KeyId)) return undefined;
    const targets = manager.listBlockingAgents();
    if (targets.length === 0) return undefined;
    for (const record of targets) manager.detachBlocking(record.id);
    widget.update();
    fleet.update();
    return { consume: true };
  }
  /** Re-registers only when handed a new `ui` — same idempotence as `fleet.setUICtx`. */
  let backgroundShortcutUI: FleetUICtx | undefined;
  let backgroundShortcutUnsub: (() => void) | undefined;
  function registerBackgroundShortcut(ui: FleetUICtx): void {
    if (ui === backgroundShortcutUI) return;
    backgroundShortcutUnsub?.();
    backgroundShortcutUI = ui;
    backgroundShortcutUnsub = ui.onTerminalInput(handleBackgroundShortcut);
  }

  // Claude Code-style `@handle message` prompt mentions. Read live by both the
  // `input` hook and the stacked autocomplete provider, so the toggle applies
  // immediately — the provider itself can never be unregistered (pi's wrapper
  // list is append-only), it just delegates everything when this is off.
  let agentMentionMode: AgentMentionMode = "model";
  function getAgentMentionMode(): AgentMentionMode {
    return agentMentionMode;
  }
  function setAgentMentionMode(mode: AgentMentionMode): void {
    agentMentionMode = mode;
  }
  // `model` and `direct` differ only in who starts a not-yet-running agent, so
  // everything that just asks "are mentions live at all" — the suggestion list,
  // the steer and resume branches — reads this instead of the mode.
  function isAgentMentionsEnabled(): boolean {
    return agentMentionMode !== "off";
  }

  // Project/global default for writing the subagent .output transcript lives in
  // output-file.ts (both spawn paths read it). A custom agent's
  // `output_transcript` frontmatter overrides it per spawn; when the frontmatter
  // is silent, this default applies. Read live at spawn time.

  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = "smart";
  function getDefaultJoinMode(): JoinMode {
    return defaultJoinMode;
  }
  function setDefaultJoinMode(mode: JoinMode) {
    defaultJoinMode = mode;
  }

  // What an unqualified top-level spawn means. Defaults to background,
  // following Claude Code; `backgroundByDefault: false` restores the previous
  // foreground default. Nested spawns ignore this — see nested-tools.ts.
  let backgroundByDefault = true;
  function getBackgroundByDefault(): boolean {
    return backgroundByDefault;
  }
  function setBackgroundByDefault(b: boolean) {
    backgroundByDefault = b;
  }

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, Explore,
  // Plan) are not registered. User-defined agents from project/global custom
  // agent dirs are completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or jpi.kdl.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode {
    return toolDescriptionMode;
  }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void {
    toolDescriptionMode = mode;
  }

  /**
   * Wrap a tool so its results carry back whatever subagent spend the parent
   * session has not been told about yet (see `PendingUsagePool`).
   *
   * Pi copies `AgentToolResult.usage` onto the persisted tool-result message and
   * folds it into `getSessionStats()`, which is what the footer, the statusline
   * and `/cost` read — so this is the whole of "report usage to the parent".
   *
   * Nothing is attached to a call with no tool-call id. That is the `@handle`
   * mention path (`mention-clone.ts`), which invokes this tool from a fork of the
   * conversation that is discarded moments later: the result never becomes a
   * message in the real session, so usage hung on it would be spend the user paid
   * for and nobody counted. Skipping leaves it pending for the next real result.
   */
  function withUsageReporting<T extends { execute: (...args: any[]) => any }>(tool: T): T {
    return {
      ...tool,
      execute: async (toolCallId: string | undefined, ...rest: any[]) => {
        const result = await tool.execute(toolCallId, ...rest);
        if (!reportUsage || !toolCallId) return result;
        const usage = pendingUsage.drain();
        return usage ? { ...result, usage } : result;
      },
    };
  }
  function registerToolReportingUsage<T extends { execute: (...args: any[]) => any }>(tool: T): T {
    const wrapped = withUsageReporting(tool);
    pi.registerTool(wrapped as any);
    return wrapped;
  }

  /**
   * Every settings mutation writes this whole object through `Config.save`,
   * which only touches the keys present — so a field missing here just never
   * gets saved (its default keeps whatever jpi.kdl already has), not erased.
   * `satisfies` (not a `: SubagentsSettings` annotation) keeps the return type
   * inferred, so `_NoMissingSettingsKeys` below still has something to check.
   */
  function snapshotSettings() {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      // 0 = unlimited, and the default — see SubagentsSettings.
      maxConcurrentForeground: manager.getMaxConcurrentForeground(),
      // 0 = unlimited — per SubagentsSettings.defaultMaxTurns docstring and
      // normalizeMaxTurns() in agent-runner.ts (which maps 0 → undefined).
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultJoinMode: getDefaultJoinMode(),
      backgroundByDefault: getBackgroundByDefault(),
      scopeModels: isScopeModelsEnabled(),
      strictAgentFiles,
      disableDefaultAgents: isDefaultsDisabled(),
      toolDescriptionMode: getToolDescriptionMode(),
      fleetView: isFleetViewEnabled(),
      agentMentions: getAgentMentionMode(),
      rememberAgents: getRememberAgents(),
      widgetMode: getWidgetMode(),
      outputTranscript: getOutputTranscriptDefault(),
      worktreeIsolation: isWorktreeIsolationEnabled(),
      worktreeCleanupPeriodDays: getWorktreeCleanupPeriodDays(),
      maxSubagentDepth: getMaxSubagentDepth(),
      // `false` is the KDL spelling of the NO_FALLBACK sentinel — the reverse
      // of applySettings' mapping. `?? "general-purpose"` only matters before
      // the first load populates this; the schema default is the same value.
      fallbackSubagent:
        getFallbackSubagent() === NO_FALLBACK
          ? false
          : (getFallbackSubagent() ?? "general-purpose"),
      reportUsage: isReportUsageEnabled(),
      showCost: isShowCostEnabled(),
      showModel: isShowModelEnabled(),
      viewerMarkdown: getViewerMarkdown(),
      backgroundShortcut: getBackgroundShortcut(),
    } satisfies SubagentsSettings;
  }

  // Compile-time completeness guard for snapshotSettings(). If a field is added
  // to SubagentsSettings and not mirrored above, this Exclude is non-empty and
  // fails to satisfy `never` — turning a silent settings-erasure bug into a
  // typecheck error. `npm run typecheck` runs in CI.
  type _NoMissingSettingsKeys =
    Exclude<keyof SubagentsSettings, keyof ReturnType<typeof snapshotSettings>> extends never
      ? true
      : ["snapshotSettings() is missing a SubagentsSettings key"];
  const _settingsSnapshotIsComplete: _NoMissingSettingsKeys = true;
  void _settingsSnapshotIsComplete;

  // Persist the current snapshot, emit `subagents:settings_changed`, and surface
  // the right toast. Successful saves show info; persistence failures downgrade
  // to warning so users aren't silently reverted on restart. Event fires regardless
  // of outcome so listeners see the in-memory change.
  /**
   * Persist + broadcast the settings, silent on success — for a change whose
   * feedback is the UI it just changed: the viewer's `m` key, where a
   * notification per press would talk over the overlay it is describing.
   *
   * A *failed* write still speaks. Every other settings path warns when the
   * value is session-only, and swallowing it here would leave a preference
   * looking persisted when the next session will not have it.
   */
  async function persistSettings(
    ctx: ExtensionCommandContext | undefined,
    changeMsg: string,
  ): Promise<void> {
    const { message, level } = await saveAndEmitChanged(
      moduleCtx.config,
      snapshotSettings(),
      changeMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    // `ctx` is absent only on the fleet path between sessions, where
    // `currentCtx` has been cleared and there is no UI to carry the warning to.
    // The write still happens.
    if (level === "warning") ctx?.ui.notify(message, level);
  }

  async function notifyApplied(ctx: ExtensionCommandContext, successMsg: string): Promise<void> {
    const { message, level } = await saveAndEmitChanged(
      moduleCtx.config,
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  // ---- Shared runtime context ----
  const rt: SubagentsRuntime = {
    pi,
    moduleCtx,
    manager,
    agentActivity,
    widget,
    fleet,
    pendingUsage,
    getCurrentCtx: () => currentCtx,
    reloadCustomAgents,
    resolveAgentRef,
    spawnResolved,
    spawnTopLevel,
    ensureTimers,
    currentBatchAgents: [],
    batchFinalizeTimer: undefined,
    finalizeBatch(): void {
      rt.batchFinalizeTimer = undefined;
      const batchAgents = [...rt.currentBatchAgents];
      rt.currentBatchAgents = [];

      const smartAgents = batchAgents.filter(
        (a) => a.joinMode === "smart" || a.joinMode === "group",
      );
      if (smartAgents.length >= 2) {
        const groupId = `batch-${++batchCounter}`;
        const ids = smartAgents.map((a) => a.id);
        rt.groupJoin!.registerGroup(groupId, ids);
        // Retroactively process agents that already completed during the debounce window.
        // Their onComplete fired but was deferred (agent was in currentBatchAgents),
        // so we feed them into the group now.
        for (const id of ids) {
          const record = manager.getRecord(id);
          if (!record) continue;
          record.groupId = groupId;
          if (record.completedAt != null && !record.resultConsumed) {
            rt.groupJoin!.onAgentComplete(record);
          }
        }
      } else {
        // No group formed — send individual nudges for any agents that completed
        // during the debounce window and had their notification deferred.
        for (const { id } of batchAgents) {
          const record = manager.getRecord(id);
          if (record?.completedAt != null && !record.resultConsumed) {
            rt.sendIndividualNudge!(record);
          }
        }
      }
    },
    registerToolReportingUsage,
    getStrictAgentFiles: () => strictAgentFiles,
    setStrictAgentFiles: (b) => {
      strictAgentFiles = b;
    },
    isReportUsageEnabled,
    setReportUsage,
    isShowCostEnabled,
    setShowCost,
    isShowModelEnabled,
    setShowModel,
    getViewerMarkdown,
    setViewerMarkdown,
    chooseViewerMarkdown,
    getWidgetMode,
    setWidgetMode,
    isFleetViewEnabled,
    setFleetViewEnabled,
    getAgentMentionMode,
    setAgentMentionMode,
    getDefaultJoinMode,
    setDefaultJoinMode,
    getBackgroundByDefault,
    setBackgroundByDefault,
    setDisableDefaultAgents,
    getToolDescriptionMode,
    setToolDescriptionMode,
    persistSettings,
    notifyApplied,
  };

  /** Collects background agent IDs spawned in the current turn for smart grouping. */
  let batchCounter = 0;

  // Notifications: the `subagent-notification` renderer, individual/group
  // nudges and the GroupJoinManager. Populates rt.groupJoin/scheduleNudge/
  // cancelNudge/sendIndividualNudge/disposeNudges.
  wireNotifications(rt);

  // Capture ctx from session_start for the RPC spawn handler. This also wires
  // the RPC handlers and broadcasts readiness — on the first bound
  // session_start, so a filtered-out activation never advertises (#142).
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (ctx.hasUI) {
      widget.setUICtx(ctx.ui);
      fleet.setUICtx(ctx.ui as any);
      registerBackgroundShortcut(ctx.ui as unknown as FleetUICtx);
      // Wired once per activation, like rpcHandle below: jpi-status (if present)
      // picks the rows up from here instead of the belowEditor widget.
      if (!fleetBridgeWired) {
        fleetBridgeWired = true;
        wireFleetFooterProvider(pi.events, fleet);
      }
    }
    manager.clearCompleted(true);
    // session_start fires once per activation, but a double-bind must not
    // leak listeners.
    if (!rpcHandle) {
      rpcHandle = wireRpcHandlers(rt);
    }
    // Stack `@handle` suggestions on pi's built-in autocomplete. Registered at
    // most once per activation: pi appends wrappers to a list it never prunes,
    // so a second call would layer a duplicate provider on the first. TUI only
    // — print mode has no such method, and RPC mode's is a no-op.
    if (ctx.mode === "tui" && !mentionProviderRegistered) {
      mentionProviderRegistered = true;
      ctx.ui.addAutocompleteProvider((current) =>
        createMentionProvider(
          current,
          // Plain text, not renderAgentName: the same label FleetView and the
          // widget show, but the autocomplete description cannot carry ANSI.
          () => mentionRoster(manager, mentionTypes(), (type) => getConfig(type).displayName),
          isAgentMentionsEnabled,
        ),
      );
    }
  });

  /** Agent types `@` can start, in the shape the roster wants. */
  const mentionTypes = (): TypeInfo[] =>
    getAvailableTypes().map((name) => ({
      name,
      description: getAgentConfig(name)?.description ?? name,
    }));

  /**
   * `@handle message` typed at the prompt addresses that agent instead of the
   * main model — Claude Code's prompt mention, same grammar (see mention.ts).
   *
   * The handle names the *agent*, not one process, so one syntax covers its
   * whole lifecycle: message it while it runs, resume it once it has finished,
   * start it if it never ran. Everything that isn't an agent mention falls
   * through untouched, which is what keeps `@src/foo.ts summarize this`, a bare
   * `@handle`, and ordinary prose working. A delivered mention costs no
   * main-model turn; the answer arrives through the ordinary completion
   * notification either way.
   */
  pi.on("input", async (event, ctx) => {
    // Never hijack text the extension layer itself submitted (pi.sendMessage)
    // — only something a person typed can be a mention.
    if (event.source === "extension" || !isAgentMentionsEnabled()) return { action: "continue" };
    // Claiming the turn is TUI only, matching the `@` completion that teaches
    // the syntax. Pi defaults `session.prompt()` to source "interactive", so a
    // headless `pi -p "@explore …"` reaches here too — and claiming it would
    // answer with silence, which the background hold cannot fix: `handled`
    // returns from prompt() before any turn starts, so the loop that patch wraps
    // never runs (it holds subagents spawned by the Agent tool MID-turn, a
    // different path). The agent would detach, `ctx.ui.notify` is a no-op
    // outside the TUI, and print mode would exit having printed nothing.
    //
    // `model` mode has none of that problem: it queues a reminder and lets the
    // turn run, so the answer is the model's own, printed as usual. It is the
    // only branch allowed to act headlessly; everything else falls through to
    // the main model exactly as it did before mentions existed.
    const canDispatchDirectly = ctx.mode === "tui";
    if (!canDispatchDirectly && getAgentMentionMode() !== "model") return { action: "continue" };

    const mention = parseMention(event.text);
    if (!mention) return { action: "continue" };

    // `@main` addresses the main conversation, never a subagent — the one name
    // `assignHandle` refuses to allocate. An explicit escape hatch for text
    // that would otherwise read as a mention, so the prefix is dropped and the
    // rest goes to the model with its attachments intact.
    if (isReservedHandle(mention.handle)) {
      return {
        action: "transform",
        text: mention.message,
        ...(event.images && { images: event.images }),
      };
    }

    // As typed first, so an agent actually called `agent-foo` wins over Claude
    // Code's `@agent-` + `foo` spelling rather than being shadowed by it.
    const alias = stripAgentPrefix(mention.handle);
    const resolved =
      manager.resolveMention(mention.handle) ?? (alias ? manager.resolveMention(alias) : undefined);

    // Steering and resuming are direct in every mode, so headless they are not
    // available at all. Falling through here rather than dropping to the start
    // path below matters: the handle names an agent that already exists, and
    // asking the model to start another one is not what was typed.
    if (resolved && !canDispatchDirectly) return { action: "continue" };

    if (resolved?.kind === "live") {
      const record = resolved.record;
      const target = `@${record.alias ?? record.handle ?? mention.handle}`;

      if (record.status === "running" || record.status === "queued") {
        // Steering interrupts after the current tool call, exactly like the
        // steer_subagent tool. Un-consume the result so the agent's reply to
        // this message is still relayed even if the LLM read its last answer.
        record.resultConsumed = false;
        manager.steer(record.id, mention.message);
        pi.events.emit("subagents:steered", { id: record.id, message: mention.message });
        ctx.ui.notify(`Sent to ${target}`, "info");
        return { action: "handled" };
      }

      if (record.session) {
        // Both derived from the record's OWN type: a mention names an existing
        // agent, so its frontmatter is what governs — `output_transcript: false`
        // must keep holding, since record.outputFile is the sole gate every
        // downstream consumer keys off and a resume must not re-open it.
        const config = getAgentConfig(record.type);
        const resumedRecord = await startBackgroundResume(rt, ctx, record, mention.message, {
          outputTranscript: config?.outputTranscript ?? getOutputTranscriptDefault(),
          maxTurns: normalizeMaxTurns(config?.maxTurns ?? getDefaultMaxTurns()),
        });
        ctx.ui.notify(
          resumedRecord
            ? `Resuming ${target}`
            : `Could not resume ${target} — it is still running.`,
          resumedRecord ? "info" : "warning",
        );
        return { action: "handled" };
      }
      // A live record with no session never got far enough to continue, so it
      // falls through to the start-fresh path below, like Claude's
      // `no_transcript`.
    }

    // Evicted, but its conversation is still on disk: reopen it. This is an
    // ordinary spawn carrying a session file, so the new record picks up the
    // widget, fleet row, transcript and completion notification unchanged —
    // and `reclaim` hands it back the names the tombstone was holding.
    if (resolved?.kind === "tombstone") {
      const entry = resolved.entry;
      const target = `@${entry.alias ?? entry.handle}`;

      // Checked here rather than left to SessionManager.open: that runs inside
      // runAgent, whose rejection lands on the record as an agent error, not in
      // the catch below. A `/new` in another pi window or a manual delete makes
      // the conversation unrecoverable (Claude Code's `not_reachable`), so drop
      // the entry — a row that can only ever fail is worse than none — and say
      // so rather than quietly sending this message to an unrelated agent.
      if (!existsSync(entry.sessionFile)) {
        manager.dropTombstone(entry.handle);
        ctx.ui.notify(`Could not resume ${target} — its session is gone.`, "warning");
        return { action: "handled" };
      }

      // The Agent tool deliberately falls back to general-purpose for a type it
      // cannot resolve (#183), which covers a deleted file AND a merely
      // disabled one. A resume must not inherit that: reopening this
      // conversation under a different agent's prompt and tools is not
      // continuing it, and the new record would re-tombstone under the
      // substitute, so the handle would never find its way back.
      reloadCustomAgents();
      const dispatch = resolveSpawnType(entry.type);
      if (!dispatch.ok || dispatch.fellBackFrom !== undefined) {
        // The tombstone stays: re-enabling the agent makes the handle work
        // again, which a drop would foreclose.
        ctx.ui.notify(
          `Could not resume ${target} — the ${entry.type} agent is no longer available.`,
          "warning",
        );
        return { action: "handled" };
      }

      try {
        // spawnResolved, not spawnTopLevel: the latter strips
        // `resumeSessionFile` and `reclaim` as untrusted. This path is the
        // exception — both come from a tombstone this extension wrote.
        const id = spawnResolved(pi, ctx, dispatch.type, mention.message, {
          description: entry.description,
          reclaim: { handle: entry.handle, alias: entry.alias },
          resumeSessionFile: entry.sessionFile,
          isBackground: true,
        });
        // The agent may still be starting — wait, so a startup failure lands in
        // the catch below instead of being announced as a resume.
        await manager.awaitStartup(id);
        // The tombstone deliberately stays. `resolveMention` prefers the live
        // record holding these same names, so it cannot shadow the resume — and
        // if this run dies before establishing its own session, the original
        // transcript is still the right thing for the next mention to reopen.
        // Once the resumed record is evicted it overwrites this entry in place,
        // keyed by the same handle, so nothing accumulates.
        ctx.ui.notify(`Resuming ${target}`, "info");
      } catch (err) {
        // The type is already settled above, so what is left is a spawn-time
        // failure: a strict worktree-isolation error, an unusable cwd.
        ctx.ui.notify(`Could not resume ${target}: ${errorMessage(err)}`, "warning");
      }
      return { action: "handled" };
    }

    // No agent under that handle — but the name may still be an agent type, in
    // which case the mention starts one.
    const typeHandle = mention.handle;
    const type =
      resolveHandleToType(typeHandle, getAvailableTypes()) ??
      (alias ? resolveHandleToType(alias, getAvailableTypes()) : undefined);
    if (!type) return { action: "continue" };

    // Claude Code never starts the agent itself: `@agent-<type>` becomes an
    // attachment asking the main model to do it, and the model writes the
    // agent's prompt from the conversation rather than forwarding the typed
    // text. That buys a real `Agent` tool call — transcript, per-tool widget
    // detail, tool-use-id correlation, join grouping — and a prompt with the
    // context a cold spawn lacks.
    //
    // It also costs a visible turn, spent narrating a decision the user already
    // made by typing the handle. So the turn is taken by a clone of this
    // conversation instead (mention-clone.ts): same messages, same system
    // prompt, off-screen, holding only the `Agent` tool. Nothing reaches the
    // chat, and what it starts is an ordinary top-level agent.
    if (getAgentMentionMode() === "model") {
      const label = `@${handleBase(type)}`;
      // "Prompting", not "Starting": in this mode nothing starts until the
      // off-screen clone has taken a whole model turn writing the agent's
      // prompt, and that wait is the one thing the chat cannot show. `direct`
      // says "Started" because by then it has. The distinction tells the user
      // which of the two they are waiting on.
      ctx.ui.notify(`Prompting ${label}…`, "info");
      // Not awaited: the clone runs a full model turn, and prompt() is blocked
      // until this hook returns. The user gets their prompt back immediately
      // and the agent appears in the widget when it starts.
      void runMentionClone({
        ctx,
        type,
        message: mention.message,
        agentTool: registeredAgentTool,
      }).then(async (result) => {
        if (result.spawned) return;
        // A clone that could not run must not swallow the mention: start the
        // agent the direct way rather than leaving the user with a toast and
        // nothing running.
        try {
          const id = spawnTopLevel(pi, ctx, type, mention.message, {
            description: describeMention(mention.message),
            isBackground: true,
          });
          // Same reason as the direct path below: the agent may still be
          // starting, and a failure there must reach this catch.
          await manager.awaitStartup(id);
          ctx.ui.notify(`Started ${label} directly — ${result.error}`, "warning");
        } catch (err) {
          ctx.ui.notify(`Could not start ${label}: ${errorMessage(err)}`, "error");
        }
      });
      return { action: "handled" };
    }

    try {
      // Nothing else to pass: runAgent resolves model, thinking and max turns
      // from the agent's own config when the spawn omits them, and the
      // manager's onStart/onComplete callbacks own the widget, the fleet list
      // and the completion notification — the same contract cross-extension
      // RPC spawns run under.
      const id = spawnTopLevel(pi, ctx, type, mention.message, {
        description: describeMention(mention.message),
        isBackground: true,
      });
      // The agent may still be starting (a worktree copy is an awaited git
      // call) — report a failure that lands there as a failed start, not as a
      // "Started" toast for an agent that never ran.
      await manager.awaitStartup(id);
      ctx.ui.notify(`Started @${handleBase(type)}`, "info");
    } catch (err) {
      ctx.ui.notify(`Could not start @${handleBase(type)}: ${errorMessage(err)}`, "error");
    }
    return { action: "handled" };
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted(true);
  });

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    unwireRpcHandlers(rpcHandle);
    rpcHandle = undefined;
    currentCtx = undefined;
    // Only release the global slot if this activation claimed it — a child
    // session's shutdown must not delete the root session's registry entry.
    if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
      delete (globalThis as any)[MANAGER_KEY];
    }
    manager.abortAll();
    rt.disposeNudges?.();
    fleet.dispose();
    // Awaited: it emits `session_shutdown` into every retained child session so
    // extensions bound there can release what they armed in `session_start` (#242).
    // pi awaits this handler, and the process exits right after — unawaited, those
    // handlers would never run. Internally bounded, so a hung one can't strand quit.
    await manager.dispose(pi);
  });

  // Apply the settings loaded at the top of this function (before the initial
  // custom-agent load) and emit `subagents:settings_loaded`. Every field is
  // always present — Config.load() fills in defaults for anything jpi.kdl
  // doesn't set; a corrupt jpi.kdl already warned to stderr above and fell
  // back to defaults.
  applySettings(loadedSettings, {
    setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
    setMaxConcurrentForeground: (n) => manager.setMaxConcurrentForeground(n),
    setDefaultMaxTurns,
    setGraceTurns,
    setDefaultJoinMode,
    setBackgroundByDefault,
    setScopeModels: setScopeModelsEnabled,
    setStrictAgentFiles: (b) => {
      strictAgentFiles = b;
    },
    setDisableDefaultAgents: setDisableDefaultAgents,
    setToolDescriptionMode: setToolDescriptionMode,
    setFleetView: setFleetViewEnabled,
    setAgentMentions: setAgentMentionMode,
    setRememberAgents,
    setWidgetMode: setWidgetMode,
    setOutputTranscript: setOutputTranscriptDefault,
    setWorktreeIsolation: setWorktreeIsolationEnabled,
    setWorktreeCleanupPeriodDays,
    setMaxSubagentDepth: setMaxSubagentDepth,
    setFallbackSubagent: setFallbackSubagent,
    setReportUsage,
    setShowCost,
    setShowModel,
    setViewerMarkdown,
    setBackgroundShortcut,
  });
  pi.events.emit("subagents:settings_loaded", { settings: loadedSettings });

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    registerBackgroundShortcut(ctx.ui as unknown as FleetUICtx);
    widget.onTurnStart();
  });

  // The Agent tool: description, schema, rendering and the execute handler
  // (resume / background-spawn / foreground-spawn paths) all live in
  // agent-tool.ts. Held rather than only registered: the mention clone above
  // reuses this exact definition, so the agent it starts is an ordinary
  // top-level spawn instead of a second implementation kept in step by hand.
  const { registeredAgentTool } = createAgentTool(rt);

  // get_subagent_result / steer_subagent.
  wireResultTools(rt);

  // The `/agents` interactive menu.
  wireAgentsMenu(rt);
}
