import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";

import { Config } from "../../src/core/config.ts";
import type { FooterContext, NotifyLevel } from "../../src/pi/index.ts";
import {
  createDefaultStatusLineConfig,
  loadStatusLineConfig,
  statusSchema,
  type StatusLineConfig,
} from "../../modules/status/config.ts";
import {
  createCustomStatusPayload,
  CustomStatusController,
  getCustomOccurrences,
  type CustomStatusPayload,
  type IntervalScheduler,
} from "../../modules/status/custom.ts";
import {
  calculateStackPosition,
  displayBranch,
  loadRepositoryMetadata,
  parseStackMetadata,
  semanticallyEqual,
  stringHash,
  shortenBranch,
  worktreeColor,
  type ExecCommand,
} from "../../modules/status/data.ts";
import {
  createStatusExtension,
  RepositoryMetadataController,
} from "../../modules/status/extension.ts";
import {
  FLEET_CONSUMER_READY_CHANNEL,
  FLEET_PROVIDER_CHANNEL,
  type FleetConsumer,
  type FleetProviderPayload,
} from "../../modules/status/fleet-bridge.ts";
import { DEFAULT_STATUS_LINE_FORMAT, type StatusLineFormat } from "../../modules/status/layout.ts";
import {
  formatModelLine,
  formatPullRequest,
  formatRepositoryLine,
  formatStatuses,
  renderFooter,
  type WidthHelpers,
} from "../../modules/status/ui/render.ts";
import { FooterStats } from "../../modules/status/stats.ts";

/** Builds the same Config the loader would, for tests that exercise config loading directly. */
function statusConfig(env?: NodeJS.ProcessEnv): Config<typeof statusSchema> {
  return new Config("status", statusSchema, env);
}

const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g;

type Notification = { message: string; level?: NotifyLevel };

// Derived from FooterContext.ui.setFooter's own parameter type rather than
// hand-mirrored, so the test doubles below get real parameter types instead
// of implicit any.
type FooterFactory = NonNullable<Parameters<FooterContext["ui"]["setFooter"]>[0]>;

type ExecOptions = { cwd?: string; timeout?: number; signal?: AbortSignal };
type ExecResult = Awaited<ReturnType<ExecCommand>>;
type ExecCall = { command: string; args: string[]; options?: ExecOptions };
type FakeTimer = { callback: () => void; delay: number };
type RawStackEntry = {
  branch: string;
  parent?: string | null;
  current: boolean;
  prNumber?: number | null;
  prDraft: boolean;
};

function plain(text: string): string {
  return text.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "");
}

const widthHelpers: WidthHelpers = {
  visibleWidth: (text) => plain(text).length,
  truncateToWidth(text, width, ellipsis = "...") {
    const visible = plain(text);
    if (visible.length <= width) return text;
    const suffix = plain(ellipsis).slice(0, width);
    return `${visible.slice(0, Math.max(0, width - suffix.length))}${suffix}`;
  },
};

function stackJson(entries: readonly RawStackEntry[]): string {
  return JSON.stringify({ available: true, stacks: [{ entries }] });
}

function ok(stdout = ""): ExecResult {
  return { stdout, stderr: "", code: 0, killed: false };
}

async function tempEnv(): Promise<{ PI_CODING_AGENT_DIR: string }> {
  const directory = await mkdtemp(join(tmpdir(), "jpi-status-config-"));
  return { PI_CODING_AGENT_DIR: directory };
}

/** In-process event bus test double, matching pi's `EventBus` (`on`/`emit`). */
function fakeEventBus() {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    emitted,
    listenerCount(channel: string): number {
      return listeners.get(channel)?.size ?? 0;
    },
    on(channel: string, handler: (data: unknown) => void): () => void {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(handler);
      return () => {
        listeners.get(channel)?.delete(handler);
      };
    },
    emit(channel: string, data: unknown): void {
      emitted.push({ channel, data });
      for (const handler of listeners.get(channel) ?? []) handler(data);
    },
  };
}

const inertScheduler: IntervalScheduler = {
  setInterval(): ReturnType<typeof setInterval> {
    return {} as unknown as ReturnType<typeof setInterval>;
  },
  clearInterval(): void {},
};

function manualScheduler(): IntervalScheduler & { timers: FakeTimer[]; cleared: FakeTimer[] } {
  const timers: FakeTimer[] = [];
  const cleared: FakeTimer[] = [];
  return {
    timers,
    cleared,
    setInterval(callback: () => void, delay: number): ReturnType<typeof setInterval> {
      const timer: FakeTimer = { callback, delay };
      timers.push(timer);
      return timer as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(timer: ReturnType<typeof setInterval>): void {
      cleared.push(timer as unknown as FakeTimer);
    },
  };
}

function customPayload(cwd = "/repo"): CustomStatusPayload {
  return {
    cwd,
    idle: true,
    model: null,
    thinkingLevel: null,
    context: { tokens: null, contextWindow: null, percent: null },
    repository: {},
    statuses: {},
  };
}

function statusLineConfig(
  format: StatusLineFormat = DEFAULT_STATUS_LINE_FORMAT,
  disabledStatuses: readonly string[] = [],
): StatusLineConfig {
  return { format, disabledStatuses: new Set(disabledStatuses) };
}

test("status config resolves to jpi.kdl under the Pi agent directory", async () => {
  const env = await tempEnv();
  const config = statusConfig(env);
  assert.match(config.path, /jpi\.kdl$/);
  assert.equal(config.path, join(env.PI_CODING_AGENT_DIR, "jpi.kdl"));
});

test("loading with no jpi.kdl file writes the live-default stanza and decodes cleanly", async () => {
  const env = await tempEnv();
  const config = statusConfig(env);

  const result = await loadStatusLineConfig(config);
  assert.equal(result.problem, undefined);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.config, createDefaultStatusLineConfig());

  const text = await readFile(config.path, "utf8");
  assert.match(text, /status \{/);
  assert.match(
    text,
    /row "@jpi\/model" "@jpi\/context" "@jpi\/repository" "@jpi\/worktree" "@jpi\/branch" "@jpi\/pull-request" "@jpi\/stack"/,
  );
  assert.match(text, /row "@jpi\/slot"/);
});

test("a hand-written status section decodes rows and disabled statuses", async () => {
  const env = await tempEnv();
  const config = statusConfig(env);
  await writeFile(
    config.path,
    [
      "status {",
      "  format {",
      '    row "@jpi/model" "@jpi/branch"',
      '    row "@custom:bin/status"',
      "  }",
      '  disabled-statuses "auto-review"',
      "}",
    ].join("\n"),
    "utf8",
  );

  const result = await loadStatusLineConfig(config);
  assert.equal(result.problem, undefined);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.config.format, [["@jpi/model", "@jpi/branch"], ["@custom:bin/status"]]);
  assert.deepEqual([...result.config.disabledStatuses], ["auto-review"]);
});

