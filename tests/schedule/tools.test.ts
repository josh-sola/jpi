import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "vite-plus/test";

import { Store } from "../../src/core/index.ts";
import { ScheduleRegistry } from "../../modules/schedule/registry.ts";
import { createScheduleTools } from "../../modules/schedule/tools.ts";
import { mockCtx } from "../tasks/helpers/mock-pi.ts";

async function withTempEnv(t: TestContext): Promise<NodeJS.ProcessEnv> {
  const dir = await mkdtemp(join(tmpdir(), "jpi-schedule-tools-"));
  t.onTestFinished(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return { PI_CODING_AGENT_DIR: dir };
}

function setUp(env: NodeJS.ProcessEnv, makeId?: () => string) {
  const store = new Store("schedule", env);
  const registry = new ScheduleRegistry({
    store,
    sendNotification: () => undefined,
    ...(makeId ? { makeId } : {}),
  });
  const tools = createScheduleTools({ registry });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { registry, tools, byName };
}

// The tool type declares `parameters` as the generic typebox TSchema; every
// tool here actually returns a Type.Object, which carries `required` at runtime.
function requiredParams(tool: { parameters: unknown }): string[] {
  return (tool.parameters as { required?: string[] }).required ?? [];
}

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  const block = result.content.find((item) => item.type === "text");
  return block?.text ?? "";
}

test("all three schedule tools are registered with expected names and required params", async (t) => {
  const env = await withTempEnv(t);
  const { tools, byName } = setUp(env);

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["list_schedules", "schedule", "stop_schedule"].sort(),
  );
  assert.deepEqual(requiredParams(byName.get("schedule")!).sort(), ["cron", "prompt"]);
  assert.deepEqual(requiredParams(byName.get("list_schedules")!), []);
  assert.deepEqual(requiredParams(byName.get("stop_schedule")!), ["id"]);
});

test("schedule creates a cron schedule", async (t) => {
  const env = await withTempEnv(t);
  const { byName } = setUp(env);
  const scheduleTool = byName.get("schedule")!;

  const prepared = scheduleTool.prepareArguments!({ prompt: "ping me", cron: "0 9 * * *" });
  const result = await scheduleTool.execute(
    "call-1",
    prepared,
    undefined,
    undefined,
    mockCtx() as never,
  );

  assert.match(textOf(result), /^Scheduled s[0-9a-f]+ \(cron "0 9 \* \* \*"\)\. Next run:/);
});

test("schedule accepts a 6-field cron expression with a seconds column", async (t) => {
  const env = await withTempEnv(t);
  const { byName } = setUp(env);
  const scheduleTool = byName.get("schedule")!;

  const prepared = scheduleTool.prepareArguments!({ prompt: "ping often", cron: "*/30 * * * * *" });
  const result = await scheduleTool.execute(
    "call-1",
    prepared,
    undefined,
    undefined,
    mockCtx() as never,
  );

  assert.match(textOf(result), /cron "\*\/30 \* \* \* \* \*"/);
});

test("prepareArguments rejects an empty prompt", async (t) => {
  const env = await withTempEnv(t);
  const { byName } = setUp(env);
  const scheduleTool = byName.get("schedule")!;
  assert.throws(
    () => scheduleTool.prepareArguments!({ prompt: "   ", cron: "* * * * *" }),
    /non-empty prompt/,
  );
});

test("prepareArguments rejects a missing cron expression", async (t) => {
  const env = await withTempEnv(t);
  const { byName } = setUp(env);
  const scheduleTool = byName.get("schedule")!;
  assert.throws(
    () => scheduleTool.prepareArguments!({ prompt: "x", cron: "" }),
    /requires a cron expression/,
  );
});

test("prepareArguments rejects an invalid cron expression", async (t) => {
  const env = await withTempEnv(t);
  const { byName } = setUp(env);
  const scheduleTool = byName.get("schedule")!;
  assert.throws(
    () => scheduleTool.prepareArguments!({ prompt: "x", cron: "not a cron" }),
    /Invalid cron expression/,
  );
});

test("list_schedules reports schedules and stop_schedule stops by unambiguous prefix", async (t) => {
  const env = await withTempEnv(t);
  const { registry, byName } = setUp(env);
  const listTool = byName.get("list_schedules")!;
  const stopTool = byName.get("stop_schedule")!;

  const created = registry.create("ping", "* * * * *");

  const listed = await listTool.execute("call-1", {}, undefined, undefined, mockCtx() as never);
  const listedText = textOf(listed);
  assert.ok(listedText.includes(created.id));
  assert.ok(listedText.includes("ping"));

  const stopped = await stopTool.execute(
    "call-2",
    { id: created.id.slice(0, 3) },
    undefined,
    undefined,
    mockCtx() as never,
  );
  assert.ok(textOf(stopped).startsWith(`Stopped ${created.id}`));
  assert.equal(registry.list().length, 0);
});

test("stop_schedule rejects an ambiguous prefix, listing the candidates", async (t) => {
  const env = await withTempEnv(t);
  let n = 0;
  const ids = ["abc111", "abc222"];
  const { registry, byName } = setUp(env, () => ids[n++]!);
  const stopTool = byName.get("stop_schedule")!;

  registry.create("first", "* * * * *");
  registry.create("second", "* * * * *");

  await assert.rejects(
    () => stopTool.execute("call-1", { id: "abc" }, undefined, undefined, mockCtx() as never),
    /ambiguous: matches abc111, abc222/,
  );
});

test("stop_schedule rejects an unknown id", async (t) => {
  const env = await withTempEnv(t);
  const { byName } = setUp(env);
  const stopTool = byName.get("stop_schedule")!;
  await assert.rejects(
    () => stopTool.execute("call-1", { id: "nope" }, undefined, undefined, mockCtx() as never),
    /No scheduled prompt matches/,
  );
});
