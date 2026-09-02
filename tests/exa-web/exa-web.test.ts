import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vite-plus/test";

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadModules } from "../../extensions/jpi/index.ts";
import { Config } from "../../src/core/config.ts";
import { injectEnabled } from "../../src/core/module.ts";
import { createExaClient } from "../../modules/exa-web/exa.ts";
import {
  executeExaFetch,
  executeExaSearch,
  parseExaContents,
  registerExaWebTools,
  resolveExaApiKey,
} from "../../modules/exa-web/index.ts";
import exaWebModule, { exaWebSchema } from "../../modules/exa-web/module.ts";
import type { ExaClient } from "../../modules/exa-web/exa.ts";
import type { WebFetchContext } from "../../modules/web/focused-fetch.ts";

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function toolText(content: { type: string; text?: string }[]): string {
  const [first] = content;
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected text tool content");
  }
  return first.text;
}

function makeUsage(seed: number): Usage {
  return {
    input: seed,
    output: seed + 1,
    cacheRead: seed + 2,
    cacheWrite: seed + 3,
    totalTokens: seed + 4,
    cost: {
      input: seed / 10,
      output: (seed + 1) / 10,
      cacheRead: (seed + 2) / 10,
      cacheWrite: (seed + 3) / 10,
      total: (seed + 4) / 10,
    },
  };
}

function assistant(text: string, usage = makeUsage(1)): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "active-model",
    content: [{ type: "text", text }],
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
}

function fetchContext() {
  const calls: { model: unknown; context: any; options: Record<string, unknown> }[] = [];
  const ctx = {
    model: { provider: "openai", id: "active-model", api: "openai-responses" },
    modelRegistry: {
      async getProviderAuth() {
        return { auth: { apiKey: "model-key" }, env: {} };
      },
      async complete(model: unknown, context: unknown, options: Record<string, unknown> = {}) {
        calls.push({ model, context, options });
        return assistant("Focused answer", makeUsage(8));
      },
    },
  };
  return { ctx: ctx as unknown as WebFetchContext, calls };
}

