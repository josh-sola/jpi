import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../../src/core/index.ts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { TaskStore } from "../../modules/tasks/task-store.ts";

/** A Store rooted at a fresh temp agent dir, and the key file-backed tests use. */
function makeStore(agentDir: string): Store {
  return new Store("tasks", { PI_CODING_AGENT_DIR: agentDir });
}

async function loaded(store: Store, key: string): Promise<TaskStore> {
  const taskStore = new TaskStore(store, key);
  await taskStore.load();
  return taskStore;
}

/** Write a fixture directly, ahead of any real mutation that would otherwise
 *  create the key's parent directory. */
function writeFixture(store: Store, key: string, value: unknown): void {
  const path = store.path(key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe("TaskStore (in-memory)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(); // no store/key = in-memory
  });

  it("creates tasks with auto-incrementing IDs", async () => {
    const t1 = await store.create("First task", "Description 1");
    const t2 = await store.create("Second task", "Description 2");

    expect(t1.id).toBe("1");
    expect(t2.id).toBe("2");
    expect(t1.status).toBe("pending");
    expect(t1.subject).toBe("First task");
    expect(t1.description).toBe("Description 1");
  });

  it("creates tasks with an optional activeForm", async () => {
    const t = await store.create("Task", "Desc", "Running task");
    expect(t.activeForm).toBe("Running task");
  });

  it("gets a task by ID", async () => {
    await store.create("Test", "Desc");
    const task = store.get("1");

    expect(task).toBeDefined();
    expect(task!.subject).toBe("Test");
  });

  it("returns undefined for non-existent task", () => {
    expect(store.get("999")).toBeUndefined();
  });

  it("lists all tasks sorted by ID", async () => {
    await store.create("Task 3", "Desc");
    await store.create("Task 1", "Desc");
    await store.create("Task 2", "Desc");

    const tasks = store.list();
    expect(tasks.map((t) => t.id)).toEqual(["1", "2", "3"]);
  });

  it("updates task status", async () => {
    await store.create("Test", "Desc");
    const { task, changedFields } = await store.update("1", { status: "in_progress" });

    expect(task!.status).toBe("in_progress");
    expect(changedFields).toEqual(["status"]);
  });

  it("updates multiple fields at once", async () => {
    await store.create("Test", "Desc");
    const { changedFields } = await store.update("1", {
      subject: "Updated subject",
      description: "Updated desc",
    });

    expect(changedFields).toContain("subject");
    expect(changedFields).toContain("description");

    const task = store.get("1")!;
    expect(task.subject).toBe("Updated subject");
    expect(task.description).toBe("Updated desc");
  });

  it("deletes a task with status: deleted", async () => {
    await store.create("Test", "Desc");
    const { changedFields } = await store.update("1", { status: "deleted" });

    expect(changedFields).toEqual(["deleted"]);
    expect(store.get("1")).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it("preserves ID counter after deletion", async () => {
    await store.create("Task 1", "Desc");
    await store.create("Task 2", "Desc");
    await store.update("1", { status: "deleted" });

    const t3 = await store.create("Task 3", "Desc");
    expect(t3.id).toBe("3"); // Not "1" — counter continues
  });

  it("clears completed tasks", async () => {
    await store.create("Completed", "Desc");
    await store.create("Pending", "Desc");
    await store.update("1", { status: "completed" });

    const count = await store.clearCompleted();

    expect(count).toBe(1);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.id).toBe("2");
  });

  it("returns not found for update on non-existent task", async () => {
    const { task, changedFields } = await store.update("999", { status: "completed" });
    expect(task).toBeUndefined();
    expect(changedFields).toEqual([]);
  });

  it("delete method works", async () => {
    await store.create("Test", "Desc");
    expect(await store.delete("1")).toBe(true);
    expect(await store.delete("1")).toBe(false); // already deleted
    expect(store.list()).toHaveLength(0);
  });

  it("accepts whitespace-only subjects (matches Claude Code)", async () => {
    const t = await store.create("   ", "Desc");
    expect(t.subject).toBe("   ");
  });

  it("updates activeForm field", async () => {
    await store.create("Test", "Desc");
    const { changedFields } = await store.update("1", { activeForm: "Running tests" });
    expect(changedFields).toContain("activeForm");
    expect(store.get("1")!.activeForm).toBe("Running tests");
  });

  it("updates description field", async () => {
    await store.create("Test", "Original desc");
    const { changedFields } = await store.update("1", { description: "Updated desc" });
    expect(changedFields).toContain("description");
    expect(store.get("1")!.description).toBe("Updated desc");
  });

  it("returns empty changedFields when updating non-existent task", async () => {
    const { task, changedFields } = await store.update("999", { status: "completed" });
    expect(task).toBeUndefined();
    expect(changedFields).toEqual([]);
  });

  it("clearCompleted returns 0 when no completed tasks", async () => {
    await store.create("Pending", "Desc");
    expect(await store.clearCompleted()).toBe(0);
  });

  it("list sorts pending → in_progress → completed with all three present", async () => {
    await store.create("Pending task", "Desc");
    await store.create("Completed task", "Desc");
    await store.create("In-progress task", "Desc");
    await store.create("Another pending", "Desc");

    await store.update("2", { status: "completed" });
    await store.update("3", { status: "in_progress" });

    const tasks = store.list();
    // Store returns by ID; TaskList tool sorts by status group
    // Here we verify the raw list order (by ID), then test status-grouped sort
    const statusOrder: Record<string, number> = { pending: 0, in_progress: 1, completed: 2 };
    const sorted = [...tasks].sort((a, b) => {
      const so = (statusOrder[a.status] ?? 0) - (statusOrder[b.status] ?? 0);
      if (so !== 0) return so;
      return Number(a.id) - Number(b.id);
    });

    expect(sorted.map((t) => t.id)).toEqual(["1", "4", "3", "2"]);
    expect(sorted.map((t) => t.status)).toEqual(["pending", "pending", "in_progress", "completed"]);
  });
});

