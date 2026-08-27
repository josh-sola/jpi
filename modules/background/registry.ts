import { randomBytes } from "node:crypto";
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";

import { errorMessage, projectSlug, type Store } from "../../src/core/index.ts";

import { writeJsonAtomic } from "./durable-write.ts";
import type { MonitorSnapshot } from "./monitor.ts";
import { NOTIFICATION_PREAMBLE_LINES } from "./prompts.ts";

export const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
export const DEFAULT_KILL_GRACE_MS = 3000;
export const DEFAULT_STOP_WAIT_MS = 4500;
export const DEFAULT_MAX_RECENT_TASKS = 20;
export const MIN_LOG_BYTES = 1;
export const MAX_LOG_BYTES = 50 * 1024;
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

interface BgTask {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: TaskStatus;
  outputPath: string;
  outputAbsPath: string;
  metadataAbsPath: string;
  startTime: number;
  endTime: number | undefined;
  exitCode: number | null | undefined;
  signal: string | null | undefined;
  pid: number | undefined;
  bytesWritten: number;
  capExceeded: boolean;
  killKind: KillKind | undefined;
  killSignalSent: boolean;
  killEscalationTimer: NodeJS.Timeout | undefined;
  timeoutHandle: NodeJS.Timeout | undefined;
  timeoutSeconds: number | undefined;
  wakeOnCompletion: boolean;
  notified: boolean;
  error: string | undefined;
  finalized: boolean;
  awaited: boolean;
  language: RunLanguage | undefined;
  stageDir: string | undefined;
  child: BackgroundChildProcess | undefined;
  stream: WriteStream | undefined;
  waiters: Array<() => void>;
  outputListeners: Set<(chunk: string, source: "stdout" | "stderr") => void>;
  metadataWriteChain: Promise<void> | undefined;
}

