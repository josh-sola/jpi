import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

import { isRecord } from "../../src/core/index.ts";
import {
  createFocusedWebFetchTool,
  executeFocusedWebFetch,
  normalizeFetchUrl,
  type FetchedPage,
  type FocusedWebFetchToolOptions,
  type WebFetchContext,
  type WebFetchDetails,
  type WebFetchInput,
} from "./focused-fetch.ts";
import type { KetchRunner } from "./ketch.ts";
import { boundedText } from "./text.ts";

const WEB_FETCH_TIMEOUT_MS = 60_000;
const MAX_FETCH_TITLE_CHARS = 500;

export {
  normalizeFetchUrl,
  webFetchParameters,
  type WebFetchDetails,
  type WebFetchInput,
} from "./focused-fetch.ts";

export type WebFetchToolOptions = {
  runner: KetchRunner;
} & Partial<Pick<FocusedWebFetchToolOptions, "createSessionId" | "now">>;

function normalizeKetchUrl(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`Ketch returned malformed page output: ${label} must be a URL string.`);
  }
  return normalizeFetchUrl(value);
}

export function parseFetchedPage(rawPage: unknown): FetchedPage {
  if (!isRecord(rawPage)) throw new Error("Ketch returned malformed page output.");

  const url = normalizeKetchUrl(rawPage.url, "url");
  if (!url) throw new Error("Ketch returned malformed page output: url is missing.");

  const fetchedUrl = normalizeKetchUrl(rawPage.fetched_url, "fetched_url");
  const markdown = typeof rawPage.markdown === "string" ? rawPage.markdown : "";
  if (!markdown.trim()) throw new Error("Ketch returned no readable page text.");

  return {
    url,
    ...(fetchedUrl !== undefined && { fetchedUrl }),
    title: boundedText(rawPage.title, MAX_FETCH_TITLE_CHARS),
    markdown,
  };
}

function ketchFetchPage(runner: KetchRunner, requestedUrl: string, signal?: AbortSignal) {
  return runner
    .runJson(["scrape", requestedUrl, "--json", "--no-llms-txt", "--max-chars", "40000"], {
      timeoutMs: WEB_FETCH_TIMEOUT_MS,
      ...(signal !== undefined && { signal }),
    })
    .then(parseFetchedPage);
}

export async function executeWebFetch(
  input: WebFetchInput,
  ctx: WebFetchContext,
  options: WebFetchToolOptions,
  signal?: AbortSignal,
): Promise<AgentToolResult<WebFetchDetails>> {
  return executeFocusedWebFetch(
    input,
    ctx,
    {
      fetchPage(requestedUrl, requestSignal) {
        return ketchFetchPage(options.runner, requestedUrl, requestSignal);
      },
      ...(options.createSessionId ? { createSessionId: options.createSessionId } : {}),
      ...(options.now ? { now: options.now } : {}),
    },
    signal,
  );
}

export function createWebFetchTool(options: WebFetchToolOptions) {
  return createFocusedWebFetchTool({
    description:
      "Fetch one known HTTP or HTTPS URL with ketch and answer a focused question from the page.",
    fetchPage(requestedUrl, signal) {
      return ketchFetchPage(options.runner, requestedUrl, signal);
    },
    ...(options.createSessionId ? { createSessionId: options.createSessionId } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
