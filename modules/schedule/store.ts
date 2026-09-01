import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { sanitizeStoreSegment, type Store } from "../../src/core/index.ts";

const SCHEDULE_STORE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PersistedSchedule {
  readonly id: string;
  readonly prompt: string;
  readonly cronExpression: string;
  readonly createdAt: number;
  readonly runCount: number;
  readonly lastFiredAt?: number;
}

interface ScheduleFileData {
  readonly version: 1;
  readonly schedules: readonly PersistedSchedule[];
}

export function scheduleFileName(sessionId: string): string {
  return `${sanitizeStoreSegment(sessionId)}.json`;
}

/** Fill defaults for anything a previous version omitted, and drop anything
 *  unrecognized, so loading a legacy or hand-edited file never crashes. */
function normalizeSchedule(raw: unknown): PersistedSchedule | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id) return undefined;
  if (typeof record.prompt !== "string") return undefined;
  if (typeof record.cronExpression !== "string" || !record.cronExpression) return undefined;

  const createdAt = typeof record.createdAt === "number" ? record.createdAt : Date.now();
  const runCount = typeof record.runCount === "number" ? record.runCount : 0;
  const lastFiredAt = typeof record.lastFiredAt === "number" ? record.lastFiredAt : undefined;

  return {
    id: record.id,
    prompt: record.prompt,
    cronExpression: record.cronExpression,
    createdAt,
    runCount,
    ...(lastFiredAt !== undefined && { lastFiredAt }),
  };
}

/** Loads the current session's schedule file. Starts empty on a missing or malformed file. */
export async function loadScheduleFile(
  store: Store,
  sessionId: string,
): Promise<PersistedSchedule[]> {
  const result = await store.read(scheduleFileName(sessionId));
  if ("missing" in result || "problem" in result) return [];

  const data = result.value;
  if (!data || typeof data !== "object") return [];
  const { schedules } = data as { schedules?: unknown };
  if (!Array.isArray(schedules)) return [];

  const loaded: PersistedSchedule[] = [];
  for (const raw of schedules) {
    const entry = normalizeSchedule(raw);
    if (entry) loaded.push(entry);
  }
  return loaded;
}

/** Rewrites the current session's schedule file (atomic tmp+rename via Store.write). */
export async function saveScheduleFile(
  store: Store,
  sessionId: string,
  schedules: readonly PersistedSchedule[],
): Promise<void> {
  const data: ScheduleFileData = { version: SCHEDULE_STORE_VERSION, schedules };
  await store.write(scheduleFileName(sessionId), data);
}

/**
 * Deletes per-session schedule files under `root` older than `ttlDays`.
 * `keepFile` (the current session's own file) is always left alone, and
 * every fs error is swallowed — this cleanup must never break a session.
 */
export async function sweepStaleScheduleFiles(
  root: string,
  ttlDays: number,
  now: number,
  keepFile: string,
): Promise<void> {
  const ttlMs = ttlDays * DAY_MS;

  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }

  for (const name of names) {
    const path = join(root, name);
    if (path === keepFile) continue;

    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      if (now - info.mtimeMs <= ttlMs) continue;
      await rm(path, { force: true });
    } catch {
      // Swallow: cleanup must never break a session.
    }
  }
}