test("repeated disabled-statuses nodes collect into a deduplicated set", async () => {
  const env = await tempEnv();
  const config = statusConfig(env);
  await writeFile(
    config.path,
    [
      "status {",
      "  format {",
      '    row "@jpi/model"',
      "  }",
      '  disabled-statuses "auto-review"',
      '  disabled-statuses "auto-review"',
      '  disabled-statuses "other"',
      "}",
    ].join("\n"),
    "utf8",
  );

  const result = await loadStatusLineConfig(config);
  assert.equal(result.problem, undefined);
  assert.deepEqual([...result.config.disabledStatuses], ["auto-review", "other"]);
});

test("an unknown @jpi/ component warns and falls back to the full default, discarding disabled-statuses too", async () => {
  const env = await tempEnv();
  const config = statusConfig(env);
  await writeFile(
    config.path,
    [
      "status {",
      "  format {",
      '    row "@jpi/modle"',
      "  }",
      '  disabled-statuses "kept-only-on-success"',
      "}",
    ].join("\n"),
    "utf8",
  );

  const result = await loadStatusLineConfig(config);
  assert.match(result.problem!, /unknown reserved ID @jpi\/modle/);
  assert.deepEqual(result.config.format, DEFAULT_STATUS_LINE_FORMAT);
  assert.deepEqual([...result.config.disabledStatuses], []);
});

test("a blank @custom: path warns and falls back to the full default", async () => {
  const env = await tempEnv();
  const config = statusConfig(env);
  await writeFile(
    config.path,
    ["status {", "  format {", '    row "@custom:"', "  }", "}"].join("\n"),
    "utf8",
  );

  const result = await loadStatusLineConfig(config);
  assert.match(result.problem!, /blank @custom: path/);
  assert.deepEqual(result.config.format, DEFAULT_STATUS_LINE_FORMAT);
  assert.deepEqual([...result.config.disabledStatuses], []);
});

test("custom executable paths resolve from root or the config directory by occurrence", () => {
  const occurrences = getCustomOccurrences(
    [["@custom:/opt/status", "extension", "@custom:bin/status"], ["@custom:bin/status"]],
    "/Users/tester/.pi/agent/jpi.kdl",
  );

  assert.deepEqual(occurrences, [
    {
      key: "0:0",
      id: "@custom:/opt/status",
      path: "/opt/status",
      lineIndex: 0,
      componentIndex: 0,
    },
    {
      key: "0:2",
      id: "@custom:bin/status",
      path: "/Users/tester/.pi/agent/bin/status",
      lineIndex: 0,
      componentIndex: 2,
    },
    {
      key: "1:0",
      id: "@custom:bin/status",
      path: "/Users/tester/.pi/agent/bin/status",
      lineIndex: 1,
      componentIndex: 0,
    },
  ]);
});

test("custom payloads expose exact current harness, repository, and sorted status data", () => {
  const repository = {
    repo: "jrepo",
    branch: "feature",
    pullRequest: { number: 42, draft: false },
  };
  const payload = createCustomStatusPayload(
    {
      cwd: "/repo",
      isIdle: () => false,
      thinkingLevel: "high",
      model: {
        id: "model-id",
        name: "Model Name",
        provider: "provider-id",
        reasoning: true,
        contextWindow: 200_000,
        maxTokens: 32_000,
      },
      getContextUsage: () => ({ tokens: 75_000, contextWindow: 200_000, percent: 37.5 }),
    },
    repository,
    new Map([
      ["z-status", "last"],
      ["disabled-status", "still included"],
      ["a-status", "first"],
    ]),
  );

  assert.deepEqual(payload, {
    cwd: "/repo",
    idle: false,
    model: {
      id: "model-id",
      name: "Model Name",
      provider: "provider-id",
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 32_000,
    },
    thinkingLevel: "high",
    context: { tokens: 75_000, contextWindow: 200_000, percent: 37.5 },
    repository,
    statuses: {
      "a-status": "first",
      "disabled-status": "still included",
      "z-status": "last",
    },
  });
  assert.deepEqual(Object.keys(payload.statuses), ["a-status", "disabled-status", "z-status"]);

  assert.deepEqual(
    createCustomStatusPayload(
      {
        getContextUsage: () => undefined,
      },
      {},
      new Map(),
    ),
    {
      cwd: null,
      idle: null,
      model: null,
      thinkingLevel: null,
      context: { tokens: null, contextWindow: null, percent: null },
      repository: {},
      statuses: {},
    },
  );
  assert.equal(
    createCustomStatusPayload(
      {
        model: { contextWindow: 128_000 },
        getContextUsage: () => undefined,
      },
      {},
      new Map(),
    ).context.contextWindow,
    128_000,
  );
});

test("branch display matches the Claude status line and deduplicates wt names", () => {
  assert.equal(shortenBranch("josh/be-2006_add_status"), "be-2006 add status");
  assert.equal(shortenBranch("07-07-123_feature_name"), "feature name");
  assert.equal(shortenBranch(`owner/${"x".repeat(45)}`), `${"x".repeat(39)}…`);
  assert.equal(semanticallyEqual("Pi Status_Line", "pi-status-line"), true);
  assert.equal(displayBranch("josh/pi-status-line", "Pi status line"), undefined);
  assert.equal(displayBranch("josh/different-branch", "Pi status line"), "different-branch");
});

test("worktree colors use a stable string hash", () => {
  const id = "01a024cd-9793-7761-872b-1116038f4faa";
  assert.equal(stringHash(id), 2159015151);
  assert.equal(worktreeColor(id), 159);
  assert.equal(worktreeColor(id), worktreeColor(id));
});

test("repository segments have no orphan separators", () => {
  assert.equal(formatRepositoryLine({}), undefined);
  assert.equal(
    plain(formatRepositoryLine({ repo: "jrepo", branch: "feature" })!),
    "jrepo · feature",
  );
  assert.equal(
    plain(formatRepositoryLine({ worktree: { name: "Status footer", color: 39 } })!),
    "Status footer",
  );
});

