import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { join } from "node:path";

import { errorMessage, projectSlug, type Store } from "../../src/core/index.ts";

import { logBestEffort } from "./log-best-effort.ts";
import type { MonitorSnapshot } from "./monitor.ts";
import {
  DEFAULT_MAX_RECENT_TASKS,
  pruneOldTasks,
  TaskCompletionNotifier,
} from "./registry/completion.ts";
import {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_STOP_WAIT_MS,
  TaskProcessLifecycle,
} from "./registry/process-lifecycle.ts";
import { TaskMetadataWriter } from "./registry/metadata.ts";
import { DEFAULT_MAX_OUTPUT_BYTES, TaskOutputStream } from "./registry/output-stream.ts";
import { appendError, snapshot, type BgTask } from "./registry/task.ts";

export {
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_RECENT_TASKS,
  DEFAULT_STOP_WAIT_MS,
};
export { MAX_LOG_BYTES, MIN_LOG_BYTES } from "./registry/output-stream.ts";

const NOTIFICATION_TAIL_BYTES = 2000;

export type TaskStatus = "running" | "completed" | "failed" | "killed";
export type KillKind = "user" | "shutdown" | "timeout" | "output_cap" | "write_error";
export type RunLanguage = "zsh" | "typescript" | "python";

export interface BgTaskSnapshot {
  readonly kind: "task";
  readonly id: string;
  readonly name: string;
  readonly command: string;
  readonly cwd: string;
  readonly status: TaskStatus;
  readonly outputPath: string;
  readonly startTime: number;
  readonly endTime: number | undefined;
  readonly exitCode: number | null | undefined;
  readonly signal: string | null | undefined;
  readonly pid: number | undefined;
  readonly bytesWritten: number;
  readonly error: string | undefined;
  readonly notified: boolean;
  readonly wakeOnCompletion: boolean;
  readonly timeoutSeconds: number | undefined;
  /** Why a running task was killed; undefined for a task that exited on its own. */
  readonly killKind: KillKind | undefined;
  /** Set only for a task started from a `run` prepared invocation. */
  readonly language?: RunLanguage;
  /** Set only for a task started from a `run` prepared invocation. */
  readonly stageDir?: string;
}

/**
 * A spawn already resolved to its final argv, bypassing shellInvocation().
 * `command` passed to start() alongside this becomes the task's display name
 * (e.g. "uv run --with requests script.py"), not the string spawned.
 */
export interface PreparedInvocation {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly language?: RunLanguage;
  readonly stageDir?: string;
}

export interface TaskRunContext {
  readonly cwd: string;
  readonly sessionId: string;
}

export interface StartTaskOptions {
  readonly name?: string;
  readonly timeoutSeconds?: number;
  readonly wakeOnCompletion?: boolean;
  /**
   * Attached before the process spawns, unlike onOutput() called after
   * start() resolves — the child can already have written and closed its
   * first chunk during that gap, and a listener attached after would miss it.
   */
  readonly onOutput?: (chunk: string, source: "stdout" | "stderr") => void;
  /** Skip shellInvocation() and spawn this argv directly. */
  readonly invocation?: PreparedInvocation;
  /**
   * Suppresses the completion notification while a foreground caller holds
   * its own waiter on this task (the tool result is the delivery). Cleared
   * by clearAwaited() when the caller detaches, so a later completion still
   * wakes the agent normally.
   */
  readonly awaited?: boolean;
}

export interface ReadOutputOptions {
  readonly maxBytes?: number;
  readonly tail?: boolean;
}

export interface ReadOutputResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly bytesRead: number;
  readonly totalBytes: number;
  readonly outputPath: string;
}

export interface CompletionNotificationMessage {
  readonly customType: "jpi-background-notification";
  readonly content: string;
  readonly display: true;
  readonly details: BgTaskSnapshot | MonitorSnapshot;
}

export interface CompletionNotificationOptions {
  readonly deliverAs: "followUp";
  readonly triggerTurn: boolean;
}

export type CompletionNotificationSender = (
  message: CompletionNotificationMessage,
  options: CompletionNotificationOptions,
) => void;

