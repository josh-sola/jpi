import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

const runningAsRoot = process.getuid?.() === 0;

import { j } from "../../src/core/builder.ts";
import { Config } from "../../src/core/config.ts";

async function tempEnv(): Promise<NodeJS.ProcessEnv> {
  const directory = await mkdtemp(join(tmpdir(), "jpi-base-config-"));
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
        bash: j.list(j.string(), {
          description: "regexes; a full command match skips review",
          default: [],
        }),
      },
    }),
    policy: j.list(j.string(), { description: "extra review policy lines", default: [] }),
  },
});

test("load creates jpi.kdl with the header and the section on a missing file", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);

  const { value, issues } = await config.load();
  assert.deepEqual(issues, []);
  assert.equal(value.model, "anthropic/claude-sonnet-5");

  const text = await readFile(config.path, "utf8");
  assert.match(
    text,
    /^\/\/ jpi\.kdl — config for all jpi plugins\.\n\/\/ Sections are added by each plugin on first load\.\n/,
  );
  assert.match(text, /guardian \{/);
});

test("a second load reads the already-written file without changing it", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);

  await config.load();
  const textAfterFirst = await readFile(config.path, "utf8");

  const { value, issues } = await config.load();
  const textAfterSecond = await readFile(config.path, "utf8");

  assert.deepEqual(issues, []);
  assert.equal(value.model, "anthropic/claude-sonnet-5");
  assert.equal(textAfterSecond, textAfterFirst);
});

test("an existing file with the section absent gets the stanza appended after a blank line", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  await writeFile(
    config.path,
    "// jpi.kdl — config for all jpi plugins.\n// Sections are added by each plugin on first load.\n",
    "utf8",
  );

  const { value, issues } = await config.load();
  assert.deepEqual(issues, []);
  assert.equal(value.model, "anthropic/claude-sonnet-5");

  const text = await readFile(config.path, "utf8");
  assert.equal(
    text,
    "// jpi.kdl — config for all jpi plugins.\n// Sections are added by each plugin on first load.\n\nguardian {\n" +
      '  // model that runs the reviews\n  model "anthropic/claude-sonnet-5"\n' +
      "  // set to #false to disable reviews\n  enabled #true\n" +
      "  // per-review timeout in milliseconds\n  timeout-ms 10000\n" +
      "  allow {\n" +
      '    // tool names that skip review (repeat: tool "name")\n' +
      "    // regexes; a full command match skips review\n" +
      "  }\n" +
      "  // extra review policy lines\n" +
      "}\n",
  );
});

test("a section already present decodes its live values", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  await writeFile(
    config.path,
    [
      "guardian {",
      '  model "custom-model"',
      "  enabled #false",
      "  timeout-ms 5000",
      "  allow {",
      '    tool "web_search"',
      '    bash "^git status"',
      "  }",
      '  policy "be nice"',
      '  policy "be terse"',
      "}",
    ].join("\n"),
    "utf8",
  );

  const { value, issues } = await config.load();
  assert.deepEqual(issues, []);
  assert.deepEqual(value, {
    model: "custom-model",
    enabled: false,
    timeoutMs: 5000,
    allow: { tool: ["web_search"], bash: ["^git status"] },
    policy: ["be nice", "be terse"],
  });
});

test("corrupt KDL reports an issue with location, falls back to defaults, and leaves the file untouched", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  const corrupt = 'guardian {\n  model "unterminated\n}\n';
  await writeFile(config.path, corrupt, "utf8");

  const { value, issues } = await config.load();
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /^could not parse jpi\.kdl: .*\d+:\d+/);
  assert.equal(value.model, "anthropic/claude-sonnet-5");

  const textAfter = await readFile(config.path, "utf8");
  assert.equal(textAfter, corrupt);
});

test("unknown keys are reported as an issue but the rest of the section still decodes", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  await writeFile(
    config.path,
    ["guardian {", '  model "custom-model"', "  mystery-field 1", "}"].join("\n"),
    "utf8",
  );

  const { value, issues } = await config.load();
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /unknown node "mystery-field"/);
  assert.equal(value.model, "custom-model");
});

test("a type-violating value reports an issue and falls back to full defaults, not a partial merge", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  await writeFile(
    config.path,
    ["guardian {", '  model "custom-model"', '  timeout-ms "not-a-number"', "}"].join("\n"),
    "utf8",
  );

  const { value, issues } = await config.load();
  assert.equal(issues.length, 1);
  assert.match(issues[0]!, /guardian\.timeoutMs: .*expected number/);
  // model was valid but the whole section still falls back to schema defaults.
  assert.equal(value.model, "anthropic/claude-sonnet-5");
  assert.equal(value.timeoutMs, 10000);
});

test("Config exposes the resolved jpi.kdl path", async () => {
  const env = await tempEnv();
  const config = new Config("guardian", schema, env);
  assert.match(config.path, /jpi\.kdl$/);
});

// root bypasses permission checks, so these two skip under root.
test.skipIf(runningAsRoot)(
  "an unwritable agent directory reports an issue instead of throwing",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "jpi-base-config-ro-dir-"));
    await chmod(directory, 0o500);
    try {
      const config = new Config("guardian", schema, { PI_CODING_AGENT_DIR: directory });
      const { value, issues } = await config.load();
      assert.equal(issues.length, 1);
      assert.match(issues[0]!, /^could not read jpi\.kdl: /);
      assert.equal(value.model, "anthropic/claude-sonnet-5");
    } finally {
      await chmod(directory, 0o700);
    }
  },
);

test.skipIf(runningAsRoot)(
  "a read-only jpi.kdl reports a write issue when appending a stanza, without a partial value",
  async () => {
    const env = await tempEnv();
    const config = new Config("guardian", schema, env);
    await writeFile(
      config.path,
      "// jpi.kdl — config for all jpi plugins.\n// Sections are added by each plugin on first load.\n",
      "utf8",
    );
    await chmod(config.path, 0o400);
    try {
      const { value, issues } = await config.load();
      assert.equal(issues.length, 1);
      assert.match(issues[0]!, /^could not write jpi\.kdl: /);
      assert.equal(value.model, "anthropic/claude-sonnet-5");
    } finally {
      await chmod(config.path, 0o600);
    }
  },
);
