/**
 * Where tasks are stored: the `tasks.scope` config, the Store-backed paths it
 * resolves to, and what session_start does with an already-persisted list.
 *
 * Every context carries a temp workspace: task paths resolve against ctx.cwd,
 * and PI_CODING_AGENT_DIR points state at a temp agent directory — never at
 * the developer's own `~/.pi/agent` or at `.pi/` inside the workspace.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSlug, Store } from "../../src/core/index.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { initTasksExtension } from "./helpers/init-extension.ts";
import { mockPi, mockSessionCtx } from "./helpers/mock-pi.ts";
import { projectFilePath, projectSlugDir, sessionFilePath } from "./helpers/task-store-paths.ts";
import { writeTasksConfig } from "./helpers/tasks-config.ts";

let cwd: string;
let agentDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-tasks-scope-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-tasks-agent-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

/** Every context carries the workspace, since that is what task paths resolve against. */
const ctxFor = (sessionId = "s1", opts?: { persisted?: boolean }) =>
  mockSessionCtx(sessionId, { ...opts, cwd });
const projectFile = () => projectFilePath(agentDir, cwd);
const sessionFile = (id: string) => sessionFilePath(agentDir, cwd, id);

async function readTasks(key: string): Promise<string[]> {
  const store = new Store("tasks", { PI_CODING_AGENT_DIR: agentDir });
  const result = await store.read(key);
  if (!("value" in result)) return [];
  return (result.value as { tasks: { subject: string }[] }).tasks.map((t) => t.subject);
}

describe("scope: project", () => {
  beforeEach(() => writeTasksConfig(agentDir, { scope: "project" }));

  it("persists to a single shared file", async () => {
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Shared", description: "d" });

    expect(existsSync(projectFile())).toBe(true);
    expect(await readTasks(`${projectSlug(cwd)}/project.json`)).toEqual(["Shared"]);
  });

  it("stays on the same file when the session changes", async () => {
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Before", description: "d" });

    await mock.fireLifecycle("session_start", { reason: "new" }, ctxFor("s2"));
    await mock.executeTool("TaskCreate", { subject: "After", description: "d" });

    expect(existsSync(sessionFile("s1"))).toBe(false);
    expect(existsSync(sessionFile("s2"))).toBe(false);
    expect(await readTasks(`${projectSlug(cwd)}/project.json`)).toEqual(["Before", "After"]);
  });
});

describe("scope: memory", () => {
  beforeEach(() => writeTasksConfig(agentDir, { scope: "memory" }));

  it("never touches the filesystem", async () => {
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Ephemeral", description: "d" });

    expect(existsSync(join(cwd, ".pi"))).toBe(false);
    expect(existsSync(projectSlugDir(agentDir, cwd))).toBe(false);
    expect((await mock.executeTool("TaskList", {})).content[0].text).toContain("Ephemeral");
  });

  it("clears tasks on /new, since there is no file to switch away from", async () => {
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Ephemeral", description: "d" });

    await mock.fireLifecycle("session_start", { reason: "new" }, ctxFor("s2"));

    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });

  it("keeps tasks across a reload", async () => {
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Ephemeral", description: "d" });

    await mock.fireLifecycle("session_start", { reason: "reload" }, ctxFor("s1"));

    expect((await mock.executeTool("TaskList", {})).content[0].text).toContain("Ephemeral");
  });
});

describe("scope: session, without a persisted session", () => {
  // pi --no-session (and SessionManager.inMemory()) mints a session ID but never a
  // session file. A session task file written for it is orphaned the moment pi exits.
  it("keeps tasks in memory and leaves nothing on disk", async () => {
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);
    await mock.fireLifecycle(
      "session_start",
      { reason: "startup" },
      ctxFor("s1", { persisted: false }),
    );
    await mock.executeTool("TaskCreate", { subject: "Ephemeral", description: "d" });

    expect(existsSync(join(cwd, ".pi"))).toBe(false);
    expect(existsSync(projectSlugDir(agentDir, cwd))).toBe(false);
    expect((await mock.executeTool("TaskList", {})).content[0].text).toContain("Ephemeral");
  });

  it("still writes a session file when the session is persisted", async () => {
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
    await mock.executeTool("TaskCreate", { subject: "Durable", description: "d" });

    expect(existsSync(sessionFile("s1"))).toBe(true);
  });

  it("does not fall back to a file when a later lifecycle event fires", async () => {
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);
    const ctx = ctxFor("s1", { persisted: false });
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.fireLifecycle("before_agent_start", {}, ctx);
    await mock.fireLifecycle("turn_start", {}, ctx);
    await mock.executeTool("TaskCreate", { subject: "Ephemeral", description: "d" });

    expect(existsSync(join(cwd, ".pi"))).toBe(false);
    expect(existsSync(projectSlugDir(agentDir, cwd))).toBe(false);
  });
});

