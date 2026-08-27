/**
 * tasks — jpi module providing Claude Code-style task tracking.
 *
 * Tools:
 *   TaskCreate   — Create a structured task
 *   TaskList     — List all tasks with status
 *   TaskGet      — Get full task details
 *   TaskUpdate   — Update task fields and status
 *
 * Commands:
 *   /tasks       — Interactive task management menu
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  bulletState,
  countLines,
  createResultLine,
  createToolHeader,
  extractResultText,
  plural,
  projectSlug,
  sanitizeStoreSegment,
  Store,
  truncateEnd,
  type ModuleContext,
} from "../../src/core/index.ts";
import { AutoClearManager } from "./auto-clear.ts";
import { tasksSchema } from "./config.ts";
import {
  type CadenceConfig,
  createCadenceState,
  drainReminderForContext,
  evaluateToolResult,
  onTurnStart,
  resetCadenceState,
} from "./reminder-cadence.ts";
import { TaskStore } from "./task-store.ts";
import type { Task } from "./types.ts";
import { TaskWidget, type UICtx } from "./ui/task-widget.ts";

// ---- Helpers ----

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

/** First non-empty line of `text`, for a one-line error or fallback summary. */
function firstNonEmptyLine(text: string): string | undefined {
  return text.split("\n").find((line) => line.trim() !== "");
}

/** Glyphs for the /tasks picker menu — mirrors the widget's fixed defaults. */
const STATUS_GLYPH: Record<string, string> = { completed: "✔", in_progress: "◼", pending: "◻" };

/** Task tool names — used to detect task tool usage for reminder suppression. */
const TASK_TOOL_NAMES = new Set(["TaskCreate", "TaskList", "TaskGet", "TaskUpdate"]);

/** How many turns without task tool usage before injecting a reminder. */
const REMINDER_INTERVAL = 4;

/** Shorter interval used while any task is in_progress, so stale work is caught faster. */
const ACTIVE_REMINDER_INTERVAL = 2;

/** Cap on how many tasks the reminder echoes, to bound its size on large lists. */
const REMINDER_MAX_TASKS = 10;

/** Effective reminder interval for a given task list (pure — no disk I/O). */
function intervalFor(tasks: Task[]): number {
  return tasks.some((t) => t.status === "in_progress")
    ? ACTIVE_REMINDER_INTERVAL
    : REMINDER_INTERVAL;
}

/** How many turns completed tasks linger before auto-clearing. */
const AUTO_CLEAR_DELAY = 4;

/** Neutralize a task field for the echo: collapse newlines and strip reminder tags. */
function sanitizeField(value: string): string {
  return value
    .replace(/[\r\n]+/g, " ")
    .replace(/<\/?system-reminder>/gi, "")
    .trim();
}

/**
 * Build the system reminder, shaped after Claude Code's todo reminders: an
 * empty-list nudge, or a state echo that dumps the current list as JSON. The
 * wording mirrors Claude Code (adapted to this extension's task tool names).
 */
function buildSystemReminder(tasks: Task[]): string {
  if (tasks.length === 0) {
    return [
      "<system-reminder>",
      "This is a reminder that your task list is currently empty. DO NOT mention this to the user explicitly because they are already aware. If you are working on tasks that would benefit from a task list please use the TaskCreate tool to create one. If not, please feel free to ignore. Again do not mention this message to the user.",
      "</system-reminder>",
    ].join("\n");
  }

  // Bound the echo on large lists. When over the cap, drop completed tasks
  // first (the reminder exists to surface unfinished work); ties keep task
  // order since Array.sort is stable.
  let shown = tasks;
  if (tasks.length > REMINDER_MAX_TASKS) {
    const rank = (t: Task) => (t.status === "in_progress" ? 0 : t.status === "pending" ? 1 : 2);
    shown = [...tasks].sort((a, b) => rank(a) - rank(b)).slice(0, REMINDER_MAX_TASKS);
  }
  const hidden = tasks.length - shown.length;
  const overflow =
    hidden > 0
      ? ` (${hidden} more task${hidden === 1 ? "" : "s"} not shown — use TaskList for the full list.)`
      : "";

  const items = shown.map((t) => {
    const item: Record<string, string> = {
      id: t.id,
      content: sanitizeField(t.subject),
      status: t.status,
    };
    if (t.activeForm) item.activeForm = sanitizeField(t.activeForm);
    return item;
  });

  // When truncated, don't claim these are the full contents.
  const prefix =
    "The task tools haven't been used recently. DO NOT mention this explicitly to the user.";
  const header =
    hidden > 0
      ? `${prefix} Here are your most relevant tasks (list truncated):`
      : `${prefix} Here are the latest contents of your task list:`;

  return [
    "<system-reminder>",
    header,
    "",
    `${JSON.stringify(items)}.${overflow} Continue on with the tasks at hand if applicable.`,
    "</system-reminder>",
  ].join("\n");
}