test("stack position uses depth and the longest branch from the first stacked branch", () => {
  const entries = [
    { branch: "main", current: false, prDraft: false },
    { branch: "a", parent: "main", current: false, prDraft: false },
    { branch: "b", parent: "a", current: true, prDraft: false },
    { branch: "c", parent: "a", current: false, prDraft: false },
    { branch: "d", parent: "c", current: false, prDraft: false },
  ];

  assert.deepEqual(calculateStackPosition(entries, "b"), { position: 2, total: 3 });
  assert.deepEqual(
    calculateStackPosition(
      entries.map((entry) => ({ ...entry, current: entry.branch === "a" })),
      "a",
    ),
    { position: 1, total: 3 },
  );
  assert.equal(calculateStackPosition(entries.slice(0, 2), "a"), undefined);
  assert.equal(
    calculateStackPosition(
      entries.map((entry) => ({ ...entry, current: entry.branch === "main" })),
      "main",
    ),
    undefined,
  );
});

test("stack parsing uses the current entry for PR and Graphite link data", () => {
  const parsed = parseStackMetadata(
    stackJson([
      { branch: "main", parent: null, current: false, prNumber: null, prDraft: false },
      { branch: "feature", parent: "main", current: true, prNumber: 42, prDraft: true },
      { branch: "next", parent: "feature", current: false, prNumber: 43, prDraft: false },
    ]),
    "feature",
    "git@github.com:josh-sola/jrepo.git",
  );

  assert.deepEqual(parsed.pullRequest, {
    number: 42,
    draft: true,
    url: "https://app.graphite.com/github/pr/josh-sola/jrepo/42",
  });
  assert.deepEqual(parsed.stack, { position: 1, total: 2 });

  const nonGitHub = parseStackMetadata(
    stackJson([{ branch: "feature", parent: null, current: true, prNumber: 7, prDraft: false }]),
    "feature",
    "ssh://git@example.com/team/repo.git",
  );
  assert.equal(nonGitHub.pullRequest!.url, undefined);
});

test("PR formatting keeps draft styling inside a valid OSC 8 link", () => {
  const rendered = formatPullRequest({
    number: 42,
    draft: true,
    url: "https://example.test/pr/42",
  });
  assert.equal(plain(rendered), "#42 draft");
  assert.match(rendered, /^\x1b\]8;;https:\/\/example\.test\/pr\/42\x1b\\/);
  assert.match(rendered, /\x1b\]8;;\x1b\\$/);
});

test("extension statuses are sorted and sanitized without stripping ANSI", () => {
  const green = "\x1b[38;5;108mgreen\x1b[0m";
  const statuses = new Map([
    ["z-status", `${green}\n ready`],
    ["a-status", " first\tvalue "],
    ["empty", "\n\t"],
  ]);
  const rendered = formatStatuses(statuses);

  assert.equal(plain(rendered!), "first value · green ready");
  assert.match(rendered!, /\x1b\[38;5;108mgreen\x1b\[0m/);
  assert.equal(plain(formatStatuses(statuses, new Set(["a-status"]))!), "green ready");
  assert.equal(
    plain(formatStatuses(statuses, new Set(["A-status"]))!),
    "first value · green ready",
  );
});

test("model and context lines use the approved colors and thresholds", () => {
  assert.match(formatModelLine("GPT-5.6", 49.4), /38;5;108mctx 49%/);
  assert.match(formatModelLine("GPT-5.6", 50), /38;5;179mctx 50%/);
  assert.match(formatModelLine("GPT-5.6", 80), /38;5;174mctx 80%/);
  assert.equal(plain(formatModelLine("GPT-5.6")), "GPT-5.6");
});

test("configured local components render in line and component order", () => {
  const lines = renderFooter(
    {
      modelName: "GPT-5.6 Sol",
      contextPercent: 51,
      repository: {
        repo: "jrepo",
        worktree: { name: "Status footer", color: 39 },
        branch: "feature",
        pullRequest: { number: 42, draft: true },
        stack: { position: 2, total: 4 },
      },
      statuses: new Map(),
      config: statusLineConfig([
        ["@jpi/stack", "@jpi/pull-request", "@jpi/branch"],
        ["@jpi/worktree", "@jpi/repository", "@jpi/context", "@jpi/model"],
      ]),
    },
    120,
    widthHelpers,
  );

  assert.deepEqual(lines.map(plain), [
    " stack 2/4 · #42 draft · feature",
    " Status footer · jrepo · ctx 51% · GPT-5.6 Sol",
  ]);
});

test("extension IDs render where placed and drop out of the slot", () => {
  const snapshot = {
    modelName: "Test model",
    repository: {},
    statuses: new Map([
      ["z-status", " z\nready "],
      ["auto-review", " review\t on "],
      ["empty", "\n\t"],
    ]),
  };
  const filtered = renderFooter(
    {
      ...snapshot,
      config: statusLineConfig(
        [
          ["auto-review", "missing-status", "@jpi/slot"],
          ["@jpi/slot", "auto-review"],
          [],
          ["missing-status"],
        ],
        ["auto-review"],
      ),
    },
    120,
    widthHelpers,
  );
  assert.deepEqual(filtered.map(plain), [" review on · z ready", " z ready · review on"]);

  const duplicated = renderFooter(
    {
      ...snapshot,
      config: statusLineConfig([["auto-review", "@jpi/slot", "auto-review"]]),
    },
    120,
    widthHelpers,
  );
  assert.deepEqual(duplicated.map(plain), [" review on · z ready · review on"]);
  assert.deepEqual(
    renderFooter(
      {
        ...snapshot,
        config: statusLineConfig([]),
      },
      120,
      widthHelpers,
    ),
    [],
  );
});

test("every rendered footer line starts with a space and respects narrow widths", () => {
  const lines = renderFooter(
    {
      modelName: "A very long model display name",
      contextPercent: 83,
      repository: {
        repo: "jrepo",
        worktree: { name: "A long friendly worktree name", color: 39 },
        branch: "long-feature-branch",
        pullRequest: { number: 42, draft: false, url: "https://example.test/pr/42" },
        stack: { position: 2, total: 4 },
      },
      statuses: new Map([["status", "a long extension status"]]),
      config: statusLineConfig(),
    },
    12,
    widthHelpers,
  );

  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => plain(line).startsWith(" ")));
  assert.ok(lines.every((line) => widthHelpers.visibleWidth(line) <= 12));
  assert.deepEqual(
    renderFooter(
      {
        modelName: "Model",
        repository: {},
        statuses: new Map(),
        config: statusLineConfig([["@jpi/model"]]),
      },
      0,
      widthHelpers,
    ),
    [],
  );
});