function appendError(existing: string | undefined, next: string): string {
  if (!existing) return next;
  if (existing.includes(next)) return existing;
  return `${existing}; ${next}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
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

function clampMaxBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_LOG_BYTES;
  return Math.max(MIN_LOG_BYTES, Math.min(MAX_LOG_BYTES, Math.floor(value)));
}

function closeOutputStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.off("error", fail);
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.off("close", finish);
      reject(error);
    };
    stream.once("close", finish);
    stream.once("error", fail);
    stream.end();
  });
}

async function boundedRead(
  filePath: string,
  maxBytes: number,
  tail: boolean,
): Promise<{ content: string; truncated: boolean; bytesRead: number; totalBytes: number }> {
  const stats = await stat(filePath);
  const totalBytes = stats.size;
  const bytesToRead = Math.min(totalBytes, maxBytes);
  if (bytesToRead === 0) return { content: "", truncated: false, bytesRead: 0, totalBytes };

  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const position = tail ? Math.max(0, totalBytes - bytesToRead) : 0;
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: totalBytes > bytesRead,
      bytesRead,
      totalBytes,
    };
  } finally {
    await file.close();
  }
}

function snapshot(task: BgTask): BgTaskSnapshot {
  return {
    kind: "task",
    id: task.id,
    name: task.name,
    command: task.command,
    cwd: task.cwd,
    status: task.status,
    outputPath: task.outputPath,
    startTime: task.startTime,
    endTime: task.endTime,
    exitCode: task.exitCode,
    signal: task.signal,
    pid: task.pid,
    bytesWritten: task.bytesWritten,
    error: task.error,
    notified: task.notified,
    wakeOnCompletion: task.wakeOnCompletion,
    timeoutSeconds: task.timeoutSeconds,
    killKind: task.killKind,
    language: task.language,
    stageDir: task.stageDir,
  };
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
 */
export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BgTask>();
  private readonly changeListeners = new Set<() => void>();
  private runtimeDir: RuntimeDir | undefined;
  private shuttingDown = false;

  private readonly spawnFn: BackgroundSpawnFn;
  private readonly killProcessFn: (pid: number, signal: NodeJS.Signals) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly makeTaskId: () => string;
  private readonly now: () => number;
  private readonly maxRecentTasks: number;
  private readonly killGraceMs: number;
  private readonly stopWaitMs: number;
  private readonly logger: Pick<Console, "error">;
  private readonly sendNotification: CompletionNotificationSender;
  private readonly publishTerminal: (snapshot: BgTaskSnapshot) => void;
  private readonly store: Store;

  private maxOutputBytes: number;
  private defaultTimeoutSeconds: number | undefined;

  constructor(options: BackgroundTaskRegistryOptions) {
    this.store = options.store;
    this.spawnFn =
      options.spawn ??
      ((command, args, spawnOptions) =>
        nodeSpawn(command, args, spawnOptions) as unknown as BackgroundChildProcess);
    this.killProcessFn =
      options.killProcess ??
      ((pid, signal) => {
        process.kill(pid, signal);
      });
    this.env = options.env ?? process.env;
    this.makeTaskId = options.makeTaskId ?? defaultTaskId;
    this.now = options.now ?? Date.now;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds;
    this.maxRecentTasks = options.maxRecentTasks ?? DEFAULT_MAX_RECENT_TASKS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.stopWaitMs = options.stopWaitMs ?? DEFAULT_STOP_WAIT_MS;
    this.logger = options.logger ?? console;
    this.sendNotification = options.sendNotification;
    this.publishTerminal = options.publishTerminal ?? noop;
  }

  /** Apply freshly loaded config. A defaultTimeoutSeconds of 0 means "no default timeout". */
  configure(options: { maxOutputBytes?: number; defaultTimeoutSeconds?: number }): void {
    if (options.maxOutputBytes !== undefined) this.maxOutputBytes = options.maxOutputBytes;
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

    const stream = createWriteStream(outputAbsPath, { flags: "a" });
    task.stream = stream;
    stream.on("error", (error) => {
      if (task.status !== "running") return;
      task.error = appendError(task.error, `output file write failed: ${errorMessage(error)}`);
      task.killKind = task.killKind ?? "write_error";
      try {
        this.requestKill(task, "SIGTERM");
      } catch {
        void this.finalizeTask(task, "failed", null, undefined, task.error);
      }
    });

    try {
      const spawnInvocation = options.invocation
        ? { shell: options.invocation.argv[0] ?? "", args: options.invocation.argv.slice(1) }
        : shellInvocation(normalizedCommand, this.env);
      if (!spawnInvocation.shell) throw new Error("Prepared invocation argv must not be empty");
      const child = this.spawnFn(spawnInvocation.shell, spawnInvocation.args, {
        cwd: spawnCwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: this.env,
      });
      task.child = child;
      task.pid = child.pid;

      child.stdout?.on("data", (chunk) => this.handleChildOutput(task, chunk, "stdout"));
      child.stderr?.on("data", (chunk) => this.handleChildOutput(task, chunk, "stderr"));

      child.on("error", (error) => {
        this.writeNotice(task, `\n[background task spawn error: ${errorMessage(error)}]\n`);
        void this.finalizeTask(task, "failed", null, undefined, errorMessage(error));
      });

      child.on("close", (code, signalName) => {
        const { status, error } = this.resolveCloseOutcome(task, code, signalName);
        void this.finalizeTask(task, status, code, signalName, error);
      });

      if (timeoutSeconds !== undefined && timeoutSeconds > 0) {
        task.timeoutHandle = setTimeout(() => {
          if (task.status !== "running") return;
          task.killKind = "timeout";
          task.error = `Timed out after ${timeoutSeconds}s`;
          this.writeNotice(task, `\n[background task timeout: ${task.error}]\n`);
          try {
            this.requestKill(task, "SIGTERM");
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
      this.writeNotice(task, `\n[background task spawn exception: ${failure}]\n`);
      await this.finalizeTask(task, "failed", null, undefined, failure);
      throw new Error(`Failed to start background task: ${failure}`);
    }
  }

  async stop(idOrPrefix: string): Promise<BgTaskSnapshot> {
    const task = this.resolveTask(idOrPrefix);
    return snapshot(await this.stopTask(task, "user"));
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
    const tail = options.tail ?? true;
    const maxBytes = clampMaxBytes(options.maxBytes);

    if (!existsSync(task.outputAbsPath)) {
      return {
        text: "(no output yet)",
        truncated: false,
        bytesRead: 0,
        totalBytes: 0,
        outputPath: task.outputPath,
      };
    }

    const read = await boundedRead(task.outputAbsPath, maxBytes, tail);
    let text = read.content.length > 0 ? read.content : "(no output yet)";
    if (read.truncated) {
      const omitted = read.totalBytes - read.bytesRead;
      const direction = tail ? "tail" : "head";
      const notice = `[Showing ${direction} ${read.bytesRead} of ${read.totalBytes} bytes; ${omitted} omitted. Full output: ${task.outputPath}]`;
      text = tail ? `${notice}\n${text}` : `${text}\n${notice}`;
    } else {
      text += `\n[Full output: ${task.outputPath}]`;
    }

    return {
      text,
      truncated: read.truncated,
      bytesRead: read.bytesRead,
      totalBytes: read.totalBytes,
      outputPath: task.outputPath,
    };
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const running = [...this.tasks.values()].filter((task) => task.status === "running");
    await Promise.all(
      running.map(async (task) => {
        try {
          await this.stopTask(task, "shutdown");
        } catch (error) {
          this.logger.error(`[jpi-background] shutdown kill failed for task ${task.id}:`, error);
        }
      }),
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

  private resolveCloseOutcome(
    task: BgTask,
    code: number | null,
    signalName: NodeJS.Signals | null,
  ): { status: TaskStatus; error: string | undefined } {
    if (task.killKind === "user" || task.killKind === "shutdown") {
      return { status: "killed", error: undefined };
    }
    if (
      task.killKind === "timeout" ||
      task.killKind === "output_cap" ||
      task.killKind === "write_error"
    ) {
      return { status: "failed", error: undefined };
    }
    if ((code ?? 0) === 0) return { status: "completed", error: undefined };
    return {
      status: "failed",
      error: `Exited with code ${code === null ? "null" : code}${signalName ? ` (${signalName})` : ""}`,
    };
  }

  private handleChildOutput(task: BgTask, chunk: Buffer, source: "stdout" | "stderr"): void {
    if (chunk.length === 0) return;
    if (task.outputListeners.size > 0) {
      const text = chunk.toString("utf8");
      for (const listener of task.outputListeners) listener(text, source);
    }
    this.writeToStream(task, chunk);
  }

  private writeToStream(task: BgTask, buffer: Buffer): void {
    if (!task.stream || task.stream.destroyed || buffer.length === 0) return;

    const nextBytes = task.bytesWritten + buffer.length;
    if (nextBytes <= this.maxOutputBytes) {
      task.stream.write(buffer);
      task.bytesWritten = nextBytes;
      return;
    }

    const remaining = Math.max(0, this.maxOutputBytes - task.bytesWritten);
    if (remaining > 0) {
      task.stream.write(buffer.subarray(0, remaining));
      task.bytesWritten += remaining;
    }

    if (task.capExceeded) return;
    task.capExceeded = true;
    task.error = `Output exceeded the ${formatBytes(this.maxOutputBytes)} cap; task was killed`;
    const notice = `\n[background task output cap: ${task.error}]\n`;
    task.stream.write(notice);
    task.bytesWritten += Buffer.byteLength(notice, "utf8");
    task.killKind = "output_cap";
    try {
      this.requestKill(task, "SIGTERM");
    } catch (error) {
      task.error = appendError(task.error, `kill failed: ${errorMessage(error)}`);
      void this.finalizeTask(task, "failed", null, undefined, task.error);
    }
  }

  private writeNotice(task: BgTask, text: string): void {
    this.writeToStream(task, Buffer.from(text, "utf8"));
  }

  private requestKill(task: BgTask, signal: NodeJS.Signals): void {
    if (task.status !== "running")
      throw new Error(`Task ${task.id} is ${task.status}, not running`);
    if (!task.child || task.pid === undefined)
      throw new Error(`Task ${task.id} has no process to kill`);
    if (task.killSignalSent && signal === "SIGTERM") return;

    const errors: string[] = [];
    let killed = false;
    try {
      this.killProcessFn(-task.pid, signal);
      killed = true;
    } catch (error) {
      errors.push(`process group kill failed: ${errorMessage(error)}`);
    }
    if (!killed) {
      try {
        task.child.kill(signal);
        killed = true;
      } catch (error) {
        errors.push(`child kill failed: ${errorMessage(error)}`);
      }
    }
    if (!killed) throw new Error(`Could not kill task ${task.id}: ${errors.join("; ")}`);

    task.killSignalSent = true;
    // SIGKILL is the terminal escalation; it must never schedule a further one.
    if (signal === "SIGKILL") return;
    // Only one escalation timer may be outstanding, so concurrent stop
    // requests on the same task never arm a second one.
    if (task.killEscalationTimer !== undefined) return;
    task.killEscalationTimer = setTimeout(() => {
      task.killEscalationTimer = undefined;
      if (task.status !== "running") return;
      try {
        this.requestKill(task, "SIGKILL");
      } catch (error) {
        task.error = appendError(task.error, `SIGKILL failed: ${errorMessage(error)}`);
      }
    }, this.killGraceMs);
    task.killEscalationTimer.unref?.();
  }

  private async stopTask(task: BgTask, kind: KillKind, reason?: string): Promise<BgTask> {
    if (task.status !== "running")
      throw new Error(`Task ${task.id} is ${task.status}, not running`);
    task.killKind = kind;
    if (reason) task.error = reason;
    this.requestKill(task, "SIGTERM");
    const stopped = await this.waitForEnd(task, this.stopWaitMs);
    if (!stopped)
      throw new Error(
        `Task ${task.id} did not exit within ${this.stopWaitMs}ms after cancellation`,
      );
    return task;
  }

  private waitForEnd(task: BgTask, timeoutMs: number): Promise<boolean> {
    if (task.status !== "running") return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const index = task.waiters.indexOf(done);
        if (index >= 0) task.waiters.splice(index, 1);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      task.waiters.push(done);
    });
  }

  private async writeMetadata(task: BgTask, value: BgTaskSnapshot = snapshot(task)): Promise<void> {
    const previous = task.metadataWriteChain ?? Promise.resolve();
    const write = () => writeJsonAtomic(task.metadataAbsPath, value);
    const next = previous.then(write, write);
    task.metadataWriteChain = next.catch(noop);
    await next;
  }

  private buildNotificationContent(task: BgTask, outputTail: string): string {
    const lines = [
      ...NOTIFICATION_PREAMBLE_LINES,
      `task_id: ${task.id}`,
      `name: ${task.name}`,
      `status: ${task.status}`,
    ];
    if (task.exitCode !== undefined && task.exitCode !== null)
      lines.push(`exit_code: ${task.exitCode}`);
    if (task.error) lines.push(`error: ${task.error}`);
    lines.push(`output_path: ${task.outputPath}`);
    lines.push("output_tail:", outputTail.length > 0 ? outputTail : "(no output)");
    lines.push("Use bg_logs to read more output if needed. Do not poll for status.");
    return lines.join("\n");
  }

  /** Sends the completion wake at most once per task; resets the flag and rethrows if the sender fails. */
  private notifyCompletion(task: BgTask, outputTail: string): void {
    if (!task.wakeOnCompletion || task.notified || task.awaited) return;
    task.notified = true;
    const content = this.buildNotificationContent(task, outputTail);
    try {
      this.sendNotification(
        {
          customType: "jpi-background-notification",
          content,
          display: true,
          details: snapshot(task),
        },
        { deliverAs: "followUp", triggerTurn: task.wakeOnCompletion },
      );
    } catch (error) {
      task.notified = false;
      throw error;
    }
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
        await closeOutputStream(task.stream);
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
    try {
      await this.writeMetadata(task, terminalSnapshot);
    } catch (writeError) {
      this.logger.error(`[jpi-background] metadata write failed for task ${task.id}:`, writeError);
    }

    task.exitCode = terminalSnapshot.exitCode;
    task.signal = terminalSnapshot.signal;
    task.endTime = terminalSnapshot.endTime;
    task.error = terminalSnapshot.error;
    task.status = terminalSnapshot.status;

    for (const waiter of task.waiters.splice(0)) waiter();
    this.emitChange();

    try {
      this.publishTerminal(terminalSnapshot);
    } catch (publishError) {
      this.logger.error(
        `[jpi-background] terminal publish failed for task ${task.id}:`,
        publishError,
      );
    }

    if (!this.shuttingDown) {
      let outputTail = "";
      try {
        const read = await boundedRead(task.outputAbsPath, NOTIFICATION_TAIL_BYTES, true);
        outputTail = read.content;
      } catch {
        // Best effort: an unreadable output file must not block the wake.
      }
      try {
        this.notifyCompletion(task, outputTail);
      } catch (notifyError) {
        this.logger.error(`[jpi-background] notification failed for task ${task.id}:`, notifyError);
      }
    }

    this.pruneOldTasks();
  }

  private pruneOldTasks(): void {
    if (this.tasks.size <= this.maxRecentTasks) return;
    const finished = [...this.tasks.values()]
      .filter((task) => task.status !== "running")
      .sort((a, b) => (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime));
    while (this.tasks.size > this.maxRecentTasks && finished.length > 0) {
      const task = finished.shift();
      if (task) this.tasks.delete(task.id);
    }
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }
}
