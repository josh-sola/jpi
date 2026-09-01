import { randomBytes } from "node:crypto";

import { Cron } from "croner";

import { errorMessage, type Store } from "../../src/core/index.ts";
import { SCHEDULE_NOTIFICATION_TYPE } from "./notification-renderer.ts";
import { SCHEDULE_NOTIFICATION_PREAMBLE_LINES } from "./prompts.ts";
import { saveScheduleFile, type PersistedSchedule } from "./store.ts";

export type { PersistedSchedule } from "./store.ts";

const DEFAULT_MAX_SCHEDULES = 10;

/** Validates a cron expression via croner's own parser (5- or 6-field, `auto` mode), in try/catch. */
export function validateCronExpression(expression: string): void {
  try {
    new Cron(expression);
  } catch (error) {
    throw new Error(`Invalid cron expression "${expression}": ${errorMessage(error)}`);
  }
}

/** Minimal surface `ScheduleRegistry` needs from a live croner job. */
export interface CronLike {
  nextRun(): Date | null;
  stop(): void;
}

/** Injectable croner constructor, so tests can supply a fake armed job. */
export type CronFactory = (expression: string, callback: () => void) => CronLike;

export interface ScheduleSnapshot extends PersistedSchedule {
  readonly nextRun: number | undefined;
}

export interface ScheduleNotificationMessage {
  readonly customType: typeof SCHEDULE_NOTIFICATION_TYPE;
  readonly content: string;
  readonly display: true;
  readonly details: ScheduleSnapshot;
}

export interface ScheduleNotificationOptions {
  readonly deliverAs: "followUp";
  readonly triggerTurn: true;
}

export type ScheduleNotificationSender = (
  message: ScheduleNotificationMessage,
  options: ScheduleNotificationOptions,
) => void;

interface ScheduleEntry {
  readonly id: string;
  prompt: string;
  cronExpression: string;
  createdAt: number;
  runCount: number;
  lastFiredAt: number | undefined;
  timer: CronLike;
}

export interface ScheduleRegistryOptions {
  readonly store: Store;
  readonly sendNotification: ScheduleNotificationSender;
  readonly now?: () => number;
  readonly makeId?: () => string;
  readonly createCron?: CronFactory;
  readonly maxSchedules?: number;
  readonly logger?: Pick<Console, "error">;
}

function defaultId(): string {
  return `s${randomBytes(4).toString("hex")}`;
}

function cronSummary(expression: string): string {
  return `cron "${expression}"`;
}

function toPersisted(entry: ScheduleEntry): PersistedSchedule {
  return {
    id: entry.id,
    prompt: entry.prompt,
    cronExpression: entry.cronExpression,
    createdAt: entry.createdAt,
    runCount: entry.runCount,
    ...(entry.lastFiredAt !== undefined && { lastFiredAt: entry.lastFiredAt }),
  };
}

function computeNextRun(entry: ScheduleEntry): number | undefined {
  const next = entry.timer.nextRun();
  return next ? next.getTime() : undefined;
}

function snapshot(entry: ScheduleEntry): ScheduleSnapshot {
  return { ...toPersisted(entry), nextRun: computeNextRun(entry) };
}

function buildFireContent(entry: ScheduleEntry): string {
  return [
    ...SCHEDULE_NOTIFICATION_PREAMBLE_LINES,
    "",
    `Scheduled prompt "${entry.id}" fired (${cronSummary(entry.cronExpression)}):`,
    "",
    entry.prompt,
  ].join("\n");
}

/**
 * In-memory registry of one session's scheduled prompts, each backed by a
 * croner cron job. Owns arming/disarming timers, change notifications for
 * the status chip and overlay, and durable persistence through the injected
 * store.
 */
export class ScheduleRegistry {
  private readonly schedules = new Map<string, ScheduleEntry>();
  private readonly changeListeners = new Set<() => void>();
  private readonly store: Store;
  private readonly sendNotification: ScheduleNotificationSender;
  private readonly now: () => number;
  private readonly makeId: () => string;
  private readonly createCron: CronFactory;
  private readonly logger: Pick<Console, "error">;
  private maxSchedules: number;
  private sessionId: string | undefined;

