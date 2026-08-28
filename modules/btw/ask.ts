import type { AssistantMessage, Context, Message, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";

import { errorMessage } from "../../src/core/index.ts";

/** The real return type of ModelRegistry.find, derived rather than duplicated. */
export type PiModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

export interface BtwExchange {
  readonly question: string;
  readonly answer: string;
}

export function parseModel(spec: string): { provider: string; modelId: string } | undefined {
  const raw = spec.trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;

  const provider = raw.slice(0, slash).trim();
  const modelId = raw.slice(slash + 1).trim();
  if (!provider || !modelId) return undefined;

  return { provider, modelId };
}

/** The configured model when it parses and its provider has auth, else the session's model. */
export function resolveAskModel(
  modelRegistry: Pick<ModelRegistry, "find" | "hasConfiguredAuth">,
  configModel: string,
  sessionModel: PiModel | undefined,
): PiModel | undefined {
  const parsed = parseModel(configModel);
  const model = parsed && modelRegistry.find(parsed.provider, parsed.modelId);
  if (model && modelRegistry.hasConfiguredAuth(model)) return model;
  return sessionModel;
}

/** Appends `exchange`, dropping the oldest entries once over `maxExchanges`. */
export function pushExchange(
  ring: readonly BtwExchange[],
  exchange: BtwExchange,
  maxExchanges: number,
): BtwExchange[] {
  const next = [...ring, exchange];
  return next.length > maxExchanges ? next.slice(next.length - maxExchanges) : next;
}

const BTW_REMINDER = [
  "<system-reminder>",
  "This is a one-off side question asked outside the normal conversation turn.",
  "You have no tools here and cannot take any action. Answer briefly, using only",
  "the context above — this exchange will not become part of the conversation.",
  "</system-reminder>",
].join("\n");

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/** A prior btw answer replayed as an assistant turn, so the model sees it as its own past reply. */
function assistantMessage(model: PiModel, text: string): Message {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: ZERO_USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

export interface BuildBtwContextParams {
  readonly systemPrompt: string;
  readonly sessionEntries: readonly SessionEntry[];
  readonly priorExchanges: readonly BtwExchange[];
  readonly question: string;
  readonly model: PiModel;
}

/**
 * Mirrors the main turn's own entry-to-wire conversion (`convertToLlm` +
 * `sessionEntryToContextMessages`, the same pair the agent loop uses) so the
 * system prompt and transcript prefix are byte-identical and can cache-hit.
 */
export function buildBtwContext(params: BuildBtwContextParams): Context {
  const transcript = convertToLlm(params.sessionEntries.flatMap(sessionEntryToContextMessages));
  const replay = params.priorExchanges.flatMap((exchange) => [
    userMessage(exchange.question),
    assistantMessage(params.model, exchange.answer),
  ]);
  const final = userMessage(`${BTW_REMINDER}\n\n${params.question}`);

  return {
    systemPrompt: params.systemPrompt,
    messages: [...transcript, ...replay, final],
  };
}

export interface AskBtwDeps extends BuildBtwContextParams {
  readonly sessionId: string;
  readonly timeoutMs: number;
  readonly modelRegistry: {
    complete(
      model: PiModel,
      context: unknown,
      options?: Record<string, unknown>,
    ): Promise<AssistantMessage>;
  };
}

export type AskBtwResult = { answer: string } | { error: string };

function responseText(response: AssistantMessage): string {
  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Never throws: any failure, abort, or non-"stop" completion comes back as `{ error }`. */
export async function askBtw(deps: AskBtwDeps, signal: AbortSignal): Promise<AskBtwResult> {
  try {
    const context = buildBtwContext(deps);
    const response = await deps.modelRegistry.complete(deps.model, context, {
      cacheRetention: "short",
      sessionId: deps.sessionId,
      signal,
      timeoutMs: deps.timeoutMs,
    });

    if (signal.aborted) return { error: "aborted" };
    if (response.stopReason !== "stop") {
      return { error: response.errorMessage ?? `model stopped early (${response.stopReason})` };
    }

    const answer = responseText(response);
    return answer ? { answer } : { error: "empty response" };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}