export function setupTasks(pi: ExtensionAPI, ctx: ModuleContext<typeof tasksSchema>) {
  const jpiStore = new Store("tasks");

  // The loader guarantees the `tasks { }` config is loaded before setup runs, so
  // scope and auto-clear mode are fixed for the life of this extension instance.
  const taskScope = ctx.value.scope;
  const autoClearMode = ctx.value.autoClearCompleted;

  /** Resolve both the backing Store key and a stable identity for the active store. */
  function resolveStoreTarget(
    cwd?: string,
    sessionId?: string,
  ): { key: string; storeKey?: string } {
    if (taskScope === "memory") return { key: "memory:config" };
    if (!cwd) return { key: "pending:workspace" };
    const slug = projectSlug(cwd);
    if (taskScope === "session") {
      if (!sessionId) return { key: "pending:session" };
      const storeKey = `${slug}/session-${sanitizeStoreSegment(sessionId)}.json`;
      return { key: `path:${storeKey}`, storeKey };
    }
    const storeKey = `${slug}/project.json`;
    return { key: `path:${storeKey}`, storeKey };
  }

  function makeStore(storeKey: string | undefined): TaskStore {
    return storeKey ? new TaskStore(jpiStore, storeKey) : new TaskStore();
  }

  // The scope needs a loaded config and cwd needs an ExtensionContext, neither
  // of which is available while the extension factory runs, so the store
  // starts pending.
  let storeTarget = resolveStoreTarget();
  let store = makeStore(storeTarget.storeKey);
  const widget = new TaskWidget(store);

  const autoClear = new AutoClearManager(
    () => store,
    () => autoClearMode,
    AUTO_CLEAR_DELAY,
  );

  // ── Context-scoped store initialization ──
  // Project paths cannot be resolved until an ExtensionContext is available.
  // Initialize on the first context-bearing event and reinitialize when a host
  // switches this extension instance to a session in another workspace.
  let persistedTasksShown = false;
  async function initializeStoreForContext(ctx: ExtensionContext): Promise<void> {
    // `pi --no-session` mints a session ID but never a session file. Keying off the
    // ID alone would write session-<id>.json for a session that can never be resumed
    // and is orphaned the moment pi exits: if pi is not persisting the conversation,
    // don't persist the task list either.
    const sessionId =
      taskScope === "session" && ctx.sessionManager.getSessionFile()
        ? ctx.sessionManager.getSessionId()
        : undefined;
    const nextTarget = resolveStoreTarget(ctx.cwd, sessionId);
    if (nextTarget.key !== storeTarget.key) {
      store = makeStore(nextTarget.storeKey);
      await store.load();
      widget.setStore(store);
      storeTarget = nextTarget;
    }
  }

  /** Restore widget on session start/resume — it only shows when at least one
   *  task isn't completed. On new sessions, an all-completed list is cleared
   *  instead (clean slate); on resume/reload/fork it stays in the store,
   *  just hidden.
   *  Only runs once — the first caller wins. */
  async function showPersistedTasks(isResume = false): Promise<void> {
    if (persistedTasksShown) return;
    persistedTasksShown = true;
    const tasks = store.list();
    if (tasks.length > 0) {
      if (!isResume && tasks.every((t) => t.status === "completed")) {
        await store.clearCompleted();
        if (taskScope === "session") await store.deleteFileIfEmpty();
      } else {
        widget.update();
      }
    }
  }

  // ── Turn tracking for system-reminder injection ──
  // Cadence decisions live in `reminder-cadence.ts` so they're
  // unit-testable without spinning up a fake ExtensionAPI.
  const cadence = createCadenceState();
  const cadenceConfig: CadenceConfig = {
    reminderInterval: REMINDER_INTERVAL,
    taskToolNames: TASK_TOOL_NAMES,
  };

  pi.on("turn_start", async (_event, ctx) => {
    onTurnStart(cadence);
    widget.setUICtx(ctx.ui as UICtx);
    await initializeStoreForContext(ctx);
    if (await autoClear.onTurnStart(cadence.currentTurn)) {
      if (taskScope === "session") await store.deleteFileIfEmpty();
      widget.update();
    }
  });

  // The end of a run is the only signal that separates a new batch of tasks from the
  // same batch still being built — the store looks identical either way. Nothing is
  // cleared here; this only marks the boundary for the next TaskCreate.
  pi.on("agent_settled", async () => {
    autoClear.onRunEnded();
  });

  // ── Token usage tracking + stale-task detection ──
  // Feed per-turn token counts from assistant messages into the widget.
  // Also detect when the agent has stopped referencing tasks but left
  // them in_progress — schedule a reminder for the next LLM call.
  pi.on("turn_end", async (event) => {
    const msg = event.message as any;
    if (msg?.role === "assistant" && msg.usage) {
      widget.addTokenUsage(msg.usage.input ?? 0, msg.usage.output ?? 0);
    }

    // Stale-task detection: catch the case where the agent finishes work in a
    // text-only turn (no tool calls, so tool_result never fires) but left tasks
    // in_progress. Cheap-first: only read the store once the turn gap could
    // matter — the in_progress interval is the smallest a reminder can need.
    if (!cadence.reminderInjectedThisCycle && !cadence.reminderDue) {
      const gap = cadence.currentTurn - cadence.lastTaskToolUseTurn;
      if (gap >= ACTIVE_REMINDER_INTERVAL && store.list().some((t) => t.status === "in_progress")) {
        cadence.reminderDue = true;
      }
    }
  });

  // ── System-reminder injection ──
  //
  // tool_result is used ONLY to track cadence. We DO NOT mutate non-task
  // tool result content — appending a <system-reminder> there would
  // corrupt model-visible transcript semantics for unrelated tools (read,
  // bash, grep, …) and make tool-output debugging miserable.
  //
  // The actual injection happens in the `context` hook below, which fires
  // before each LLM call and returns a modified copy of the messages
  // without persisting or polluting any tool output.
  pi.on("tool_result", async (event) => {
    // Task tool usage resets cadence (interval is irrelevant on this path — the
    // helper resets and returns before reading it).
    if (TASK_TOOL_NAMES.has(event.toolName)) {
      evaluateToolResult(cadence, event.toolName, false, cadenceConfig);
      return {};
    }

    if (cadence.reminderInjectedThisCycle) return {};
    // Cheap-first: avoid store.list() disk I/O until the turn gap could matter.
    // ACTIVE_REMINDER_INTERVAL is the smallest interval any reminder can need.
    if (cadence.currentTurn - cadence.lastTaskToolUseTurn < ACTIVE_REMINDER_INTERVAL) return {};

    const tasks = store.list();
    // Shorter interval while in_progress; passed per-call so the shared config
    // is never mutated.
    evaluateToolResult(cadence, event.toolName, tasks.length > 0, {
      ...cadenceConfig,
      reminderInterval: intervalFor(tasks),
    });
    return {};
  });

  // Inject the transient system-reminder into the upcoming LLM call's
  // messages, never into a tool result. The reminder is appended as a
  // user message so models that don't support custom message types still
  // receive it. It is not persisted in the session store — `context`
  // returns a transformed messages array used only for this one request.
  pi.on("context", async (event) => {
    if (!drainReminderForContext(cadence)) return {};
    const tasks = store.list();

    return {
      messages: [
        ...event.messages,
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: buildSystemReminder(tasks) }],
          timestamp: Date.now(),
        },
      ],
    };
  });

  // session_start replaces the never-emitted session_switch event. Rehydrating
  // here matters because before_agent_start only fires once the user prompts.
  pi.on("session_start", async (event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);

    const reason = event.reason;
    // new/resume/fork reuse the running extension instance (getExtensions() is
    // cached), so session-scoped state must be reset. startup/reload re-run the
    // factory and start clean.
    const isSwitch = reason === "new" || reason === "resume" || reason === "fork";
    // A fork branches the conversation, so its tasks carry over as an independent
    // copy. Snapshot before the store re-points to the new (empty) session file.
    const forkSeed = reason === "fork" ? store.snapshot() : undefined;
    if (isSwitch) {
      persistedTasksShown = false;
      resetCadenceState(cadence);
      autoClear.reset();
      // Memory mode has no file to switch — clear tasks explicitly on /new.
      if (reason === "new" && taskScope === "memory") {
        await store.clearAll();
      }
    }

    await initializeStoreForContext(ctx);
    if (forkSeed?.tasks.length) await store.seed(forkSeed); // carry the parent's tasks into the fork
    // resume/reload/fork keep tasks; startup/new auto-clear an all-completed list.
    const keepsTasks = reason === "reload" || reason === "resume" || reason === "fork";
    await showPersistedTasks(keepsTasks);
    // Those tasks are shown for review, but the run that produced them ended with the
    // session before this one — so the next batch must not be added to them either.
    if (keepsTasks) autoClear.onRunEnded();
  });

  // Fallback for hosts that init UI lazily. Guarded by persistedTasksShown, so
  // it never double-renders after session_start.
  pi.on("before_agent_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    await initializeStoreForContext(ctx);
    await showPersistedTasks();
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    await initializeStoreForContext(ctx);
    widget.update();
  });

  // ──────────────────────────────────────────────────
  // Tool 1: TaskCreate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Use this tool to create a structured task list for your current coding session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated). Create them all in one response with one TaskCreate call per task
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: Detailed description of what needs to be done, including context and acceptance criteria
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Include enough detail in the description for another agent to understand and complete the task
- Check TaskList first to avoid creating duplicate tasks
- To create several tasks at once, call TaskCreate multiple times in a single response — independent tool calls run in parallel, so the whole batch is created in one turn (one task per call).`,
    promptGuidelines: [
      "When working on complex multi-step tasks, use TaskCreate to track progress and TaskUpdate to update status.",
      "Mark tasks as in_progress before starting work and completed when done.",
      "Use TaskList to check for available work after completing a task.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "A brief title for the task" }),
      description: Type.String({ description: "A detailed description of what needs to be done" }),
      activeForm: Type.Optional(
        Type.String({
          description:
            "Present continuous form shown in spinner when in_progress (e.g., 'Running tests')",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      // A finished list must not collect the batch that follows it. The turn countdowns
      // cannot be relied on for that: they only tick at `turn_start`, so a run that ends
      // right after its last completion freezes one mid-count.
      await autoClear.startNewBatch();
      const task = await store.create(params.subject, params.description, params.activeForm);
      widget.update();
      return textResult(`Task #${task.id} created successfully: ${task.subject}`);
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      return createToolHeader(
        bulletState(context),
        "TaskCreate",
        args.subject,
        theme,
        context.lastComponent,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Container();
      const text = extractResultText(result.content);
      const container = new Container();
      if (context.isError) {
        const preview = truncateEnd(firstNonEmptyLine(text) ?? "Error", 100);
        container.addChild(createResultLine(preview, theme, "error"));
        if (options.expanded) container.addChild(new Text(theme.fg("error", text), 0, 0));
        return container;
      }

      const match = text.match(/^Task #(\S+) created successfully/);
      const summary = match
        ? `Created task ${match[1]}`
        : (firstNonEmptyLine(text) ?? "Created task");
      container.addChild(createResultLine(summary, theme, "dim"));
      if (options.expanded && text)
        container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
      return container;
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 2: TaskList
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: `Use this tool to list all tasks in the task list.

## When to Use This Tool

- To see what tasks are available to work on
- To check overall progress on the project
- After completing a task, to check for newly available work
- **Prefer working on tasks in ID order** (lowest ID first) when multiple tasks are available, as earlier tasks often set up context for later ones

## Output

Returns a summary of each task:
- **id**: Task identifier (use with TaskGet, TaskUpdate)
- **subject**: Brief description of the task
- **status**: 'pending', 'in_progress', or 'completed'

Use TaskGet with a specific task ID to view full details including the description.`,
    parameters: Type.Object({}),

    execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const tasks = store.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks found"));

      // Sort: pending first (by ID), then in_progress (by ID), then completed (by ID)
      const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
      const sorted = [...tasks].sort((a, b) => {
        const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
        if (so !== 0) return so;
        return Number(a.id) - Number(b.id);
      });

      const lines = sorted.map((task) => `#${task.id} [${task.status}] ${task.subject}`);

      return Promise.resolve(textResult(lines.join("\n")));
    },
    renderShell: "self",
    renderCall(_args, theme, context) {
      return createToolHeader(bulletState(context), "TaskList", "", theme, context.lastComponent);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Container();
      const text = extractResultText(result.content);
      const container = new Container();
      if (context.isError) {
        const preview = truncateEnd(firstNonEmptyLine(text) ?? "Error", 100);
        container.addChild(createResultLine(preview, theme, "error"));
        if (options.expanded) container.addChild(new Text(theme.fg("error", text), 0, 0));
        return container;
      }

      const n = text === "No tasks found" ? 0 : countLines(text);
      container.addChild(createResultLine(`${n} ${plural(n, "task")}`, theme, "dim"));
      if (options.expanded && text)
        container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
      return container;
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 3: TaskGet
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskGet",
    label: "TaskGet",
    description: `Use this tool to retrieve a task by its ID from the task list.

## When to Use This Tool

- When you need the full description and context before starting work on a task
- After being assigned a task, to get complete requirements

## Output

Returns full task details:
- **subject**: Task title
- **description**: Detailed requirements and context
- **status**: 'pending', 'in_progress', or 'completed'

## Tips

- Use TaskList to see all tasks in summary form.`,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to retrieve" }),
    }),

    execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const task = store.get(params.taskId);
      if (!task) return Promise.resolve(textResult(`Task not found`));

      // Unescape literal \n sequences the LLM may have double-escaped in JSON
      const desc = task.description.replace(/\\n/g, "\n");

      const lines: string[] = [
        `Task #${task.id}: ${task.subject}`,
        `Status: ${task.status}`,
        `Description: ${desc}`,
      ];

      return Promise.resolve(textResult(lines.join("\n")));
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      return createToolHeader(
        bulletState(context),
        "TaskGet",
        args.taskId,
        theme,
        context.lastComponent,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Container();
      const text = extractResultText(result.content);
      const container = new Container();
      if (context.isError) {
        const preview = truncateEnd(firstNonEmptyLine(text) ?? "Error", 100);
        container.addChild(createResultLine(preview, theme, "error"));
        if (options.expanded) container.addChild(new Text(theme.fg("error", text), 0, 0));
        return container;
      }

      const summary =
        store.get(context.args.taskId)?.subject ?? firstNonEmptyLine(text) ?? "Task not found";
      container.addChild(createResultLine(summary, theme, "dim"));
      if (options.expanded && text)
        container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
      return container;
    },
  });

  // ──────────────────────────────────────────────────
  // Tool 4: TaskUpdate
  // ──────────────────────────────────────────────────

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Use this tool to update a task in the task list.