test("custom outputs render by occurrence with sanitization, joining, omission, and width fitting", () => {
  const snapshot = {
    modelName: "Model",
    repository: {},
    statuses: new Map([["extension", " extension\tvalue "]]),
    customOutputs: new Map([
      ["0:0", " first\nvalue "],
      ["0:2", "   "],
      ["2:0", "a very long custom value"],
    ]),
    config: statusLineConfig([
      ["@custom:first", "extension", "@custom:blank"],
      ["@custom:missing"],
      ["@custom:long"],
    ]),
  };

  assert.deepEqual(renderFooter(snapshot, 80, widthHelpers).map(plain), [
    " first value · extension value",
    " a very long custom value",
  ]);
  assert.ok(
    renderFooter(snapshot, 9, widthHelpers).every(
      (line) => plain(line).startsWith(" ") && widthHelpers.visibleWidth(line) <= 9,
    ),
  );
});

test("custom commands start immediately, run duplicates concurrently, and use one periodic timer", async () => {
  const scheduler = manualScheduler();
  const calls: ExecCall[] = [];
  const pending: Array<(value: ExecResult) => void> = [];
  let payloadVersion = 1;
  let renderRequests = 0;
  const exec: ExecCommand = (command, args, options) =>
    new Promise((resolve) => {
      calls.push({ command, args, ...(options !== undefined && { options }) });
      pending.push(resolve);
    });
  const controller = new CustomStatusController({
    exec,
    format: [["@custom:bin/status", "@custom:bin/status"]],
    configPath: "/config/jpi.kdl",
    getPayload: () => ({ ...customPayload(), statuses: { version: String(payloadVersion) } }),
    requestRender: () => {
      renderRequests += 1;
    },
    notify() {},
    scheduler,
  });

  const started = controller.start();
  assert.equal(calls.length, 2);
  assert.equal(scheduler.timers.length, 1);
  assert.equal(scheduler.timers[0]!.delay, 10_000);
  assert.ok(calls.every((call) => call.command === "/config/bin/status"));
  assert.ok(calls.every((call) => call.args.length === 1));
  assert.ok(calls.every((call) => call.options?.cwd === "/repo"));
  assert.ok(calls.every((call) => call.options?.timeout === 3_000));
  assert.ok(calls.every((call) => call.options?.signal instanceof AbortSignal));
  assert.deepEqual(JSON.parse(calls[0]!.args[0]!).statuses, { version: "1" });

  payloadVersion = 2;
  scheduler.timers[0]!.callback();
  scheduler.timers[0]!.callback();
  assert.equal(calls.length, 2);
  pending[0]!(ok("old first"));
  pending[1]!(ok("old second"));
  await started;
  assert.equal(calls.length, 4);
  assert.deepEqual(JSON.parse(calls[2]!.args[0]!).statuses, { version: "2" });
  pending[2]!(ok("new first\nvalue"));
  pending[3]!(ok("new second"));
  await new Promise(setImmediate);

  assert.deepEqual(
    [...controller.outputs],
    [
      ["0:0", "new first\nvalue"],
      ["0:1", "new second"],
    ],
  );
  assert.equal(renderRequests, 2);
  controller.dispose();
  assert.deepEqual(scheduler.cleared, [scheduler.timers[0]]);
});

test("custom failures hide output and warn once per reason; timeouts stay silent", async () => {
  const scheduler = manualScheduler();
  const notifications: Array<{ message: string; level: NotifyLevel }> = [];
  const responses: Array<ExecResult | Error> = [
    ok("visible"),
    { ...ok(), code: 7, stderr: " denied\nnow " },
    { ...ok(), code: 7, stderr: " denied\nnow " },
    new Error("permission denied"),
    { ...ok(), killed: true },
    ok(" \n\t "),
    { ...ok(), killed: true },
    { ...ok(), killed: true },
  ];
  const controller = new CustomStatusController({
    exec: async () => {
      const response = responses.shift()!;
      if (response instanceof Error) throw response;
      return response;
    },
    format: [["@custom:status"]],
    configPath: "/config/jpi.kdl",
    getPayload: () => customPayload(),
    requestRender() {},
    notify: (message, level) => notifications.push({ message, level }),
    scheduler,
  });

  await controller.start();
  assert.equal(controller.outputs.get("0:0"), "visible");
  await controller.refresh();
  assert.equal(controller.outputs.size, 0);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0]!.message, /@custom:status.*format\[0\]\[0\].*code 7: denied now/);
  await controller.refresh();
  assert.equal(notifications.length, 1);
  await controller.refresh();
  assert.equal(notifications.length, 2);
  assert.match(notifications[1]!.message, /could not run: permission denied/);
  await controller.refresh();
  assert.equal(notifications.length, 2);
  assert.equal(controller.outputs.size, 0);
  await controller.refresh();
  assert.equal(controller.outputs.size, 0);
  await controller.refresh();
  assert.equal(notifications.length, 2);
  assert.equal(controller.outputs.size, 0);
  await controller.updateFormat([["@custom:status"]]);
  assert.equal(notifications.length, 2);
  assert.ok(notifications.every(({ level }) => level === "warning"));
  controller.dispose();
});