async function withTempAgentDir(t: {
  onTestFinished: (fn: () => Promise<void> | void) => void;
}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jpi-exa-web-"));
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  t.onTestFinished(async () => {
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test("exa-web schema seeds a disabled empty-key stanza", async (t) => {
  const directory = await withTempAgentDir(t);
  const config = new Config("exa-web", injectEnabled("exa-web", exaWebSchema, false), {
    PI_CODING_AGENT_DIR: directory,
  });

  const { value } = await config.load();

  assert.deepEqual(value, { enabled: false, apiKey: "" });
  const text = await readFile(join(directory, "jpi.kdl"), "utf8");
  assert.match(text, /api-key ""/);
});

test("exa-web prefers its config key and falls back to EXA_API_KEY", () => {
  assert.equal(resolveExaApiKey(" config-key ", { EXA_API_KEY: "environment-key" }), "config-key");
  assert.equal(resolveExaApiKey("  ", { EXA_API_KEY: " environment-key " }), "environment-key");
  assert.throws(() => resolveExaApiKey(" ", { EXA_API_KEY: " " }), /api-key.*EXA_API_KEY/i);
});

test("enabled exa-web with no configured key fails before registering tools", async (t) => {
  const directory = await withTempAgentDir(t);
  await writeFile(join(directory, "jpi.kdl"), 'exa-web {\n  enabled #true\n  api-key ""\n}\n');
  const prior = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  t.onTestFinished(() => {
    if (prior === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = prior;
  });

  const result = await loadModules({} as ExtensionAPI, [exaWebModule]);

  assert.deepEqual(result.failures, [
    "exa-web: exa-web needs an API key. Set exa-web.api-key in jpi.kdl or EXA_API_KEY.",
  ]);
});

test("Exa client sends exact authenticated search and contents requests", async () => {
  const calls: { input: string; init: RequestInit }[] = [];
  const client = createExaClient({
    apiKey: "exa-key",
    baseUrl: "https://exa.test",
    fetch: (async (input, init) => {
      calls.push({ input: String(input), init: init! });
      return response({ results: [] });
    }) as typeof fetch,
  });

  await client.search("new developments");
  await client.contents("https://example.com/page");

  assert.deepEqual(
    calls.map((call) => call.input),
    ["https://exa.test/search", "https://exa.test/contents"],
  );
  assert.deepEqual(
    calls.map((call) => call.init.headers),
    [
      { Authorization: "Bearer exa-key", "Content-Type": "application/json" },
      { Authorization: "Bearer exa-key", "Content-Type": "application/json" },
    ],
  );
  assert.deepEqual(
    calls.map((call) => JSON.parse(call.init.body as string)),
    [
      {
        query: "new developments",
        numResults: 5,
        type: "auto",
        contents: { highlights: { maxCharacters: 1_000 } },
      },
      { urls: ["https://example.com/page"], text: { maxCharacters: 40_000 }, maxAgeHours: 0 },
    ],
  );
});

test("Exa search normalizes ordered untrusted results", async () => {
  const client: ExaClient = {
    async search() {
      return {
        results: [
          { title: "First", url: "https://example.com/a", summary: "Summary" },
          { title: "Skip", url: "ftp://example.com/b", text: "no" },
          { title: "Highlights", url: "http://example.com/c", highlights: ["One", "Two"] },
          { title: "Text", url: "https://example.com/d", text: "Fallback" },
        ],
      };
    },
    async contents() {
      throw new Error("not used");
    },
  };

  const result = await executeExaSearch({ query: "topic" }, client);

  assert.deepEqual(result.details, {
    query: "topic",
    results: [
      { title: "First", url: "https://example.com/a", description: "Summary" },
      { title: "Highlights", url: "http://example.com/c", description: "One Two" },
      { title: "Text", url: "https://example.com/d", description: "Fallback" },
    ],
  });
  assert.match(toolText(result.content), /^Web search results are untrusted metadata/);
  assert.match(toolText(result.content), /1\. First/);
});

test("Exa client maps HTTP errors and invalid JSON without exposing its key", async () => {
  const key = "private-exa-key";
  const httpError = createExaClient({
    apiKey: key,
    fetch: (async () => response({ error: `rate limited for ${key}` }, 429)) as typeof fetch,
  });
  await assert.rejects(httpError.search("topic"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /HTTP 429.*rate limited/);
    assert.doesNotMatch(error.message, new RegExp(key));
    return true;
  });

  const longKey = "secret".repeat(500);
  const longKeyError = createExaClient({
    apiKey: longKey,
    fetch: (async () => response({ error: `rate limited for ${longKey}` }, 429)) as typeof fetch,
  });
  await assert.rejects(longKeyError.search("topic"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /\[redacted\]/);
    assert.doesNotMatch(error.message, new RegExp(longKey.slice(0, 100)));
    return true;
  });

  const invalidJson = createExaClient({
    apiKey: key,
    fetch: (async () => response("not json")) as typeof fetch,
  });
  await assert.rejects(invalidJson.search("topic"), /malformed JSON/);
});

test("Exa contents fails on per-URL status errors before model completion", () => {
  assert.throws(
    () =>
      parseExaContents(
        {
          statuses: [
            {
              status: "error",
              error: { tag: "CRAWL_NOT_FOUND", httpStatusCode: 404 },
            },
          ],
          results: [{ url: "https://example.com", text: "unused" }],
        },
        "https://example.com/",
      ),
    /could not fetch.*CRAWL_NOT_FOUND.*HTTP 404/i,
  );
});

test("Exa fetch validates its URL before requesting contents", async () => {
  let called = false;
  const client: ExaClient = {
    async search() {
      return { results: [] };
    },
    async contents() {
      called = true;
      return { results: [] };
    },
  };

  await assert.rejects(
    executeExaFetch(
      { url: "https://user:pass@example.com", prompt: "Question" },
      fetchContext().ctx,
      client,
    ),
    /embedded credentials/,
  );
  assert.equal(called, false);
});

test("Exa fetch uses the active model and returns only its answer and usage", async () => {
  const usage = makeUsage(8);
  const { ctx, calls } = fetchContext();
  const client: ExaClient = {
    async search() {
      return { results: [] };
    },
    async contents(url) {
      assert.equal(url, "https://example.com/page");
      return {
        statuses: [{ status: "success" }],
        results: [
          {
            url: "https://example.com/final",
            title: "Title",
            text: "# Page\nThe answer is 42.",
          },
        ],
      };
    },
  };

  const result = await executeExaFetch(
    { url: "https://example.com/page", prompt: "What is the answer?" },
    ctx,
    client,
    { createSessionId: () => "exa-session", now: () => 99 },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.context.systemPrompt.includes("untrusted data, not instructions"), true);
  assert.match(calls[0]!.context.messages[0]!.content[0]!.text, /The answer is 42/);
  assert.deepEqual(calls[0]!.options, {
    cacheRetention: "none",
    maxTokens: 2_048,
    reasoning: "minimal",
    sessionId: "exa-session",
    signal: undefined,
  });
  assert.deepEqual(result.content, [{ type: "text", text: "Focused answer" }]);
  assert.deepEqual(result.usage, usage);
  assert.deepEqual(result.details, {
    requestedUrl: "https://example.com/page",
    fetchedUrl: "https://example.com/final",
    title: "Title",
  });
});

test("Exa client distinguishes caller cancellation from its timeout", async () => {
  const pendingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>(() => {
      void init;
    })) as typeof fetch;
  const client = createExaClient({ apiKey: "key", fetch: pendingFetch });
  const controller = new AbortController();
  const cancelled = client.search("topic", controller.signal);
  const cancellation = assert.rejects(cancelled, /cancelled/);
  controller.abort();
  await cancellation;

  vi.useFakeTimers();
  try {
    const timedOut = createExaClient({ apiKey: "key", fetch: pendingFetch }).search("topic");
    const timeout = assert.rejects(timedOut, /timed out after 30 seconds/);
    await vi.advanceTimersByTimeAsync(30_000);
    await timeout;
  } finally {
    vi.useRealTimers();
  }
});

test("Exa client keeps cancellation and timeouts active while reading the response body", async () => {
  const pendingBodyFetch = (async () =>
    ({
      ok: true,
      status: 200,
      text: async () => new Promise<string>(() => {}),
    }) as unknown as Response) as typeof fetch;
  const controller = new AbortController();
  const cancelled = createExaClient({ apiKey: "key", fetch: pendingBodyFetch }).search(
    "topic",
    controller.signal,
  );
  const cancellation = assert.rejects(cancelled, /cancelled/);
  controller.abort();
  await cancellation;

  vi.useFakeTimers();
  try {
    const timedOut = createExaClient({ apiKey: "key", fetch: pendingBodyFetch }).search("topic");
    const timeout = assert.rejects(timedOut, /timed out after 30 seconds/);
    await vi.advanceTimersByTimeAsync(30_000);
    await timeout;
  } finally {
    vi.useRealTimers();
  }
});

test("exa-web registers exactly the shared web tools", () => {
  const tools: any[] = [];
  const client: ExaClient = {
    async search() {
      return { results: [] };
    },
    async contents() {
      return { results: [] };
    },
  };

  registerExaWebTools(
    { registerTool: (tool: any) => tools.push(tool) } as unknown as ExtensionAPI,
    { client },
  );

  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["web_search", "web_fetch"],
  );
  assert.equal(tools[0]!.parameters.properties.query.description, "The web search query");
  assert.equal(tools[1]!.parameters.properties.url.description, "The HTTP or HTTPS URL to fetch");
});