  constructor(options: ScheduleRegistryOptions) {
    this.store = options.store;
    this.sendNotification = options.sendNotification;
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? defaultId;
    this.createCron =
      options.createCron ?? ((expression, callback) => new Cron(expression, callback));
    this.logger = options.logger ?? console;
    this.maxSchedules = options.maxSchedules ?? DEFAULT_MAX_SCHEDULES;
  }

  /** Apply freshly loaded config. */
  configure(options: { maxSchedules?: number }): void {
    if (options.maxSchedules !== undefined) this.maxSchedules = options.maxSchedules;
  }

  /** Call from session_start, before restore(), so mutations save to the right session file. */
  setSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  onChange(callback: () => void): () => void {
    this.changeListeners.add(callback);
    return () => this.changeListeners.delete(callback);
  }

  create(prompt: string, cronExpression: string): ScheduleSnapshot {
    const trimmed = prompt.trim();
    if (!trimmed) throw new Error("Scheduled prompt is empty");
    if (this.schedules.size >= this.maxSchedules) {
      throw new Error(`Cannot exceed ${this.maxSchedules} scheduled prompts`);
    }
    validateCronExpression(cronExpression);

    const id = this.makeId();
    const entry: ScheduleEntry = {
      id,
      prompt: trimmed,
      cronExpression,
      createdAt: this.now(),
      runCount: 0,
      lastFiredAt: undefined,
      timer: this.createCron(cronExpression, () => this.fire(id)),
    };
    this.schedules.set(id, entry);
    this.emitChange();
    void this.save();
    return snapshot(entry);
  }

  stop(idOrPrefix: string): ScheduleSnapshot {
    const entry = this.resolve(idOrPrefix);
    entry.timer.stop();
    this.schedules.delete(entry.id);
    this.emitChange();
    void this.save();
    return snapshot(entry);
  }

  list(): ScheduleSnapshot[] {
    return [...this.schedules.values()].map(snapshot);
  }

  get(idOrPrefix: string): ScheduleSnapshot {
    return snapshot(this.resolve(idOrPrefix));
  }

  /** Stops every timer and clears the map without saving; call before restore() and on shutdown. */
  reset(): void {
    for (const entry of this.schedules.values()) entry.timer.stop();
    this.schedules.clear();
  }

  /** Re-arms schedules loaded from the current session's store file. */
  restore(persisted: readonly PersistedSchedule[]): void {
    for (const saved of persisted) {
      try {
        const timer = this.createCron(saved.cronExpression, () => this.fire(saved.id));
        this.schedules.set(saved.id, {
          id: saved.id,
          prompt: saved.prompt,
          cronExpression: saved.cronExpression,
          createdAt: saved.createdAt,
          runCount: saved.runCount,
          lastFiredAt: saved.lastFiredAt,
          timer,
        });
      } catch (error) {
        this.logger.error(
          `jpi-schedule: could not restore schedule ${saved.id}: ${errorMessage(error)}`,
        );
      }
    }
    this.emitChange();
  }

  private resolve(idOrPrefix: string): ScheduleEntry {
    const id = idOrPrefix.trim();
    if (!id) throw new Error("Schedule id is required");
    const exact = this.schedules.get(id);
    if (exact) return exact;
    const matches = [...this.schedules.values()].filter((entry) => entry.id.startsWith(id));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(
        `Schedule id "${id}" is ambiguous: matches ${matches.map((entry) => entry.id).join(", ")}`,
      );
    }
    throw new Error(`No scheduled prompt matches id "${id}"`);
  }

  private fire(id: string): void {
    const entry = this.schedules.get(id);
    if (!entry) return;
    entry.runCount += 1;
    entry.lastFiredAt = this.now();
    this.emitChange();
    void this.save();
    this.sendNotification(
      {
        customType: SCHEDULE_NOTIFICATION_TYPE,
        content: buildFireContent(entry),
        display: true,
        details: snapshot(entry),
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  private async save(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await saveScheduleFile(
        this.store,
        this.sessionId,
        [...this.schedules.values()].map(toPersisted),
      );
    } catch (error) {
      this.logger.error(`jpi-schedule: could not save schedules: ${errorMessage(error)}`);
    }
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }
}