test("disposing custom commands aborts in-flight execution and clears its timer", async () => {
  const scheduler = manualScheduler();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const controller = new CustomStatusController({
    exec: (_command, _args, options) => {
      calls += 1;
      signal = options?.signal;
      return new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
    format: [["@custom:status"]],
    configPath: "/config/jpi.kdl",
    getPayload: () => customPayload(),
    requestRender() {},
    notify() {},
    scheduler,
  });

  const started = controller.start();
  assert.equal(calls, 1);
  assert.equal(signal!.aborted, false);
  controller.dispose();
  assert.equal(signal!.aborted, true);
  assert.deepEqual(scheduler.cleared, [scheduler.timers[0]]);
  await started;
  await controller.refresh();
  assert.equal(calls, 1);
});

test("metadata loading uses bounded git and wt commands and degrades optional fields", async () => {
  const calls: ExecCall[] = [];
  const exec: ExecCommand = async (command, args, options) => {
    calls.push({ command, args, ...(options !== undefined && { options }) });
    const key = `${command} ${args.join(" ")}`;
    const outputs = new Map([
      ["git rev-parse --show-toplevel", "/trees/uuid\n"],
      ["git rev-parse --path-format=absolute --absolute-git-dir", "/repo/.git/worktrees/uuid\n"],
      ["git rev-parse --path-format=absolute --git-common-dir", "/repo/.git\n"],
      ["git branch --show-current", "josh/pi-status-line\n"],
      ["git remote get-url origin", "git@github.com:josh-sola/jrepo.git\n"],
      ["wt name --path /trees/uuid", "Pi status line\n"],
      ["wt stack --json --all-branches", stackJson([])],
    ]);
    return outputs.has(key) ? ok(outputs.get(key)!) : { ...ok(), code: 1 };
  };

  const metadata = await loadRepositoryMetadata(exec, "/trees/uuid", new AbortController().signal);
  assert.equal(metadata.repo, "jrepo");
  assert.equal(metadata.worktree!.name, "Pi status line");
  assert.equal(metadata.branch, undefined);
  assert.ok(calls.every((call) => call.options?.timeout === 3_000));
  assert.ok(calls.some((call) => call.command === "wt" && call.args[0] === "stack"));
});

test("the extension loads the status config before installing the footer", async () => {
  const env = await tempEnv();
  const config = statusConfig(env);
  await writeFile(
    config.path,
    [
      "status {",
      "  format {",
      '    row "other" "@jpi/model"',
      "  }",
      '  disabled-statuses "auto-review"',
      "}",
    ].join("\n"),
    "utf8",
  );

  let footerFactory: FooterFactory | undefined;
  const { value: initialValue } = await config.load();
  const extension = createStatusExtension(
    async () => ({ ...ok(), code: 1 }),
    widthHelpers,
    inertScheduler,
    config,
    initialValue,
  );
  const context: FooterContext = {
    mode: "tui",
    cwd: "/repo",
    model: { name: "Test model" },
    getContextUsage: () => undefined,
    ui: {
      setFooter(value) {
        footerFactory = value;
      },
      notify() {},
    },
  };

  await extension.onSessionStart({}, context);
  assert.equal(typeof footerFactory, "function");
  assert.ok(footerFactory);

  const component = footerFactory(
    { requestRender() {} },
    {},
    {
      getExtensionStatuses: () =>
        new Map([
          ["auto-review", "review: enabled"],
          ["other", "syncing"],
        ]),
      onBranchChange: () => () => {},
    },
  );
  assert.deepEqual(component.render(80).map(plain), [" syncing · Test model"]);
  component.dispose();
});

test("reloading status config rerenders valid and fail-default changes", async () => {
  const env = await tempEnv();
  const config = statusConfig(env);
  await writeFile(
    config.path,
    [
      "status {",
      "  format {",
      '    row "@jpi/model"',
      '    row "@jpi/slot"',
      "  }",
      '  disabled-statuses "hidden"',
      "}",
    ].join("\n"),
    "utf8",
  );

  let footerFactory: FooterFactory | undefined;
  let renderRequests = 0;
  const notifications: Notification[] = [];
  const { value: initialValue } = await config.load();
  const extension = createStatusExtension(
    async () => ({ ...ok(), code: 1 }),
    widthHelpers,
    inertScheduler,
    config,
    initialValue,
  );
  const context: FooterContext = {
    mode: "tui",
    cwd: "/repo",
    model: { name: "Test model" },
    getContextUsage: () => undefined,
    ui: {
      setFooter(value) {
        footerFactory = value;
      },
      notify(message, level) {
        notifications.push({ message, ...(level !== undefined && { level }) });
      },
    },
  };

  await extension.onSessionStart({}, context);
  assert.ok(footerFactory);
  const component = footerFactory(
    {
      requestRender() {
        renderRequests += 1;
      },
    },
    {},
    {
      getExtensionStatuses: () =>
        new Map([
          ["hidden", "hidden"],
          ["visible", "shown"],
        ]),
      onBranchChange: () => () => {},
    },
  );
  await new Promise(setImmediate);
  renderRequests = 0;
  assert.deepEqual(component.render(80).map(plain), [" Test model", " shown"]);

  await writeFile(
    config.path,
    ["status {", "  format {", '    row "visible" "@jpi/model"', "  }", "}"].join("\n"),
    "utf8",
  );
  await extension.onCommand("reload", context);
  assert.equal(renderRequests, 1);
  assert.deepEqual(component.render(80).map(plain), [" shown · Test model"]);
  assert.deepEqual(notifications.at(-1), {
    message: "jpi-status config reloaded.",
    level: "info",
  });

  await writeFile(
    config.path,
    [
      "status {",
      "  format {",
      '    row "@jpi/model"',
      '    row "@jpi/slot"',
      "  }",
      '  disabled-statuses "hidden"',
      "}",
    ].join("\n"),
    "utf8",
  );
  await extension.onCommand("reload", context);
  assert.equal(renderRequests, 2);
  assert.deepEqual(component.render(80).map(plain), [" Test model", " shown"]);

  await writeFile(config.path, 'status {\n  format {\n    row "unterminated\n  }\n}\n', "utf8");
  await extension.onCommand("reload", context);
  assert.equal(renderRequests, 3);
  assert.deepEqual(component.render(80).map(plain), [" Test model", " hidden · shown"]);
  assert.equal(notifications.at(-1)!.level, "warning");
  assert.match(notifications.at(-1)!.message, /has issues:/);
  assert.match(notifications.at(-1)!.message, /could not parse jpi\.kdl/);

  await writeFile(
    config.path,
    ["status {", "  format {", '    row "@jpi/modle"', "  }", "}"].join("\n"),
    "utf8",
  );
  await extension.onCommand("reload", context);
  assert.equal(renderRequests, 4);
  assert.deepEqual(component.render(80).map(plain), [" Test model", " hidden · shown"]);
  assert.equal(notifications.at(-1)!.level, "warning");
  assert.match(notifications.at(-1)!.message, /Could not load jpi-status config/);
  assert.match(notifications.at(-1)!.message, /unknown reserved ID @jpi\/modle/);
  assert.match(notifications.at(-1)!.message, /Using the default config\.$/);
  component.dispose();
});

test("reloading config aborts stale custom runs and immediately rebuilds occurrences", async () => {
  const env = await tempEnv();
  const config = statusConfig(env);
  const oldPath = join(env.PI_CODING_AGENT_DIR, "old");
  const newPath = join(env.PI_CODING_AGENT_DIR, "new");
  await writeFile(
    config.path,
    ["status {", "  format {", '    row "@custom:old"', "  }", "}"].join("\n"),
    "utf8",
  );

  let footerFactory: FooterFactory | undefined;
  let oldSignal: AbortSignal | undefined;
  let newCall: ExecCall | undefined;
  let renderRequests = 0;
  const scheduler = manualScheduler();
  const notifications: Notification[] = [];
  const exec: ExecCommand = async (command, args, options) => {
    if (command === oldPath) {
      oldSignal = options?.signal;
      return new Promise((_resolve, reject) => {
        oldSignal!.addEventListener("abort", () => reject(new Error("stale")), { once: true });
      });
    }
    if (command === newPath) {
      newCall = { command, args, ...(options !== undefined && { options }) };
      return ok(" new\noutput ");
    }
    return { ...ok(), code: 1 };
  };
  const { value: initialValue } = await config.load();
  const extension = createStatusExtension(exec, widthHelpers, scheduler, config, initialValue);
  const context: FooterContext = {
    mode: "tui",
    cwd: "/repo",
    model: { name: "Test model" },
    getContextUsage: () => undefined,
    ui: {
      setFooter(value) {
        footerFactory = value;
      },
      notify(message, level) {
        notifications.push({ message, ...(level !== undefined && { level }) });
      },
    },
  };

  await extension.onSessionStart({}, context);
  assert.ok(footerFactory);
  const component = footerFactory(
    {
      requestRender() {
        renderRequests += 1;
      },
    },
    {},
    {
      getExtensionStatuses: () => new Map([["disabled", "included in payload"]]),
      onBranchChange: () => () => {},
    },
  );
  assert.equal(oldSignal!.aborted, false);
  assert.deepEqual(component.render(80), []);

  await writeFile(
    config.path,
    ["status {", "  format {", '    row "@custom:new"', "  }", "}"].join("\n"),
    "utf8",
  );
  await extension.onCommand("reload", context);
  assert.equal(oldSignal!.aborted, true);
  assert.equal(newCall!.command, newPath);
  assert.deepEqual(JSON.parse(newCall!.args[0]!).statuses, { disabled: "included in payload" });
  assert.deepEqual(component.render(80).map(plain), [" new output"]);
  assert.ok(renderRequests >= 2);
  assert.deepEqual(notifications.at(-1), {
    message: "jpi-status config reloaded.",
    level: "info",
  });

  component.dispose();
  assert.equal(scheduler.cleared.length, 2);
});

test("the extension installs only in TUI mode and cleans up component resources", async () => {
  let footerFactory: FooterFactory | undefined;
  let branchCallback: (() => void) | undefined;
  let unsubscribed = false;
  let clearedTimer: ReturnType<typeof setInterval> | undefined;
  const notifications: Notification[] = [];
  const footerValues: Array<FooterFactory | undefined> = [];
  const scheduler: IntervalScheduler = {
    setInterval(callback, delay) {
      assert.equal(delay, 10_000);
      return { callback } as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval(timer) {
      clearedTimer = timer;
    },
  };
  const exec: ExecCommand = async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    const outputs = new Map([
      ["git rev-parse --show-toplevel", "/repo\n"],
      ["git rev-parse --path-format=absolute --absolute-git-dir", "/repo/.git\n"],
      ["git rev-parse --path-format=absolute --git-common-dir", "/repo/.git\n"],
      ["git branch --show-current", "main\n"],
      ["git remote get-url origin", "git@github.com:owner/repo.git\n"],
      ["wt stack --json --all-branches", stackJson([])],
    ]);
    return outputs.has(key) ? ok(outputs.get(key)!) : { ...ok(), code: 1 };
  };
  const env = await tempEnv();
  const config = statusConfig(env);
  const { value: initialValue } = await config.load();
  const extension = createStatusExtension(exec, widthHelpers, scheduler, config, initialValue);
  const context: FooterContext = {
    mode: "json",
    cwd: "/repo",
    model: { name: "Test model" },
    getContextUsage: () => ({ percent: 12.4 }),
    ui: {
      setFooter(value) {
        footerValues.push(value);
        footerFactory = value;
      },
      notify(message, level) {
        notifications.push({ message, ...(level !== undefined && { level }) });
      },
    },
  };

  await extension.onSessionStart({}, context);
  assert.equal(typeof footerFactory, "undefined");
  context.mode = "tui";
  await extension.onSessionStart({}, context);
  assert.equal(typeof footerFactory, "function");
  assert.equal(footerValues.includes(undefined), false);
  assert.ok(footerFactory);

  const component = footerFactory(
    { requestRender() {} },
    {},
    {
      getExtensionStatuses: () => new Map([["review", "review: enabled"]]),
      onBranchChange(callback) {
        branchCallback = callback;
        return () => {
          unsubscribed = true;
        };
      },
    },
  );
  await new Promise(setImmediate);
  assert.deepEqual(component.render(80).map(plain), [
    " Test model · ctx 12% · repo · main",
    " review: enabled",
  ]);
  assert.equal(typeof branchCallback, "function");

  await extension.onCommand("status", context);
  assert.equal(notifications.at(-1)!.message, "jpi-status footer is active.");
  component.dispose();
  assert.equal(unsubscribed, true);
  assert.ok(clearedTimer);
  await extension.onCommand("status", context);
  assert.equal(notifications.at(-1)!.message, "jpi-status footer is not active.");
  assert.equal(footerValues.includes(undefined), false);
});

test("metadata refreshes are single-flight and stale generations are not published", async () => {
  let releaseFirstStack: ((value: ExecResult) => void) | undefined;
  const firstStack: Promise<ExecResult> = new Promise((resolve) => {
    releaseFirstStack = resolve;
  });
  let stackCalls = 0;
  let renderRequests = 0;
  const exec: ExecCommand = async (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    if (key === "wt stack --json --all-branches") {
      stackCalls += 1;
      if (stackCalls === 1) return firstStack;
      return ok(stackJson([]));
    }
    const outputs = new Map([
      ["git rev-parse --show-toplevel", "/repo\n"],
      ["git rev-parse --path-format=absolute --absolute-git-dir", "/repo/.git\n"],
      ["git rev-parse --path-format=absolute --git-common-dir", "/repo/.git\n"],
      ["git branch --show-current", "main\n"],
      ["git remote get-url origin", "git@github.com:owner/repo.git\n"],
    ]);
    return outputs.has(key) ? ok(outputs.get(key)!) : { ...ok(), code: 1 };
  };
  const controller = new RepositoryMetadataController({
    exec,
    cwd: "/repo",
    requestRender: () => {
      renderRequests += 1;
    },
    onBranchChange: () => () => {},
    scheduler: {
      setInterval: () => ({ id: 1 }) as unknown as ReturnType<typeof setInterval>,
      clearInterval() {},
    },
    onDispose() {},
  });

  controller.start();
  await new Promise(setImmediate);
  assert.equal(stackCalls, 1);
  const refreshed = controller.refresh();
  assert.equal(stackCalls, 1);
  releaseFirstStack!(ok(stackJson([])));
  await refreshed;
  assert.equal(stackCalls, 2);
  assert.equal(renderRequests, 1);
  controller.dispose();
});

test("new footer segments render abbreviated counts and cumulative stats", () => {
  const lines = renderFooter(
    {
      modelName: "Model",
      sessionName: "Fix flaky test",
      contextWindow: 1_000_000,
      contextTokens: 750_000,
      turnCount: 4,
      liveSpeed: 42,
      cost: 1.5,
      tokensIn: 12_000,
      tokensOut: 4_000,
      cacheRead: 1_000,
      cacheWrite: 0,
      activeToolName: "Bash",
      cwd: "/Users/tester/project",
      homeDirectory: "/Users/tester",
      repository: {},
      statuses: new Map(),
      config: statusLineConfig([
        [
          "@jpi/name",
          "@jpi/ctx-total",
          "@jpi/ctx-used",
          "@jpi/ctx-remaining",
          "@jpi/turns",
          "@jpi/speed",
          "@jpi/cost",
          "@jpi/tokens-in",
          "@jpi/tokens-out",
          "@jpi/tokens-total",
          "@jpi/directory",
          "@jpi/tool",
        ],
      ]),
    },
    200,
    widthHelpers,
  );

  assert.deepEqual(lines.map(plain), [
    " Fix flaky test · max 1.0M · used 750k · left 250k · turns 4 · 42 tok/s · $1.500 · in 12k · out 4k · total 17k · ~/project · tool Bash",
  ]);
});

test("new footer segments omit unset session name, unknown context tokens, and an idle tool or speed", () => {
  const lines = renderFooter(
    {
      modelName: "Model",
      turnCount: 0,
      cost: 0,
      tokensIn: 0,
      tokensOut: 0,
      repository: {},
      statuses: new Map(),
      config: statusLineConfig([
        [
          "@jpi/name",
          "@jpi/ctx-used",
          "@jpi/ctx-remaining",
          "@jpi/speed",
          "@jpi/tool",
          "@jpi/turns",
          "@jpi/cost",
        ],
      ]),
    },
    120,
    widthHelpers,
  );

  assert.deepEqual(lines.map(plain), [" turns 0 · $0.000"]);
});

test("the directory segment abbreviates the home prefix and omits without a cwd", () => {
  const withSubdirectory = renderFooter(
    {
      modelName: "Model",
      cwd: "/Users/tester/project/sub",
      homeDirectory: "/Users/tester",
      repository: {},
      statuses: new Map(),
      config: statusLineConfig([["@jpi/directory"]]),
    },
    120,
    widthHelpers,
  );
  assert.deepEqual(withSubdirectory.map(plain), [" ~/project/sub"]);

  const atHome = renderFooter(
    {
      modelName: "Model",
      cwd: "/Users/tester",
      homeDirectory: "/Users/tester",
      repository: {},
      statuses: new Map(),
      config: statusLineConfig([["@jpi/directory"]]),
    },
    120,
    widthHelpers,
  );
  assert.deepEqual(atHome.map(plain), [" ~"]);

  const withoutCwd = renderFooter(
    {
      modelName: "Model",
      homeDirectory: "/Users/tester",
      repository: {},
      statuses: new Map(),
      config: statusLineConfig([["@jpi/directory"]]),
    },
    120,
    widthHelpers,
  );
  assert.deepEqual(withoutCwd, []);
});

test("footer stats seed session name, tokens, cost, and turn count (completed agent-loop turns) from branch replay", () => {
  const stats = new FooterStats();
  stats.onSessionStart({
    sessionManager: {
      getSessionName: () => "Resumed session",
      getBranch: () => [
        { type: "message", message: { role: "user", content: "hi" } },
        {
          type: "message",
          message: {
            role: "assistant",
            usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, cost: { total: 1.5 } },
          },
        },
        { type: "message", message: { role: "user", content: "again" } },
        {
          type: "message",
          message: { role: "assistant", stopReason: "aborted", usage: { input: 999, output: 999 } },
        },
        {
          type: "message",
          message: { role: "assistant", usage: { input: 20, output: 10, cost: { total: 2.25 } } },
        },
        // A trailing user message with no assistant reply yet: three user
        // turns but only two completed (non-error, non-aborted) assistant ones.
        { type: "message", message: { role: "user", content: "pending" } },
      ],
    },
  });

  const snapshot = stats.snapshot();
  assert.equal(snapshot.sessionName, "Resumed session");
  assert.equal(snapshot.turnCount, 2);
  assert.equal(snapshot.tokensIn, 120);
  assert.equal(snapshot.tokensOut, 60);
  assert.equal(snapshot.cacheRead, 10);
  assert.equal(snapshot.cacheWrite, 5);
  assert.equal(snapshot.cost, 3.75);
});

