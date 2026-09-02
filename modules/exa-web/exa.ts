import { isRecord } from "../../src/core/index.ts";
import { boundedText } from "../web/text.ts";

const EXA_BASE_URL = "https://api.exa.ai";
const SEARCH_TIMEOUT_MS = 30_000;
const CONTENTS_TIMEOUT_MS = 60_000;
const MAX_EXA_ERROR_CHARS = 2_000;

export type ExaClient = {
  search(query: string, signal?: AbortSignal): Promise<unknown>;
  contents(url: string, signal?: AbortSignal): Promise<unknown>;
};

export type CreateExaClientOptions = {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
};

function redact(value: string, apiKey: string): string {
  return apiKey ? value.split(apiKey).join("[redacted]") : value;
}

function boundedApiError(value: string, apiKey: string): string {
  return boundedText(redact(value, apiKey), MAX_EXA_ERROR_CHARS);
}

function requestCancelled(): Error {
  return new Error("The web request was cancelled.");
}

function requestTimedOut(timeoutMs: number): Error {
  return new Error(`Exa request timed out after ${timeoutMs / 1_000} seconds.`);
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Exa base URL must be a valid HTTP or HTTPS URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Exa base URL must be a valid HTTP or HTTPS URL.");
  }
  if (url.username || url.password) {
    throw new Error("Exa base URL must not include credentials.");
  }
  return url;
}

function apiErrorMessage(body: string, apiKey: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (typeof error === "string") return boundedApiError(error, apiKey);
      if (isRecord(error) && typeof error.message === "string") {
        return boundedApiError(error.message, apiKey);
      }
      if (typeof parsed.message === "string") return boundedApiError(parsed.message, apiKey);
    }
  } catch {
    return boundedApiError(trimmed, apiKey);
  }

  return boundedApiError(trimmed, apiKey);
}

function parseJson(body: string): unknown {
  if (!body.trim()) throw new Error("Exa returned an empty response.");
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Exa returned malformed JSON.");
  }
}

type RequestLifecycle = {
  race<T>(operation: Promise<T>): Promise<T>;
  stateError(): Error | undefined;
  cleanup(): void;
  signal: AbortSignal;
};

function createRequestLifecycle(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): RequestLifecycle {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let rejectAbort: (error: Error) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const rejectOnAbort = () => {
    rejectAbort(signal?.aborted ? requestCancelled() : requestTimedOut(timeoutMs));
  };
  controller.signal.addEventListener("abort", rejectOnAbort, { once: true });

  return {
    race<T>(operation: Promise<T>): Promise<T> {
      return Promise.race([operation, abortPromise]);
    },
    stateError(): Error | undefined {
      if (signal?.aborted) return requestCancelled();
      if (timedOut) return requestTimedOut(timeoutMs);
      return undefined;
    },
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
      controller.signal.removeEventListener("abort", rejectOnAbort);
    },
    signal: controller.signal,
  };
}

async function requestJson(
  fetchFn: typeof globalThis.fetch,
  baseUrl: URL,
  apiKey: string,
  path: string,
  body: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw requestCancelled();

  const lifecycle = createRequestLifecycle(signal, timeoutMs);
  try {
    let response: Response;
    try {
      response = await lifecycle.race(
        fetchFn(new URL(path, baseUrl), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: lifecycle.signal,
        }),
      );
    } catch {
      throw lifecycle.stateError() ?? new Error("Exa request failed. Try again later.");
    }

    let responseBody: string;
    try {
      responseBody = await lifecycle.race(response.text());
    } catch {
      throw lifecycle.stateError() ?? new Error("Exa returned an unreadable response.");
    }

    if (!response.ok) {
      const message = apiErrorMessage(responseBody, apiKey);
      throw new Error(
        `Exa request failed (HTTP ${response.status})${message ? `: ${message}` : ""}.`,
      );
    }

    return parseJson(responseBody);
  } finally {
    lifecycle.cleanup();
  }
}

export function createExaClient(options: CreateExaClientOptions): ExaClient {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new Error("exa-web needs an Exa API key before it can register tools.");

  const baseUrl = parseBaseUrl(options.baseUrl ?? EXA_BASE_URL);
  const fetchFn = options.fetch ?? globalThis.fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("The runtime does not provide fetch for Exa requests.");
  }

  return {
    search(query, signal) {
      return requestJson(
        fetchFn,
        baseUrl,
        apiKey,
        "/search",
        {
          query,
          numResults: 5,
          type: "auto",
          contents: { highlights: { maxCharacters: 1_000 } },
        },
        SEARCH_TIMEOUT_MS,
        signal,
      );
    },
    contents(url, signal) {
      return requestJson(
        fetchFn,
        baseUrl,
        apiKey,
        "/contents",
        { urls: [url], text: { maxCharacters: 40_000 }, maxAgeHours: 0 },
        CONTENTS_TIMEOUT_MS,
        signal,
      );
    },
  };
}