describe("TaskStore (file-backed)", () => {
  let agentDir: string;
  let jpiStore: Store;
  const key = "scope/tasks.json";

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-tasks-store-"));
    jpiStore = makeStore(agentDir);
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("persists tasks to disk", async () => {
    const store1 = await loaded(jpiStore, key);
    await store1.create("Persistent task", "Should survive reload");

    // Create a new store instance pointing to same key
    const store2 = await loaded(jpiStore, key);
    const tasks = store2.list();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.subject).toBe("Persistent task");
  });

  it("converges two instances sharing one key: neither mutation clobbers the other", async () => {
    // Two concurrent pi sessions on `project` scope share one file through two
    // separate TaskStore instances — reload-before-mutate is what stops the
    // second session's save from wiping out the first session's task.
    const storeA = await loaded(jpiStore, key);
    const storeB = await loaded(jpiStore, key);

    await storeA.create("From A", "d");
    // storeB's in-memory state still predates storeA's write — it only catches
    // up when it next mutates.
    await storeB.create("From B", "d");

    const raw = JSON.parse(readFileSync(jpiStore.path(key), "utf-8"));
    expect(raw.tasks.map((t: { subject: string }) => t.subject).sort()).toEqual([
      "From A",
      "From B",
    ]);

    // B's own in-memory list reflects the reload its create() just did.
    expect(
      storeB
        .list()
        .map((t) => t.subject)
        .sort(),
    ).toEqual(["From A", "From B"]);
  });

  it("lets one instance update a task another instance created", async () => {
    const storeA = await loaded(jpiStore, key);
    const storeB = await loaded(jpiStore, key);

    const task = await storeA.create("From A", "d");
    // storeB never saw "From A" load — update() must reload before its lookup
    // rather than reporting the task as not found.
    const { task: updated, changedFields } = await storeB.update(task.id, { status: "completed" });

    expect(changedFields).toEqual(["status"]);
    expect(updated?.status).toBe("completed");

    const raw = JSON.parse(readFileSync(jpiStore.path(key), "utf-8"));
    expect(raw.tasks).toHaveLength(1);
    expect(raw.tasks[0].status).toBe("completed");
  });

  it("persists in_progress updates to disk", async () => {
    const store1 = await loaded(jpiStore, key);
    await store1.create("Task", "Desc");
    await store1.update("1", { status: "in_progress" });

    const store2 = await loaded(jpiStore, key);
    expect(store2.get("1")!.status).toBe("in_progress");
  });

  it("persists completed tasks to disk", async () => {
    const store1 = await loaded(jpiStore, key);
    await store1.create("Done task", "Desc");
    await store1.create("Pending task", "Desc");
    await store1.update("1", { status: "completed" });

    const store2 = await loaded(jpiStore, key);
    expect(store2.get("1")).toBeDefined();
    expect(store2.get("1")!.status).toBe("completed");
    expect(store2.get("2")).toBeDefined();
    expect(store2.list()).toHaveLength(2);
  });

  it("restores all tasks across instances", async () => {
    const store1 = await loaded(jpiStore, key);
    await store1.create("Pending", "Desc");
    await store1.create("In progress", "Desc");
    await store1.create("Done", "Desc");
    await store1.update("2", { status: "in_progress" });
    await store1.update("3", { status: "completed" });

    const store2 = await loaded(jpiStore, key);
    const tasks = store2.list();
    expect(tasks).toHaveLength(3);
    expect(tasks.map((t) => t.id)).toContain("1");
    expect(tasks.map((t) => t.id)).toContain("2");
    expect(tasks.map((t) => t.id)).toContain("3");
  });

  it("persists ID counter across instances", async () => {
    const store1 = await loaded(jpiStore, key);
    await store1.create("Task 1", "Desc");
    await store1.create("Task 2", "Desc");

    const store2 = await loaded(jpiStore, key);
    const t3 = await store2.create("Task 3", "Desc");
    expect(t3.id).toBe("3");
  });

  it("persists completed tasks when reading the raw file", async () => {
    const store1 = await loaded(jpiStore, key);
    await store1.create("Pending", "Desc");
    await store1.create("Completed", "Desc");
    await store1.update("2", { status: "completed" });

    const raw = JSON.parse(readFileSync(jpiStore.path(key), "utf-8"));
    expect(raw.tasks).toHaveLength(2);
  });

  it("recreates the parent directory before later mutations", async () => {
    const store = await loaded(jpiStore, key);
    await store.create("Task", "Desc");

    rmSync(jpiStore.path("scope"), { recursive: true, force: true });

    await expect(store.clearCompleted()).resolves.not.toThrow();
    expect(existsSync(jpiStore.path(key))).toBe(true);
  });

  it("normalizes legacy task records missing extra fields on load", async () => {
    // A task file written before this version — no activeForm, no timestamps.
    writeFixture(jpiStore, key, {
      nextId: 2,
      tasks: [
        {
          id: "1",
          subject: "Legacy task",
          description: "From an older version",
          status: "pending",
        },
      ],
    });

    const task = (await loaded(jpiStore, key)).get("1")!;
    expect(task.subject).toBe("Legacy task"); // existing fields preserved
    expect(typeof task.createdAt).toBe("number");
    expect(typeof task.updatedAt).toBe("number");
  });

  it("drops fields a removed feature used to write, without crashing", async () => {
    // A task file written by a version that still had dependencies, metadata,
    // owner and agent execution. Loading it must not choke on any of that.
    writeFixture(jpiStore, key, {
      nextId: 2,
      tasks: [
        {
          id: "1",
          subject: "From an older version",
          description: "d",
          status: "in_progress",
          owner: "agent-42",
          metadata: { agentType: "general-purpose", agentId: "agent-42" },
          blocks: ["2"],
          blockedBy: [],
        },
      ],
    });

    const task = (await loaded(jpiStore, key)).get("1")!;
    expect(task.subject).toBe("From an older version");
    expect(task.status).toBe("in_progress");
    expect((task as any).owner).toBeUndefined();
    expect((task as any).metadata).toBeUndefined();
    expect((task as any).blocks).toBeUndefined();
    expect((task as any).blockedBy).toBeUndefined();
  });

  it("serializes concurrent creates instead of losing all but the last", async () => {
    // Parallel TaskCreate tool calls share one TaskStore instance; every
    // create in the batch must survive to disk with a distinct id.
    const store = await loaded(jpiStore, key);

    const created = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.create(`Task ${i + 1}`, "d")),
    );

    expect(created.map((t) => t.id).sort((a, b) => Number(a) - Number(b))).toEqual(
      Array.from({ length: 10 }, (_, i) => String(i + 1)),
    );
    expect(store.list()).toHaveLength(10);

    const store2 = await loaded(jpiStore, key);
    expect(store2.list()).toHaveLength(10);
    expect((await store2.create("Next", "d")).id).toBe("11");
  });

  it("serializes a create racing an update on another task instead of losing either", async () => {
    const store = await loaded(jpiStore, key);
    await store.create("Existing", "d");

    const [created, updated] = await Promise.all([
      store.create("New", "d"),
      store.update("1", { status: "completed" }),
    ]);

    expect(created.id).toBe("2");
    expect(updated.changedFields).toEqual(["status"]);

    const store2 = await loaded(jpiStore, key);
    expect(store2.list()).toHaveLength(2);
    expect(store2.get("1")!.status).toBe("completed");
    expect(store2.get("2")!.subject).toBe("New");
  });

  it("creates the backing directory lazily — not on construction, but on first write", async () => {
    const store = await loaded(jpiStore, key);
    // Constructing and loading a store must not create the directory for a
    // session that never persists a task.
    expect(existsSync(jpiStore.path("scope"))).toBe(false);

    await store.create("Task", "Desc");
    // The first mutation creates it.
    expect(existsSync(jpiStore.path("scope"))).toBe(true);
    expect(existsSync(jpiStore.path(key))).toBe(true);
  });
});