describe("session_start with a persisted list", () => {
  /** Write a session file holding tasks in the given states, ahead of the extension
   *  reading it — mirrors what a previous session would have left behind. */
  async function seed(sessionId: string, statuses: Array<"pending" | "completed">): Promise<void> {
    const store = new Store("tasks", { PI_CODING_AGENT_DIR: agentDir });
    const tasks = statuses.map((status, i) => ({
      id: String(i + 1),
      subject: `Task ${i + 1}`,
      description: "d",
      status,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    await store.write(`${projectSlug(cwd)}/session-${sessionId}.json`, {
      nextId: tasks.length + 1,
      tasks,
    });
  }

  it("wipes an all-completed list on startup, leaving no session file behind", async () => {
    await seed("s1", ["completed", "completed"]);
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);

    const ctx = ctxFor("s1");
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

    expect(existsSync(sessionFile("s1"))).toBe(false);
    expect(ctx.ui.setWidget).not.toHaveBeenCalled();
  });

  it("keeps an all-completed list on resume but does not show the widget", async () => {
    await seed("s1", ["completed", "completed"]);
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);

    const ctx = ctxFor("s1");
    await mock.fireLifecycle("session_start", { reason: "resume" }, ctx);

    expect(existsSync(sessionFile("s1"))).toBe(true);
    expect(ctx.ui.setWidget).not.toHaveBeenCalledWith(
      "tasks",
      expect.any(Function),
      expect.anything(),
    );
  });

  it("keeps a partially finished list on startup", async () => {
    await seed("s1", ["completed", "pending"]);
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);

    const ctx = ctxFor("s1");
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);

    expect(existsSync(sessionFile("s1"))).toBe(true);
    expect(ctx.ui.setWidget).toHaveBeenCalled();
  });

  it("reclaims the project-slug directory once its last session file is gone", async () => {
    // Nothing else ever revisits a workspace whose tasks are gone, so storage would
    // otherwise grow one empty directory per workspace ever opened.
    await seed("s1", ["completed"]);
    expect(existsSync(projectSlugDir(agentDir, cwd))).toBe(true);

    const mock = mockPi();
    await initTasksExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));

    expect(existsSync(sessionFile("s1"))).toBe(false);
    expect(existsSync(projectSlugDir(agentDir, cwd))).toBe(false);
  });
});

describe("session scope paths", () => {
  it("writes under the agent directory's project-slug, never under the workspace's .pi/", async () => {
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);

    const ctx = ctxFor("s1");
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Default scope", description: "d" }, ctx);

    expect(await readTasks(`${projectSlug(cwd)}/session-s1.json`)).toEqual(["Default scope"]);
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
  });

  it("sanitizes a session ID with characters Store rejects", async () => {
    // pi session IDs are opaque strings; Store file segments only allow
    // [A-Za-z0-9._-], so anything else has to be mapped to a valid one.
    const mock = mockPi();
    await initTasksExtension(mock.pi as any);

    const sessionId = "sess:2024/06/01@12:00";
    const ctx = ctxFor(sessionId);
    await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
    await mock.executeTool("TaskCreate", { subject: "Sanitized", description: "d" }, ctx);

    const store = new Store("tasks", { PI_CODING_AGENT_DIR: agentDir });
    const expectedKey = `${projectSlug(cwd)}/session-sess-2024-06-01-12-00.json`;
    const result = await store.read(expectedKey);
    expect("value" in result).toBe(true);
  });

  it("keeps different workspaces' session files apart", async () => {
    const otherCwd = mkdtempSync(join(tmpdir(), "pi-tasks-scope-other-"));
    try {
      const mock = mockPi();
      await initTasksExtension(mock.pi as any);

      await mock.fireLifecycle("session_start", { reason: "startup" }, ctxFor("s1"));
      await mock.executeTool("TaskCreate", { subject: "Here", description: "d" }, ctxFor("s1"));

      const otherCtx = mockSessionCtx("s1", { cwd: otherCwd });
      await mock.fireLifecycle("session_start", { reason: "startup" }, otherCtx);
      await mock.executeTool("TaskCreate", { subject: "There", description: "d" }, otherCtx);

      expect(await readTasks(`${projectSlug(cwd)}/session-s1.json`)).toEqual(["Here"]);
      expect(await readTasks(`${projectSlug(otherCwd)}/session-s1.json`)).toEqual(["There"]);
    } finally {
      rmSync(otherCwd, { recursive: true, force: true });
    }
  });
});
