/**
 * task-store.ts — Store-backed task store with CRUD operations.
 *
 * Memory mode (no backing key given): an in-memory Map, no disk I/O. File-backed
 * mode persists through jpi-base's `Store`, which writes atomically (tmp file +
 * rename) but does not coordinate with any other process writing the same file.
 *
 * Every mutator reloads from disk, applies, then saves: a project-scoped file
 * is shared across sessions, and a mutation built on stale state would clobber
 * another session's writes. Within this process, mutators also run one at a
 * time through a private queue, so concurrent calls (e.g. a batch of parallel
 * TaskCreate tool calls) can't all load() the same starting state and race to
 * save(). That queue only orders this process's own calls — a second process
 * sharing the file still only gets the reload-before-mutate protection above.
 *
 * `list()`, `get()`, and `snapshot()` never touch disk, so the widget can render
 * synchronously. A read can be stale until this instance's next mutation or
 * explicit `load()`.
 */

import { rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Store } from "../../src/core/index.ts";
import type { Task, TaskStatus, TaskStoreData } from "./types.ts";

/**
 * Fill defaults for tasks persisted by older versions, and drop any field a
 * previous version wrote (`blockedBy`, `metadata`, `owner`, `agentType`, …) so
 * loading a legacy file never crashes a consumer that only expects today's shape.
 */
function normalizeTask(t: Record<string, unknown>): Task {
  const now = Date.now();
  return {
    id: t.id as string,
    subject: typeof t.subject === "string" ? t.subject : "",
    description: typeof t.description === "string" ? t.description : "",
    status: t.status === "in_progress" || t.status === "completed" ? t.status : "pending",
    activeForm: typeof t.activeForm === "string" ? t.activeForm : undefined,
    createdAt: typeof t.createdAt === "number" ? t.createdAt : now,
    updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : now,
  };
}

export class TaskStore {
  // In-memory state (always kept in sync)
  private nextId = 1;
  private tasks = new Map<string, Task>();