test("footer stats default the session name to null and follow session_info_changed", () => {
  const stats = new FooterStats();
  stats.onSessionStart({});
  assert.equal(stats.snapshot().sessionName, null);
  stats.onSessionInfoChanged({ name: "Renamed" });
  assert.equal(stats.snapshot().sessionName, "Renamed");
  stats.onSessionInfoChanged({});
  assert.equal(stats.snapshot().sessionName, null);
});

test("footer stats accumulate tokens and cost live, skipping error and aborted messages", () => {
  const stats = new FooterStats();
  stats.onSessionStart({});

  stats.onMessageEnd({
    message: { role: "assistant", usage: { input: 10, output: 5, cost: { total: 0.5 } } },
  });
  stats.onMessageEnd({
    message: { role: "assistant", stopReason: "error", usage: { input: 999, output: 999 } },
  });
  stats.onMessageEnd({
    message: { role: "assistant", usage: { input: 20, output: 8, cost: { total: 0.25 } } },
  });
  stats.onMessageEnd({ message: { role: "user" } });

  const snapshot = stats.snapshot();
  assert.equal(snapshot.tokensIn, 30);
  assert.equal(snapshot.tokensOut, 13);
  assert.equal(snapshot.cost, 0.75);
});

test("footer stats turn count increments once per turn_end, including consecutive single-turn agent runs", () => {
  const stats = new FooterStats();
  stats.onSessionStart({
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user" } },
        { type: "message", message: { role: "assistant" } },
      ],
    },
  });
  assert.equal(stats.snapshot().turnCount, 1);

  // Two separate single-turn agent runs (simple Q&A) both end at turnIndex 0,
  // but each is still one more completed turn.
  stats.onTurnEnd();
  assert.equal(stats.snapshot().turnCount, 2);
  stats.onTurnEnd();
  assert.equal(stats.snapshot().turnCount, 3);

  // A multi-turn run (tool use) accumulates one per turn_end within the run.
  stats.onTurnEnd();
  stats.onTurnEnd();
  assert.equal(stats.snapshot().turnCount, 5);
});

