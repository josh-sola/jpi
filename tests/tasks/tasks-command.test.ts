/**
 * The /tasks command: menu routing, the task detail actions, and the clear/create
 * flows. Driven by a scripted UI that answers each prompt in order and returns
 * undefined once the script runs out, which unwinds the handler's recursion.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectSlug, Store } from "../../src/core/index.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { initTasksExtension } from "./helpers/init-extension.ts";
import { mockPi, mockSessionCtx } from "./helpers/mock-pi.ts";
import { sessionFilePath } from "./helpers/task-store-paths.ts";

/** A script entry is either the literal answer or an index into the offered choices. */
type Answer = string | number | undefined;

function scriptedUI(script: Answer[]) {
  const selects: Array<{ title: string; choices: string[] }> = [];
  const inputs: string[] = [];

  const ui = {
    async select(title: string, choices: string[]) {
      selects.push({ title, choices });
      const answer = script.shift();
      return typeof answer === "number" ? choices[answer] : answer;
    },
    async input(prompt: string) {
      inputs.push(prompt);
      const answer = script.shift();
      return typeof answer === "number" ? undefined : answer;
    },
    setWidget: vi.fn(),
    setStatus: vi.fn(),
    notify: vi.fn(),
  };

  return { ui, selects, inputs };
}

let dir: string;
let agentDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-tasks-cmd-"));
  agentDir = mkdtempSync(join(tmpdir(), "pi-tasks-agent-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
});

const taskFile = () => sessionFilePath(agentDir, dir, "s1");

async function readTasks(): Promise<string[]> {
  const store = new Store("tasks", { PI_CODING_AGENT_DIR: agentDir });
  const result = await store.read(`${projectSlug(dir)}/session-s1.json`);
  if (!("value" in result)) return [];
  return (result.value as { tasks: { subject: string }[] }).tasks.map((t) => t.subject);
}

/** Boot the extension against a fixed session workspace, seed tasks, and run
 *  /tasks against a scripted UI. */
async function runTasks(
  script: Answer[],
  seed: (mock: ReturnType<typeof mockPi>) => Promise<void>,
) {
  const mock = mockPi();
  await initTasksExtension(mock.pi as any);
  const ctx = mockSessionCtx("s1", { cwd: dir });
  await mock.fireLifecycle("session_start", { reason: "startup" }, ctx);
  await seed(mock);
  const scripted = scriptedUI(script);
  await mock.runCommand("tasks", "", { ...ctx, ui: scripted.ui });
  return { mock, ...scripted };
}

const create = (subject: string) => async (mock: ReturnType<typeof mockPi>) => {
  await mock.executeTool("TaskCreate", { subject, description: "d" });
};

describe("/tasks main menu", () => {
  it("offers only view and create when the list is empty", async () => {
    const { selects } = await runTasks([undefined], async () => {});
    expect(selects[0].choices).toEqual(["View all tasks (0)", "Create task"]);
  });

  it("offers the clear actions with their counts once tasks exist", async () => {
    const { selects } = await runTasks([undefined], async (mock) => {
      await create("Done")(mock);
      await create("Open")(mock);
      await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    });
    expect(selects[0].choices).toEqual([
      "View all tasks (2)",
      "Create task",
      "Clear completed (1)",
      "Clear all (2)",
    ]);
  });
});

describe("/tasks task detail", () => {
  it("starts a pending task", async () => {
    const { mock } = await runTasks([0, 0, "▸ Start (in_progress)"], create("Work"));
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain(
      "Status: in_progress",
    );
  });

  it("completes an in-progress task", async () => {
    const { mock } = await runTasks(
      [0, 0, "▸ Start (in_progress)", 0, "✓ Complete"],
      create("Work"),
    );
    expect((await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text).toContain(
      "Status: completed",
    );
  });

  it("deletes a task", async () => {
    const { mock } = await runTasks([0, 0, "✗ Delete"], create("Work"));
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });

  it("offers Complete only for in-progress tasks", async () => {
    const { selects } = await runTasks([0, 0, undefined], create("Work"));
    expect(selects[2].choices).toEqual(["▸ Start (in_progress)", "✗ Delete", "← Back"]);
  });

  it("acts on the task whose row was picked, not on an ID inside its subject", async () => {
    // The row reads "◻ #1 [pending] Fix #42 in the parser" — the ID must come from
    // the row's own marker, not from the first number that happens to follow a '#'.
    const { mock } = await runTasks([0, 0, "✗ Delete"], create("Fix #42 in the parser"));
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });

  it("lists tasks with the default status glyphs", async () => {
    const { selects } = await runTasks([0, undefined], create("Work"));
    expect(selects[1].choices).toEqual(["◻ #1 [pending] Work", "← Back"]);
  });

  it("shows a placeholder screen when there is nothing to view", async () => {
    const { selects } = await runTasks([0, undefined], async () => {});
    expect(selects[1]).toEqual({ title: "No tasks", choices: ["← Back"] });
  });
});

describe("/tasks clearing", () => {
  it("clears only completed tasks", async () => {
    const { mock } = await runTasks(["Clear completed (1)", undefined], async (m) => {
      await create("Done")(m);
      await create("Open")(m);
      await m.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    });
    const list = (await mock.executeTool("TaskList", {})).content[0].text;
    expect(list).toContain("Open");
    expect(list).not.toContain("Done");
  });

  it("clears every task and removes the now-empty file", async () => {
    const { mock } = await runTasks(["Clear all (2)", undefined], async (m) => {
      await create("One")(m);
      await create("Two")(m);
    });
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
    expect(existsSync(taskFile())).toBe(false);
  });

  it("keeps the file when clearing completed leaves work behind", async () => {
    await runTasks(["Clear completed (1)", undefined], async (m) => {
      await create("Done")(m);
      await create("Open")(m);
      await m.executeTool("TaskUpdate", { taskId: "1", status: "completed" });
    });
    expect(existsSync(taskFile())).toBe(true);
    expect(await readTasks()).toEqual(["Open"]);
  });
});

describe("/tasks create", () => {
  it("creates a task from the subject and description prompts", async () => {
    const { mock, inputs } = await runTasks(
      ["Create task", "Ship it", "Get the release out", undefined],
      async () => {},
    );
    expect(inputs).toEqual(["Task subject", "Task description"]);
    const task = (await mock.executeTool("TaskGet", { taskId: "1" })).content[0].text;
    expect(task).toContain("Ship it");
    expect(task).toContain("Get the release out");
  });

  it("creates nothing when the subject prompt is cancelled", async () => {
    const { mock, inputs } = await runTasks(["Create task", undefined], async () => {});
    expect(inputs).toEqual(["Task subject"]);
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });

  it("creates nothing when the description prompt is cancelled", async () => {
    const { mock } = await runTasks(["Create task", "Ship it", undefined], async () => {});
    expect((await mock.executeTool("TaskList", {})).content[0].text).toBe("No tasks found");
  });
});