  // Serializes the load-mutate-save mutators against each other within this process.
  // Concurrent tool calls (e.g. a batch of parallel TaskCreate) would otherwise all
  // load() the same starting state and the last save() would clobber the rest.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store?: Store,
    private readonly key?: string,
  ) {}

  /** Chain `fn` onto the mutation queue so it never overlaps another queued
   *  mutator, and let the queue advance past it whether it resolves or rejects. */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Read persisted state from disk (file-backed mode only). Must be awaited
   * once before the store is used; a no-op in memory mode.
   *
   * `normalizeTask` hardens each record; this hardens the envelope around them.
   * A truncated write, a bad merge or a hand edit can leave a file that parses
   * but has no `tasks` array or no usable `nextId`, and both used to corrupt the
   * store: the missing array threw mid-load and left it wiped, and the missing
   * counter produced the task ID "NaN", then IDs restarting at "0" and colliding
   * with live tasks. Anything unusable now leaves the current state alone.
   */
  async load(): Promise<void> {
    if (!this.store || !this.key) return;
    const result = await this.store.read(this.key);
    if ("missing" in result || "problem" in result) return;

    const data = result.value;
    if (!data || typeof data !== "object") return;
    const { nextId, tasks } = data as { nextId?: unknown; tasks?: unknown };
    if (!Array.isArray(tasks)) return;

    // Build the replacement before touching the live state, so a bad record
    // can't leave the store half-loaded.
    const loaded = new Map<string, Task>();
    let maxId = 0;
    for (const t of tasks as unknown[]) {
      if (!t || typeof t !== "object" || typeof (t as Record<string, unknown>).id !== "string")
        continue;
      const record = t as Record<string, unknown>;
      loaded.set(record.id as string, normalizeTask(record));
      const numericId = Number(record.id);
      if (Number.isFinite(numericId) && numericId > maxId) maxId = numericId;
    }
    this.tasks = loaded;
    // Every future task ID comes from this counter, so it has to clear the IDs
    // already in use — whether the file omitted it or recorded a stale one.
    this.nextId =
      typeof nextId === "number" && Number.isInteger(nextId) && nextId > maxId ? nextId : maxId + 1;
  }

  /** Write store to disk (file-backed mode only). */
  private async save(): Promise<void> {
    if (!this.store || !this.key) return;
    const data: TaskStoreData = {
      nextId: this.nextId,
      tasks: Array.from(this.tasks.values()),
    };
    await this.store.write(this.key, data);
  }

  async create(subject: string, description: string, activeForm?: string): Promise<Task> {
    return this.runExclusive(async () => {
      await this.load();
      const now = Date.now();
      const task: Task = {
        id: String(this.nextId++),
        subject,
        description,
        status: "pending",
        activeForm,
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.set(task.id, task);
      await this.save();
      return task;
    });
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  /** List all tasks, sorted by ID ascending. */
  list(): Task[] {
    return Array.from(this.tasks.values()).sort((a, b) => Number(a.id) - Number(b.id));
  }

  async update(
    id: string,
    fields: {
      status?: TaskStatus | "deleted";
      subject?: string;
      description?: string;
      activeForm?: string;
    },
  ): Promise<{ task: Task | undefined; changedFields: string[] }> {
    return this.runExclusive(async () => {
      await this.load();
      const task = this.tasks.get(id);
      if (!task) return { task: undefined, changedFields: [] };

      if (fields.status === "deleted") {
        this.tasks.delete(id);
        await this.save();
        return { task: undefined, changedFields: ["deleted"] };
      }

      const changedFields: string[] = [];
      if (fields.status !== undefined) {
        task.status = fields.status;
        changedFields.push("status");
      }
      if (fields.subject !== undefined) {
        task.subject = fields.subject;
        changedFields.push("subject");
      }
      if (fields.description !== undefined) {
        task.description = fields.description;
        changedFields.push("description");
      }
      if (fields.activeForm !== undefined) {
        task.activeForm = fields.activeForm;
        changedFields.push("activeForm");
      }

      task.updatedAt = Date.now();
      await this.save();
      return { task, changedFields };
    });
  }

  /** Delete a task by ID. Returns true if deleted. */
  async delete(id: string): Promise<boolean> {
    return this.runExclusive(async () => {
      await this.load();
      const existed = this.tasks.delete(id);
      if (existed) await this.save();
      return existed;
    });
  }

  /** Remove all tasks. */
  async clearAll(): Promise<number> {
    return this.runExclusive(async () => {
      await this.load();
      const count = this.tasks.size;
      this.tasks.clear();
      await this.save();
      return count;
    });
  }

  /** Capture full store state — used to carry tasks into a forked session. */
  snapshot(): TaskStoreData {
    return { nextId: this.nextId, tasks: Array.from(this.tasks.values()) };
  }

  /** Seed an empty store from a snapshot. No-op if the store already has tasks,
   *  checked *after* reloading — so re-pointing to an already-seeded fork file
   *  never duplicates, even from a fresh process that hasn't seen the write yet. */
  async seed(data: TaskStoreData): Promise<void> {
    return this.runExclusive(async () => {
      await this.load();
      if (this.tasks.size > 0) return;
      this.nextId = data.nextId;
      this.tasks.clear();
      for (const t of data.tasks) this.tasks.set(t.id, t);
      await this.save();
    });
  }

  /**
   * Delete the backing file (if file-backed and empty), then best-effort clean
   * up its now-possibly-empty project-slug directory. The directory removal
   * ignores every error, including "not empty" — a sibling session or project
   * file in the same directory is exactly why it might not be. */
  async deleteFileIfEmpty(): Promise<boolean> {
    return this.runExclusive(async () => {
      if (!this.store || !this.key || this.tasks.size > 0) return false;
      await this.store.remove(this.key);
      await rmdir(dirname(this.store.path(this.key))).catch(() => {});
      return true;
    });
  }

  /** Remove all completed tasks. */
  async clearCompleted(): Promise<number> {
    return this.runExclusive(async () => {
      await this.load();
      let count = 0;
      for (const [id, task] of this.tasks) {
        if (task.status === "completed") {
          this.tasks.delete(id);
          count++;
        }
      }
      await this.save();
      return count;
    });
  }
}