test("footer stats track the active tool and clear it on completion or turn end", () => {
  const stats = new FooterStats();
  stats.onSessionStart({});
  assert.equal(stats.snapshot().activeToolName, null);

  stats.onToolExecutionStart({ toolName: "Bash" });
  assert.equal(stats.snapshot().activeToolName, "Bash");
  stats.onToolExecutionEnd();
  assert.equal(stats.snapshot().activeToolName, null);

  stats.onToolExecutionStart({ toolName: "Read" });
  assert.equal(stats.snapshot().activeToolName, "Read");
  stats.onTurnEnd();
  assert.equal(stats.snapshot().activeToolName, null);
});

test("footer stats sample generation speed over a rolling window and clear it at message boundaries", () => {
  let now = 0;
  const stats = new FooterStats(() => now);
  stats.onSessionStart({});

  stats.onMessageStart({ message: { role: "assistant" } });
  assert.equal(stats.snapshot().liveSpeed, null);

  stats.onMessageUpdate({ message: { role: "assistant", usage: { output: 10 } } });
  assert.equal(stats.snapshot().liveSpeed, null);

  now = 500;
  stats.onMessageUpdate({ message: { role: "assistant", usage: { output: 60 } } });
  assert.equal(stats.snapshot().liveSpeed, 100);

  now = 1200;
  stats.onMessageUpdate({
    message: { role: "assistant", usage: { output: 0 }, content: "0123456789012345" },
  });
  // The content.length/4 fallback (4 tokens) is below the oldest sample, so
  // no new estimate replaces the last real one.
  assert.equal(stats.snapshot().liveSpeed, 100);

  stats.onMessageEnd({ message: { role: "assistant", usage: { input: 1, output: 60 } } });
  assert.equal(stats.snapshot().liveSpeed, null);
});