## When to Use This Tool

**Before starting work on a task:**
- Mark it in_progress BEFORE beginning — do not start work without updating status first
- After resolving, call TaskList to find your next task

**Mark tasks as resolved:**
- When you have completed the work described in a task
- When a task is no longer needed or has been superseded
- IMPORTANT: Always mark your assigned tasks as resolved when you finish them
- After resolving, call TaskList to find your next task

- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- When blocked, create a new task describing what needs to be resolved
- Never mark a task as completed if:
  - Tests are failing
  - Implementation is partial
  - You encountered unresolved errors
  - You couldn't find necessary files or dependencies

**Delete tasks:**
- When a task is no longer relevant or was created in error
- Setting status to \`deleted\` permanently removes the task

**Update task details:**
- When requirements change or become clearer

## Fields You Can Update

- **status**: The task status (see Status Workflow below)
- **subject**: Change the task title (imperative form, e.g., "Run tests")
- **description**: Change the task description
- **activeForm**: Present continuous form shown in spinner when in_progress (e.g., "Running tests")

## Status Workflow

Status progresses: \`pending\` → \`in_progress\` → \`completed\`

Use \`deleted\` to permanently remove a task.

## Staleness

Make sure to read a task's latest state using \`TaskGet\` before updating it.

## Examples

Mark task as in progress when starting work:
\`\`\`json
{"taskId": "1", "status": "in_progress"}
\`\`\`

Mark task as completed after finishing work:
\`\`\`json
{"taskId": "1", "status": "completed"}
\`\`\`

Delete a task:
\`\`\`json
{"taskId": "1", "status": "deleted"}
\`\`\``,
    parameters: Type.Object({
      taskId: Type.String({ description: "The ID of the task to update" }),
      status: Type.Optional(
        Type.Unsafe<"pending" | "in_progress" | "completed" | "deleted">({
          type: "string",
          enum: ["pending", "in_progress", "completed", "deleted"],
          description: "New status for the task",
        }),
      ),
      subject: Type.Optional(Type.String({ description: "New subject for the task" })),
      description: Type.Optional(Type.String({ description: "New description for the task" })),
      activeForm: Type.Optional(
        Type.String({ description: "Present continuous form shown in spinner when in_progress" }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const { taskId, ...fields } = params;
      const { task, changedFields } = await store.update(taskId, fields);

      if (changedFields.length === 0 && !task) {
        return textResult(`Task #${taskId} not found`);
      }

      // Update widget active task tracking
      if (fields.status === "in_progress") {
        widget.setActiveTask(taskId);
        autoClear.resetBatchCountdown();
      } else if (fields.status === "pending") {
        autoClear.resetBatchCountdown();
      } else if (fields.status === "completed" || fields.status === "deleted") {
        widget.setActiveTask(taskId, false);
        if (fields.status === "completed") autoClear.trackCompletion(taskId, cadence.currentTurn);
      }

      widget.update();
      return textResult(`Updated task #${taskId} ${changedFields.join(", ")}`);
    },
    renderShell: "self",
    renderCall(args, theme, context) {
      return createToolHeader(
        bulletState(context),
        "TaskUpdate",
        args.taskId,
        theme,
        context.lastComponent,
      );
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) return new Container();
      const text = extractResultText(result.content);
      const container = new Container();
      if (context.isError) {
        const preview = truncateEnd(firstNonEmptyLine(text) ?? "Error", 100);
        container.addChild(createResultLine(preview, theme, "error"));
        if (options.expanded) container.addChild(new Text(theme.fg("error", text), 0, 0));
        return container;
      }

      const taskId = context.args.taskId;
      const notFound = text === `Task #${taskId} not found`;
      const title = notFound ? undefined : store.get(taskId)?.subject;
      const summary = notFound ? text : title ? `Updated ${title}` : `Updated ${taskId}`;
      container.addChild(createResultLine(summary, theme, "dim"));
      if (options.expanded && text)
        container.addChild(new Text(theme.fg("toolOutput", text), 0, 0));
      return container;
    },
  });

  // ──────────────────────────────────────────────────
  // /tasks command
  // ──────────────────────────────────────────────────

  pi.registerCommand("tasks", {
    description: "Manage tasks — view, create, clear completed",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      widget.setUICtx(ctx.ui as UICtx);
      await initializeStoreForContext(ctx);
      const ui = ctx.ui;

      const mainMenu = async (): Promise<void> => {
        const tasks = store.list();
        const taskCount = tasks.length;
        const completedCount = tasks.filter((t) => t.status === "completed").length;

        const choices: string[] = [`View all tasks (${taskCount})`, "Create task"];
        if (completedCount > 0) choices.push(`Clear completed (${completedCount})`);
        if (taskCount > 0) choices.push(`Clear all (${taskCount})`);

        const choice = await ui.select("Tasks", choices);
        if (!choice) return;

        if (choice.startsWith("View")) {
          await viewTasks();
        } else if (choice === "Create task") {
          await createTask();
        } else if (choice.startsWith("Clear completed")) {
          await store.clearCompleted();
          if (taskScope === "session") await store.deleteFileIfEmpty();
          widget.update();
          await mainMenu();
        } else if (choice.startsWith("Clear all")) {
          await store.clearAll();
          if (taskScope === "session") await store.deleteFileIfEmpty();
          widget.update();
          await mainMenu();
        }
      };

      const viewTasks = async (): Promise<void> => {
        const tasks = store.list();
        if (tasks.length === 0) {
          await ui.select("No tasks", ["← Back"]);
          return mainMenu();
        }

        const statusGlyph = (status: string) => STATUS_GLYPH[status] ?? STATUS_GLYPH.pending;

        const choices = tasks.map(
          (t) => `${statusGlyph(t.status)} #${t.id} [${t.status}] ${t.subject}`,
        );
        choices.push("← Back");

        const selected = await ui.select("Tasks", choices);
        if (!selected || selected === "← Back") return mainMenu();

        // Matched by row position rather than parsed out of the label: both the glyph
        // and the subject are free text, and either can contain something like "#42".
        const picked = tasks[choices.indexOf(selected)];
        if (picked) await viewTaskDetail(picked.id);
        else return viewTasks();
      };

      const viewTaskDetail = async (taskId: string): Promise<void> => {
        const task = store.get(taskId);
        if (!task) return viewTasks();

        const actions: string[] = [];

        if (task.status === "pending") {
          actions.push("▸ Start (in_progress)");
        }
        if (task.status === "in_progress") {
          actions.push("✓ Complete");
        }
        actions.push("✗ Delete");
        actions.push("← Back");

        const title = `#${task.id} [${task.status}] ${task.subject}\n${task.description}`;
        const action = await ui.select(title, actions);

        if (action === "▸ Start (in_progress)") {
          await store.update(taskId, { status: "in_progress" });
          widget.setActiveTask(taskId);
          widget.update();
          return viewTasks();
        } else if (action === "✓ Complete") {
          await store.update(taskId, { status: "completed" });
          autoClear.trackCompletion(taskId, cadence.currentTurn);
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        } else if (action === "✗ Delete") {
          await store.update(taskId, { status: "deleted" });
          widget.setActiveTask(taskId, false);
          widget.update();
          return viewTasks();
        }
        return viewTasks();
      };

      const createTask = async (): Promise<void> => {
        const subject = await ui.input("Task subject");
        if (!subject) return mainMenu();
        const description = await ui.input("Task description");
        if (!description) return mainMenu();

        await store.create(subject, description);
        widget.update();
        return mainMenu();
      };

      await mainMenu();
    },
  });
}
