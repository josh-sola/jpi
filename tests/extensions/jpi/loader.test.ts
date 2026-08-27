import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadModules } from "../../../extensions/jpi/index.ts";
import { j } from "../../../src/core/builder.ts";
import { injectEnabled, type JpiModule } from "../../../src/core/module.ts";

const fakePi = {} as ExtensionAPI;

async function withTempAgentDir(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jpi-loader-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.onTestFinished(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

const colorSchema = j.node({
  fields: { color: j.string().describe("widget color").default("blue") },
});

test("enabled renders first in a freshly seeded stanza", async (t) => {
  const directory = await withTempAgentDir(t);
  const mod: JpiModule = {
    name: "widget",
    section: "widget",
    schema: colorSchema,
    setup: () => {},
  };

  await loadModules(fakePi, [mod]);

  const text = await readFile(join(directory, "jpi.kdl"), "utf8");
  const section = text.slice(text.indexOf("widget {"));
  const enabledLine = section.indexOf("enabled #true");
  const colorLine = section.indexOf('color "blue"');
  assert.ok(enabledLine >= 0, "enabled field missing from rendered stanza");
  assert.ok(colorLine >= 0, "color field missing from rendered stanza");
  assert.ok(enabledLine < colorLine, "enabled must render before the module's own fields");
});

test("a disabled module's setup is never called", async (t) => {
  const directory = await withTempAgentDir(t);
  await writeFile(join(directory, "jpi.kdl"), "widget {\n  enabled #false\n}\n", "utf8");

  let called = false;
  const mod: JpiModule = {
    name: "widget",
    section: "widget",
    schema: colorSchema,
    setup: () => {
      called = true;
    },
  };

  const { issues, failures } = await loadModules(fakePi, [mod]);
  assert.equal(called, false);
  assert.deepEqual(issues, []);
  assert.deepEqual(failures, []);
});

test("an existing enabled #false line decodes into the injected field", async (t) => {
  const directory = await withTempAgentDir(t);
  await writeFile(join(directory, "jpi.kdl"), "widget {\n  enabled #false\n}\n", "utf8");

  let seenValue: { enabled: boolean } | undefined;
  const mod: JpiModule = {
    name: "widget",
    section: "widget",
    schema: colorSchema,
    setup: (_pi, ctx) => {
      seenValue = ctx.value as { enabled: boolean };
    },
  };

  await loadModules(fakePi, [mod]);
  assert.equal(seenValue, undefined, "setup must not run for a disabled module");
});

test("one module's setup throwing is collected as a failure and does not stop later modules", async (t) => {
  await withTempAgentDir(t);
  let secondCalled = false;
  const modules: JpiModule[] = [
    {
      name: "first",
      section: "first",
      setup: () => {
        throw new Error("boom");
      },
    },
    {
      name: "second",
      section: "second",
      setup: () => {
        secondCalled = true;
      },
    },
  ];

  const { failures } = await loadModules(fakePi, modules);
  assert.equal(secondCalled, true);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^first: boom$/);
});

test("issues from Config.load are collected prefixed with the module name", async (t) => {
  const directory = await withTempAgentDir(t);
  await writeFile(join(directory, "jpi.kdl"), "widget {\n  color 5\n}\n", "utf8");

  const mod: JpiModule = {
    name: "widget",
    section: "widget",
    schema: colorSchema,
    setup: () => {},
  };

  const { issues } = await loadModules(fakePi, [mod]);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^widget: widget\.color: /);
});

test("injectEnabled throws when a module schema declares its own enabled field", () => {
  const schema = j.node({
    fields: { enabled: j.boolean().describe("nope").default(true) },
  });
  assert.throws(() => injectEnabled("widget", schema), /must not declare its own "enabled"/);
});

test("injectEnabled throws when a module schema declares its own enabled attr", () => {
  const schema = j.node({
    attrs: { enabled: j.boolean().describe("nope").default(true) },
  });
  assert.throws(() => injectEnabled("widget", schema), /must not declare its own "enabled"/);
});

test("injectEnabled produces an enabled-only stanza when the module has no schema", async (t) => {
  const directory = await withTempAgentDir(t);
  const mod: JpiModule = { name: "widget", section: "widget", setup: () => {} };

  await loadModules(fakePi, [mod]);

  const text = await readFile(join(directory, "jpi.kdl"), "utf8");
  assert.match(
    text,
    /widget \{\n {2}\/\/ set to #false to disable the widget module entirely\n {2}enabled #true\n\}/,
  );
});