async function fleetFooterHarness(events: ReturnType<typeof fakeEventBus>) {
  const env = await tempEnv();
  const config = statusConfig(env);
  await writeFile(
    config.path,
    ["status {", "  format {", '    row "@jpi/model"', "  }", "}"].join("\n"),
    "utf8",
  );

  let footerFactory: FooterFactory | undefined;
  const { value: initialValue } = await config.load();
  const extension = createStatusExtension(
    async () => ({ ...ok(), code: 1 }),
    widthHelpers,
    inertScheduler,
    config,
    initialValue,
    events,
  );
  const context: FooterContext = {
    mode: "tui",
    cwd: "/repo",
    model: { name: "Test model" },
    getContextUsage: () => undefined,
    ui: {
      setFooter(value) {
        footerFactory = value;
      },
      notify() {},
    },
  };

  await extension.onSessionStart({}, context);
  assert.ok(footerFactory);
  return footerFactory;
}

test("jpi-subagents fleet lines render below the status rows, with width and theme passed through", async () => {
  const events = fakeEventBus();
  const footerFactory = await fleetFooterHarness(events);
  const theme = { name: "dark-theme" };
  const component = footerFactory({ requestRender() {} }, theme, {
    getExtensionStatuses: () => new Map(),
    onBranchChange: () => () => {},
  });

  assert.ok(
    events.emitted.some(({ channel }) => channel === FLEET_CONSUMER_READY_CHANNEL),
    "announces consumer readiness once the footer is installed",
  );

  let received: { width: number; theme: unknown } | undefined;
  const providerPayload: FleetProviderPayload = {
    schema: "subagents.fleet.provider.v1",
    render(width, receivedTheme) {
      received = { width, theme: receivedTheme };
      return ["fleet row"];
    },
    attach: () => () => {},
  };
  events.emit(FLEET_PROVIDER_CHANNEL, providerPayload);

  assert.deepEqual(component.render(80).map(plain), [" Test model", "fleet row"]);
  assert.deepEqual(received, { width: 80, theme });
  component.dispose();
});

test("the fleet consumer exposes the footer TUI's current focused component", async () => {
  const events = fakeEventBus();
  const footerFactory = await fleetFooterHarness(events);
  const promptEditor = { name: "prompt-editor" };
  const selector = { name: "selector" };
  let focusedComponent: unknown = promptEditor;
  const tui = {
    requestRender() {},
    getFocusedComponent: () => focusedComponent,
  };
  const component = footerFactory(
    tui,
    {},
    {
      getExtensionStatuses: () => new Map(),
      onBranchChange: () => () => {},
    },
  );

  let attachedConsumer: FleetConsumer | undefined;
  events.emit(FLEET_PROVIDER_CHANNEL, {
    schema: "subagents.fleet.provider.v1",
    render: () => [],
    attach(consumer) {
      attachedConsumer = consumer;
      return () => {};
    },
  } satisfies FleetProviderPayload);

  assert.equal(attachedConsumer?.getFocusedComponent?.(), promptEditor);
  focusedComponent = selector;
  assert.equal(attachedConsumer?.getFocusedComponent?.(), selector);
  component.dispose();
});

test("with no fleet provider attached, the footer renders exactly as it did before", async () => {
  const footerFactory = await fleetFooterHarness(fakeEventBus());
  const component = footerFactory(
    { requestRender() {} },
    {},
    { getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} },
  );

  assert.deepEqual(component.render(80).map(plain), [" Test model"]);
  component.dispose();
});

test("a throwing fleet provider costs only its own rows, not the footer", async () => {
  const events = fakeEventBus();
  const footerFactory = await fleetFooterHarness(events);
  const component = footerFactory(
    { requestRender() {} },
    {},
    { getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} },
  );

  events.emit(FLEET_PROVIDER_CHANNEL, {
    schema: "subagents.fleet.provider.v1",
    render: () => {
      throw new Error("boom");
    },
    attach: () => () => {},
  } satisfies FleetProviderPayload);

  assert.deepEqual(component.render(80).map(plain), [" Test model"]);
  component.dispose();
});

test("disposing the footer detaches the fleet provider and unsubscribes", async () => {
  const events = fakeEventBus();
  const footerFactory = await fleetFooterHarness(events);
  const component = footerFactory(
    { requestRender() {} },
    {},
    { getExtensionStatuses: () => new Map(), onBranchChange: () => () => {} },
  );

  let detached = false;
  events.emit(FLEET_PROVIDER_CHANNEL, {
    schema: "subagents.fleet.provider.v1",
    render: () => ["fleet row"],
    attach: () => () => {
      detached = true;
    },
  } satisfies FleetProviderPayload);
  assert.equal(events.listenerCount(FLEET_PROVIDER_CHANNEL), 1);

  component.dispose();
  assert.equal(detached, true);
  assert.equal(events.listenerCount(FLEET_PROVIDER_CHANNEL), 0);
});