describe("TaskStore (malformed files)", () => {
  let agentDir: string;
  let jpiStore: Store;
  const key = "scope/tasks.json";

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-tasks-malformed-"));
    jpiStore = makeStore(agentDir);
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("continues IDs after the highest existing task when nextId is missing", async () => {
    // A truncated write, a bad merge or a hand edit can drop the envelope fields.
    // `nextId` decides every future ID, so an unusable one used to produce the task
    // ID "NaN", then IDs restarting at "0" and colliding with live tasks.
    writeFixture(jpiStore, key, {
      tasks: [
        { id: "1", subject: "One", description: "d", status: "completed" },
        { id: "7", subject: "Seven", description: "d", status: "pending" },
      ],
    });

    expect((await (await loaded(jpiStore, key)).create("Next", "d")).id).toBe("8");
  });

  it("starts from 1 when nextId is missing and there are no tasks", async () => {
    writeFixture(jpiStore, key, { tasks: [] });

    expect((await (await loaded(jpiStore, key)).create("First", "d")).id).toBe("1");
  });

  it("does not reissue an ID that a task already holds", async () => {
    writeFixture(jpiStore, key, {
      nextId: 2,
      tasks: [
        { id: "1", subject: "One", description: "d", status: "pending" },
        { id: "5", subject: "Five", description: "d", status: "pending" },
      ],
    });

    expect((await (await loaded(jpiStore, key)).create("Next", "d")).id).toBe("6");
  });

  it("keeps the tasks it has when the file has no task array", async () => {
    const store = await loaded(jpiStore, key);
    await store.create("Keep me", "d");
    writeFileSync(jpiStore.path(key), JSON.stringify({ nextId: 5 }));
    await store.load();

    expect(store.list().map((t) => t.subject)).toEqual(["Keep me"]);
  });

  it("keeps the tasks it has when the file is not valid JSON", async () => {
    const store = await loaded(jpiStore, key);
    await store.create("Keep me", "d");
    writeFileSync(jpiStore.path(key), "{ this is not json");
    await store.load();

    expect(store.list().map((t) => t.subject)).toEqual(["Keep me"]);
  });

  it("keeps the tasks it has when the file holds a JSON array", async () => {
    const store = await loaded(jpiStore, key);
    await store.create("Keep me", "d");
    writeFileSync(jpiStore.path(key), JSON.stringify([{ id: "1" }]));
    await store.load();

    expect(store.list().map((t) => t.subject)).toEqual(["Keep me"]);
  });

  it("skips entries that are not task records", async () => {
    writeFixture(jpiStore, key, {
      nextId: 3,
      tasks: [
        null,
        5,
        "nope",
        { subject: "no id" },
        { id: "2", subject: "Real", description: "d", status: "pending" },
      ],
    });

    expect((await loaded(jpiStore, key)).list().map((t) => t.subject)).toEqual(["Real"]);
  });

  it("respects a valid nextId", async () => {
    writeFixture(jpiStore, key, {
      nextId: 42,
      tasks: [{ id: "1", subject: "One", description: "d", status: "pending" }],
    });

    expect((await (await loaded(jpiStore, key)).create("Next", "d")).id).toBe("42");
  });
});
