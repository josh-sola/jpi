import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { j } from "../../src/core/builder.ts";
import { Config } from "../../src/core/config.ts";

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "jpi-base-config-save-"));
  return { PI_CODING_AGENT_DIR: directory };
}

const schema = j.node({
  fields: {
    model: j.string().describe("model that runs the reviews").default("anthropic/claude-sonnet-5"),
    enabled: j.boolean().describe("set to #false to disable reviews").default(true),
    timeoutMs: j
      .number()
      .int()
      .positive()
      .describe("per-review timeout in milliseconds")
      .default(10000),
    allow: j.node({
      fields: {
        tool: j.list(j.string(), {
          description: 'tool names that skip review (repeat: tool "name")',
          default: [],
        }),
      },
    }),
    policy: j.list(j.string(), { description: "extra review policy lines", default: [] }),
  },
});

test("save + load round-trips a boolean and a number field", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  await config.load();

  const { issues } = await config.save({ enabled: false, timeoutMs: 42 });
  assert.deepEqual(issues, []);

  const { value, issues: loadIssues } = await config.load();
  assert.deepEqual(loadIssues, []);
  assert.equal(value.enabled, false);
  assert.equal(value.timeoutMs, 42);
});

test("save preserves everything else in the file byte-for-byte, changing only the touched value's line", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  const original = [
    "// jpi.kdl — config for all jpi plugins.",
    "// header comment kept as-is",
    "",
    "status {",
    "  // another section, untouched",
    '  widget "clock"',
    "",
    "  width 45",
    "}",
    "",
    "// a comment right before our section",
    "guardian {",
    '  model "custom-model" // inline comment on a kept field',
    "  enabled #true",
    "  timeout-ms 5000",
    "  mystery-node 1",
    "}",
    "",
  ].join("\n");
  await writeFile(config.path, original, "utf8");

  const { issues } = await config.save({ enabled: false });
  assert.deepEqual(issues, []);

  const after = await readFile(config.path, "utf8");
  const expected = original.replace("  enabled #true", "  enabled #false");
  assert.equal(after, expected);
});

test("save inserts a field that's absent from an existing stanza", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  await writeFile(
    config.path,
    ["guardian {", '  model "custom-model"', "}"].join("\n") + "\n",
    "utf8",
  );

  const { issues } = await config.save({ timeoutMs: 777 });
  assert.deepEqual(issues, []);

  const after = await readFile(config.path, "utf8");
  assert.equal(
    after,
    ["guardian {", '  model "custom-model"', "  timeout-ms 777", "}"].join("\n") + "\n",
  );

  const { value, issues: loadIssues } = await config.load();
  assert.deepEqual(loadIssues, []);
  assert.equal(value.timeoutMs, 777);
});

test("saving an unsupported nested key returns an issue and writes nothing", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  const original = ["guardian {", '  model "custom-model"', "}"].join("\n") + "\n";
  await writeFile(config.path, original, "utf8");

  const { issues } = await config.save({ allow: { tool: ["web_search"] } } as never);
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /guardian\.allow: not a top-level scalar field/);

  const after = await readFile(config.path, "utf8");
  assert.equal(after, original);
});

test("saving an invalid value returns an issue and writes nothing", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  const original = ["guardian {", '  model "custom-model"', "}"].join("\n") + "\n";
  await writeFile(config.path, original, "utf8");

  const { issues } = await config.save({ timeoutMs: -5 });
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /^guardian\.timeoutMs: /);

  const after = await readFile(config.path, "utf8");
  assert.equal(after, original);
});

test("save creates a missing file and its section, then applies the change", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);

  const { issues } = await config.save({ model: "fresh-model" });
  assert.deepEqual(issues, []);

  const { value, issues: loadIssues } = await config.load();
  assert.deepEqual(loadIssues, []);
  assert.equal(value.model, "fresh-model");
});

test("save appends the section when the file exists but the section is missing", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  await writeFile(
    config.path,
    "// jpi.kdl — config for all jpi plugins.\n// Sections are added by each plugin on first load.\n",
    "utf8",
  );

  const { issues } = await config.save({ model: "fresh-model" });
  assert.deepEqual(issues, []);

  const { value, issues: loadIssues } = await config.load();
  assert.deepEqual(loadIssues, []);
  assert.equal(value.model, "fresh-model");
});

test("save with no changes is a no-op", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  const original = ["guardian {", '  model "custom-model"', "}"].join("\n") + "\n";
  await writeFile(config.path, original, "utf8");

  const { issues } = await config.save({});
  assert.deepEqual(issues, []);

  const after = await readFile(config.path, "utf8");
  assert.equal(after, original);
});

const unionSchema = j.node({
  fields: {
    fallback: j
      .union(j.string(), j.literal(false))
      .describe("agent to use when nothing else matches")
      .default("general-purpose"),
  },
});

test("save writes the boolean arm of a union field as #false, then loads it back", async () => {
  const env = await tempEnv();
  const config = new Config("agents", unionSchema, env);
  await config.load();

  const { issues } = await config.save({ fallback: false });
  assert.deepEqual(issues, []);

  const after = await readFile(config.path, "utf8");
  assert.match(after, /\n {2}fallback #false\n/);

  const { value, issues: loadIssues } = await config.load();
  assert.deepEqual(loadIssues, []);
  assert.equal(value.fallback, false);
});

test("save writes the string arm of a union field as a quoted string, then loads it back", async () => {
  const env = await tempEnv();
  const config = new Config("agents", unionSchema, env);
  await config.save({ fallback: false });

  const { issues } = await config.save({ fallback: "anthropic/claude-sonnet-5" });
  assert.deepEqual(issues, []);

  const after = await readFile(config.path, "utf8");
  assert.match(after, /\n {2}fallback "anthropic\/claude-sonnet-5"\n/);

  const { value, issues: loadIssues } = await config.load();
  assert.deepEqual(loadIssues, []);
  assert.equal(value.fallback, "anthropic/claude-sonnet-5");
});