/** Minimal surface of a spawned child process the registry depends on; lets tests inject a fake. */
export interface BackgroundChildProcess {
  pid?: number | undefined;
  stdout?: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  stderr?: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type BackgroundSpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => BackgroundChildProcess;

export interface BackgroundTaskRegistryOptions {
  readonly store: Store;
  readonly sendNotification: CompletionNotificationSender;
  /** Best-effort bus broadcast of a task's terminal snapshot; failures are logged, never thrown. */
  readonly publishTerminal?: (snapshot: BgTaskSnapshot) => void;
  readonly spawn?: BackgroundSpawnFn;
  readonly killProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readonly now?: () => number;
  readonly makeTaskId?: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxOutputBytes?: number;
  readonly defaultTimeoutSeconds?: number;
  readonly maxRecentTasks?: number;
  readonly killGraceMs?: number;
  readonly stopWaitMs?: number;
  readonly logger?: Pick<Console, "error">;
}

interface RuntimeDir {
  readonly abs: string;
}

function sanitizePathSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  return safe.length > 0 ? safe : "session";
}

function normalizeName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function deriveNameFromCommand(command: string): string {
  const firstLine = (command.split("\n")[0] ?? command).trim();
  return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
}

function shellInvocation(
  command: string,
  env: NodeJS.ProcessEnv,
): { shell: string; args: string[] } {
  const shell = env.SHELL && env.SHELL.length > 0 ? env.SHELL : "/bin/sh";
  return { shell, args: ["-c", command] };
}

function defaultTaskId(): string {
  return `b${randomBytes(4).toString("hex")}`;
}

function noop(): void {
  return undefined;
}

/**
 * Runs shell commands as detached, group-killable background tasks: durable
 * output files, a hard output cap, optional per-task timeout, and a
 * completion wake sent through an injected notifier. POSIX only.
 *
 * Owns the task registry itself (creation, lookup, change/output listeners)
 * and orchestrates four collaborators for everything else: `lifecycle`
 * (spawning and killing the child process), `outputStream` (the durable
 * output file and its byte cap), `metadataWriter` (durable snapshot
 * persistence), and `notifier` (the completion wake and history pruning).
 */
