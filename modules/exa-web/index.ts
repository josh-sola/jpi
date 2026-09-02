import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isRecord } from "../../src/core/index.ts";
import {
  createFocusedWebFetchTool,
  executeFocusedWebFetch,
  type FetchedPage,
  type FocusedWebFetchToolOptions,
  type WebFetchContext,
  type WebFetchDetails,
  type WebFetchInput,
} from "../web/focused-fetch.ts";
import {
  createWebSearchResult,
  createWebSearchToolDefinition,
  type WebSearchDetails,
  type WebSearchInput,
  type WebSearchResult,
} from "../web/search.ts";
import { boundedText } from "../web/text.ts";
import { createExaClient, type ExaClient } from "./exa.ts";

const MAX_SEARCH_URL_CHARS = 8_192;
const MAX_SEARCH_TITLE_CHARS = 500;
const MAX_SEARCH_DESCRIPTION_CHARS = 1_000;
const MAX_FETCH_TITLE_CHARS = 500;

export type ExaWebExtensionOptions = {
  client?: ExaClient;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
} & Partial<Pick<FocusedWebFetchToolOptions, "createSessionId" | "now">>;

function normalizeSearchUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const normalized = url.toString();
    return normalized.length <= MAX_SEARCH_URL_CHARS ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function searchDescription(value: Record<string, unknown>): string {
  const summary = boundedText(value.summary, MAX_SEARCH_DESCRIPTION_CHARS);
  if (summary) return summary;

  if (Array.isArray(value.highlights)) {
    const highlights = value.highlights
      .filter((highlight): highlight is string => typeof highlight === "string")
      .join(" ");
    const description = boundedText(highlights, MAX_SEARCH_DESCRIPTION_CHARS);
    if (description) return description;
  }

  return boundedText(value.text, MAX_SEARCH_DESCRIPTION_CHARS);
}

function normalizeSearchResult(value: unknown): WebSearchResult | undefined {
  if (!isRecord(value)) return undefined;
  const url = normalizeSearchUrl(value.url);
  if (!url) return undefined;
  return {
    title: boundedText(value.title, MAX_SEARCH_TITLE_CHARS),
    url,
    description: searchDescription(value),
  };
}

export async function executeExaSearch(
  input: WebSearchInput,
  client: ExaClient,
  signal?: AbortSignal,
): Promise<AgentToolResult<WebSearchDetails>> {
  const raw = await client.search(input.query, signal);
  if (!isRecord(raw) || !Array.isArray(raw.results)) {
    throw new Error("Exa returned malformed search response.");
  }

  const results = raw.results
    .map(normalizeSearchResult)
    .filter((result): result is WebSearchResult => Boolean(result))
    .slice(0, 5);
  return createWebSearchResult(input.query, results);
}

function statusEntries(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return Object.values(value);
  return value === undefined ? undefined : [];
}

function statusFailure(value: unknown): string | undefined {
  if (typeof value === "string") {
    const tag = value.toLowerCase();
    return tag === "error" || tag === "failed" || tag === "failure" ? tag : undefined;
  }
  if (!isRecord(value)) return undefined;
  const status = typeof value.status === "string" ? value.status.toLowerCase() : "";
  const tag = typeof value.tag === "string" ? value.tag.toLowerCase() : "";
  const failed =
    status === "error" ||
    status === "failed" ||
    status === "failure" ||
    tag === "error" ||
    tag === "failed" ||
    tag === "failure" ||
    (typeof value.status === "number" && value.status >= 400);
  if (!failed) return undefined;

  if (typeof value.error === "string") {
    return boundedText(value.error, MAX_SEARCH_DESCRIPTION_CHARS) || "an unknown per-URL error";
  }
  if (isRecord(value.error)) {
    const errorTag = typeof value.error.tag === "string" ? value.error.tag : "";
    const statusCode =
      typeof value.error.httpStatusCode === "number" ? String(value.error.httpStatusCode) : "";
    const detail = [errorTag, statusCode && `HTTP ${statusCode}`].filter(Boolean).join(" ");
    if (detail) return boundedText(detail, MAX_SEARCH_DESCRIPTION_CHARS);
  }

  return (
    boundedText(value.message, MAX_SEARCH_DESCRIPTION_CHARS) ||
    status ||
    tag ||
    "an unknown per-URL error"
  );
}

function normalizeFetchedUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    const normalized = url.toString();
    return normalized.length <= MAX_SEARCH_URL_CHARS ? normalized : undefined;
  } catch {
    return undefined;
  }
}

export function parseExaContents(raw: unknown, requestedUrl: string): FetchedPage {
  if (!isRecord(raw)) throw new Error("Exa returned malformed contents response.");

  const statuses = statusEntries(raw.statuses);
  if (statuses !== undefined) {
    for (const status of statuses) {
      const failure = statusFailure(status);
      if (failure) throw new Error(`Exa could not fetch the page: ${failure}.`);
    }
  }

  if (!Array.isArray(raw.results)) throw new Error("Exa returned malformed contents response.");
  const pages = raw.results
    .filter(isRecord)
    .map((result) => {
      const text = typeof result.text === "string" ? result.text : "";
      return {
        result,
        text,
        url: normalizeFetchedUrl(result.url),
      };
    })
    .filter((page) => page.text.trim() !== "" && page.url !== undefined);
  const page = pages.find((candidate) => candidate.url === requestedUrl) ?? pages[0];
  if (!page || !page.url) throw new Error("Exa returned no readable page text.");

  return {
    url: requestedUrl,
    ...(page.url !== requestedUrl ? { fetchedUrl: page.url } : {}),
    title: boundedText(page.result.title, MAX_FETCH_TITLE_CHARS),
    markdown: page.text,
  };
}

export async function executeExaFetch(
  input: WebFetchInput,
  ctx: WebFetchContext,
  client: ExaClient,
  options: Partial<Pick<FocusedWebFetchToolOptions, "createSessionId" | "now">> = {},
  signal?: AbortSignal,
): Promise<AgentToolResult<WebFetchDetails>> {
  return executeFocusedWebFetch(
    input,
    ctx,
    {
      fetchPage: async (requestedUrl, requestSignal) =>
        parseExaContents(await client.contents(requestedUrl, requestSignal), requestedUrl),
      ...options,
    },
    signal,
  );
}

export function registerExaWebTools(pi: ExtensionAPI, options: ExaWebExtensionOptions = {}) {
  const client =
    options.client ??
    createExaClient({
      apiKey: options.apiKey ?? "",
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    });

  pi.registerTool(
    createWebSearchToolDefinition({
      description: "Search the web with Exa and return up to five compact web results.",
      execute(input, signal) {
        return executeExaSearch(input, client, signal);
      },
    }),
  );
  pi.registerTool(
    createFocusedWebFetchTool({
      description:
        "Fetch one known HTTP or HTTPS URL with Exa and answer a focused question from the page.",
      fetchPage: async (requestedUrl, signal) =>
        parseExaContents(await client.contents(requestedUrl, signal), requestedUrl),
      ...(options.createSessionId ? { createSessionId: options.createSessionId } : {}),
      ...(options.now ? { now: options.now } : {}),
    }),
  );
}

export function resolveExaApiKey(
  configValue: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = configValue.trim() || env.EXA_API_KEY?.trim() || "";
  if (!key) {
    throw new Error("exa-web needs an API key. Set exa-web.api-key in jpi.kdl or EXA_API_KEY.");
  }
  return key;
}