export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BgTask>();
  private readonly changeListeners = new Set<() => void>();
  private runtimeDir: RuntimeDir | undefined;
  private shuttingDown = false;

  private readonly env: NodeJS.ProcessEnv;
  private readonly makeTaskId: () => string;
  private readonly now: () => number;
  private readonly maxRecentTasks: number;
  private readonly logger: Pick<Console, "error">;
  private readonly sendNotification: CompletionNotificationSender;
  private readonly publishTerminal: (snapshot: BgTaskSnapshot) => void;
  private readonly store: Store;

  private readonly lifecycle: TaskProcessLifecycle;
  private readonly outputStream: TaskOutputStream;
  private readonly metadataWriter: TaskMetadataWriter;
  private readonly notifier: TaskCompletionNotifier;

  private defaultTimeoutSeconds: number | undefined;

  constructor(options: BackgroundTaskRegistryOptions) {
    this.store = options.store;
    this.env = options.env ?? process.env;
    this.makeTaskId = options.makeTaskId ?? defaultTaskId;
    this.now = options.now ?? Date.now;
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds;
    this.maxRecentTasks = options.maxRecentTasks ?? DEFAULT_MAX_RECENT_TASKS;
    this.logger = options.logger ?? console;
    this.sendNotification = options.sendNotification;
    this.publishTerminal = options.publishTerminal ?? noop;

    this.lifecycle = new TaskProcessLifecycle({
      spawn:
        options.spawn ??
        ((command, args, spawnOptions) =>
          nodeSpawn(command, args, spawnOptions) as unknown as BackgroundChildProcess),
      killProcess:
        options.killProcess ??
        ((pid, signal) => {
          process.kill(pid, signal);
        }),
      killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
      stopWaitMs: options.stopWaitMs ?? DEFAULT_STOP_WAIT_MS,
    });
    this.outputStream = new TaskOutputStream(
      {
        onWriteError: (task) => {
          try {
            this.lifecycle.requestKill(task, "SIGTERM");
          } catch {
            void this.finalizeTask(task, "failed", null, undefined, task.error);
          }
        },
        onCapExceeded: (task) => {
          try {
            this.lifecycle.requestKill(task, "SIGTERM");
          } catch (error) {
            task.error = appendError(task.error, `kill failed: ${errorMessage(error)}`);
            void this.finalizeTask(task, "failed", null, undefined, task.error);
          }
        },
      },
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    );
    this.metadataWriter = new TaskMetadataWriter();
    this.notifier = new TaskCompletionNotifier(this.sendNotification);
  }

  /** Apply freshly loaded config. A defaultTimeoutSeconds of 0 means "no default timeout". */
  configure(options: { maxOutputBytes?: number; defaultTimeoutSeconds?: number }): void {
    if (options.maxOutputBytes !== undefined) this.outputStream.configure(options.maxOutputBytes);
    if (options.defaultTimeoutSeconds !== undefined) {
      this.defaultTimeoutSeconds =
        options.defaultTimeoutSeconds > 0 ? options.defaultTimeoutSeconds : undefined;
    }
  }

  /**
   * Undo shutdown for a fresh session in the same extension process: Pi can
   * fire session_shutdown (reload/new/resume/fork) and then a new
   * session_start against this same registry. Finished-task history is kept.
   */
  reset(): void {
    this.shuttingDown = false;
    this.runtimeDir = undefined;
  }

  list(): BgTaskSnapshot[] {
    return [...this.tasks.values()].map(snapshot);
  }

  get(idOrPrefix: string): BgTaskSnapshot {
    return snapshot(this.resolveTask(idOrPrefix));
  }

  onChange(callback: () => void): () => void {
    this.changeListeners.add(callback);
    return () => this.changeListeners.delete(callback);
  }

  onOutput(
    idOrPrefix: string,
    callback: (chunk: string, source: "stdout" | "stderr") => void,
  ): () => void {
    const task = this.resolveTask(idOrPrefix);
    task.outputListeners.add(callback);
    return () => task.outputListeners.delete(callback);
  }

  async start(
    ctx: TaskRunContext,
    command: string,
    options: StartTaskOptions = {},
  ): Promise<BgTaskSnapshot> {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) throw new Error("Background command is empty");
    if (this.shuttingDown) throw new Error("Cannot start a background task while shutting down");

    const dir = await this.ensureRuntimeDir(ctx);
    const id = this.makeTaskId();
    const outputAbsPath = join(dir.abs, `${id}.output`);
    const metadataAbsPath = join(dir.abs, `${id}.json`);
    const outputPath = outputAbsPath;
    const timeoutSeconds = options.timeoutSeconds ?? this.defaultTimeoutSeconds;
    const spawnCwd = options.invocation?.cwd ?? ctx.cwd;

    const task: BgTask = {
      id,
      name: normalizeName(options.name) ?? deriveNameFromCommand(normalizedCommand),
      command: normalizedCommand,
      cwd: spawnCwd,
      status: "running",
      outputPath,
      outputAbsPath,
      metadataAbsPath,
      startTime: this.now(),
      endTime: undefined,
      exitCode: undefined,
      signal: undefined,
      pid: undefined,
      bytesWritten: 0,
      capExceeded: false,
      killKind: undefined,
      killSignalSent: false,
      killEscalationTimer: undefined,
      timeoutHandle: undefined,
      timeoutSeconds,
      wakeOnCompletion: options.wakeOnCompletion ?? true,
      notified: false,
      error: undefined,
      finalized: false,
      awaited: options.awaited ?? false,
      language: options.invocation?.language,
      stageDir: options.invocation?.stageDir,
      child: undefined,
      stream: undefined,
      waiters: [],
      outputListeners: new Set(),
      metadataWriteChain: undefined,
    };
    if (options.onOutput) task.outputListeners.add(options.onOutput);
    this.tasks.set(id, task);

    task.stream = this.outputStream.open(task, outputAbsPath);

    try {
      const spawnInvocation = options.invocation
        ? { shell: options.invocation.argv[0] ?? "", args: options.invocation.argv.slice(1) }
        : shellInvocation(normalizedCommand, this.env);
      if (!spawnInvocation.shell) throw new Error("Prepared invocation argv must not be empty");
      const child = this.lifecycle.spawn(spawnInvocation.shell, spawnInvocation.args, {
        cwd: spawnCwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: this.env,
      });
      task.child = child;
      task.pid = child.pid;

      child.stdout?.on("data", (chunk) =>
        this.outputStream.handleChildOutput(task, chunk, "stdout"),
      );
      child.stderr?.on("data", (chunk) =>
        this.outputStream.handleChildOutput(task, chunk, "stderr"),
      );

      child.on("error", (error) => {
        this.outputStream.writeNotice(
          task,
          `\n[background task spawn error: ${errorMessage(error)}]\n`,
        );
        void this.finalizeTask(task, "failed", null, undefined, errorMessage(error));
      });

      child.on("close", (code, signalName) => {
        const { status, error } = this.lifecycle.resolveCloseOutcome(task, code, signalName);
        void this.finalizeTask(task, status, code, signalName, error);
      });

      if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
        task.timeoutHandle = setTimeout(() => {
          if (task.status !== "running") return;
          task.killKind = "timeout";
          task.error = `Timed out after ${timeoutSeconds}s`;
          this.outputStream.writeNotice(task, `\n[background task timeout: ${task.error}]\n`);
          try {
            this.lifecycle.requestKill(task, "SIGTERM");
          } catch (error) {
            void this.finalizeTask(
              task,
              "failed",
              null,
              undefined,
              `${task.error}; kill failed: ${errorMessage(error)}`,
            );
          }
        }, timeoutSeconds * 1000);
        task.timeoutHandle.unref?.();
      }

      await this.writeMetadata(task);
      this.emitChange();
      return snapshot(task);
    } catch (error) {
      const failure = errorMessage(error);
      this.outputStream.writeNotice(task, `\n[background task spawn exception: ${failure}]\n`);
      await this.finalizeTask(task, "failed", null, undefined, failure);
      throw new Error(`Failed to start background task: ${failure}`);
    }
  }

  async stop(idOrPrefix: string): Promise<BgTaskSnapshot> {
    const task = this.resolveTask(idOrPrefix);
    return snapshot(await this.lifecycle.stopTask(task, "user"));
  }

  /**
   * Absolute session runtime dir for `ctx`, created if needed — the same dir
   * start() writes `<id>.output`/`<id>.json` into. Lets `run` stage a
   * prepared execution beside the task logs before the task exists.
   */
  async ensureSessionDir(ctx: TaskRunContext): Promise<string> {
    return (await this.ensureRuntimeDir(ctx)).abs;
  }

  /**
   * Resolves once the task reaches a terminal state, or immediately if it
   * already has. Unlike stop(), this never touches the process — it is the
   * foreground `run` wait, which a ctrl+b detach races via AbortSignal.
   */
  waitForTask(idOrPrefix: string): Promise<BgTaskSnapshot> {
    const task = this.resolveTask(idOrPrefix);
    if (task.status !== "running") return Promise.resolve(snapshot(task));
    return new Promise((resolve) => {
      task.waiters.push(() => resolve(snapshot(task)));
    });
  }

  /** Re-arms the completion wake for a task whose foreground caller detached. */
  clearAwaited(idOrPrefix: string): void {
    this.resolveTask(idOrPrefix).awaited = false;
  }

  async readOutput(idOrPrefix: string, options: ReadOutputOptions = {}): Promise<ReadOutputResult> {
    const task = this.resolveTask(idOrPrefix);
    return this.outputStream.readOutput(task, options);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const running = [...this.tasks.values()].filter((task) => task.status === "running");
    await Promise.all(
      running.map((task) =>
        logBestEffort(this.logger, `shutdown kill failed for task ${task.id}`, () =>
          this.lifecycle.stopTask(task, "shutdown"),
        ),
      ),
    );
  }

  private resolveTask(idOrPrefix: string): BgTask {
    const id = idOrPrefix.trim();
    if (!id) throw new Error("Task id is required");
    const exact = this.tasks.get(id);
    if (exact) return exact;
    const matches = [...this.tasks.values()].filter((task) => task.id.startsWith(id));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(
        `Task id "${id}" is ambiguous: matches ${matches.map((task) => task.id).join(", ")}`,
      );
    }
    throw new Error(`No background task matches id "${id}"`);
  }

  /** Relative to the store's own root: `<projectSlug(cwd)>/<sanitizedSessionId>-<pid>`. */
  private relativeSessionDir(ctx: TaskRunContext): string {
    const runId = `${sanitizePathSegment(ctx.sessionId)}-${process.pid}`;
    return join(projectSlug(ctx.cwd), runId);
  }

  private async ensureRuntimeDir(ctx: TaskRunContext): Promise<RuntimeDir> {
    if (this.runtimeDir) return this.runtimeDir;
    const abs = await this.store.ensureDirectory(this.relativeSessionDir(ctx));
    this.runtimeDir = { abs };
    return this.runtimeDir;
  }

  /**
   * Absolute path of ctx's session dir, without creating it. Used by the
   * startup sweep to protect the current session's own dir from cleanup.
   */
  sessionDirPath(ctx: TaskRunContext): string {
    return this.store.path(this.relativeSessionDir(ctx));
  }

  private async writeMetadata(task: BgTask, value: BgTaskSnapshot = snapshot(task)): Promise<void> {
    await this.metadataWriter.write(task, value);
  }

  private async finalizeTask(
    task: BgTask,
    status: TaskStatus,
    exitCode: number | null,
    signalName?: NodeJS.Signals | null,
    error?: string,
  ): Promise<void> {
    if (task.finalized) return;
    task.finalized = true;
    if (task.timeoutHandle) clearTimeout(task.timeoutHandle);
    if (task.killEscalationTimer !== undefined) {
      clearTimeout(task.killEscalationTimer);
      task.killEscalationTimer = undefined;
    }

    let finalStatus = status;
    let finalError = error ? appendError(task.error, error) : task.error;
    if (task.stream && !task.stream.destroyed) {
      try {
        await this.outputStream.close(task.stream);
      } catch (closeError) {
        finalStatus = "failed";
        finalError = appendError(
          finalError,
          `output stream close failed: ${errorMessage(closeError)}`,
        );
      }
    }

    // Build the terminal snapshot locally instead of mutating `task` yet: a
    // listener reacting to this task must never observe "done" before the
    // metadata reflecting that state is durable on disk.
    const terminalSnapshot: BgTaskSnapshot = {
      ...snapshot(task),
      status: finalStatus,
      exitCode,
      signal: signalName ?? null,
      endTime: this.now(),
      error: finalError,
    };
    await logBestEffort(this.logger, `metadata write failed for task ${task.id}`, () =>
      this.writeMetadata(task, terminalSnapshot),
    );

    task.exitCode = terminalSnapshot.exitCode;
    task.signal = terminalSnapshot.signal;
    task.endTime = terminalSnapshot.endTime;
    task.error = terminalSnapshot.error;
    task.status = terminalSnapshot.status;

    for (const waiter of task.waiters.splice(0)) waiter();
    this.emitChange();

    void logBestEffort(this.logger, `terminal publish failed for task ${task.id}`, () =>
      this.publishTerminal(terminalSnapshot),
    );

    if (!this.shuttingDown) {
      let outputTail = "";
      try {
        outputTail = await this.outputStream.tail(task.outputAbsPath, NOTIFICATION_TAIL_BYTES);
      } catch {
        // Best effort: an unreadable output file must not block the wake.
      }
      void logBestEffort(this.logger, `notification failed for task ${task.id}`, () =>
        this.notifier.notify(task, outputTail),
      );
    }

    pruneOldTasks(this.tasks, this.maxRecentTasks);
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }
}
