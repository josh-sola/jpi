import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { isRecord, truncateMiddle } from "../../src/core/index.ts";
import type { TranscriptEntryLike } from "../../src/pi/index.ts";

/** The real return type of ModelRegistry.find, derived rather than duplicated. */
export type PiModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

const MAX_TRANSCRIPT_MESSAGE_CHARS = 1_000;
const MAX_TRANSCRIPT_CHARS = 8_000;
const MAX_SUGGESTION_WORDS = 12;
const MAX_SUGGESTION_TOKENS = 64;

const ASSISTANT_VOICE_PREFIXES = ["let me", "i'll", "i will", "here's", "here is"];

export const SUGGESTION_SYSTEM_PROMPT = `You predict the coding agent user's likely next prompt.

FIRST: Look at the user's recent messages and original request. Your job is to predict what THEY would type - not what you think they should do.

THE TEST: Would they think "I was just about to type that"?

EXAMPLES:
- User asked "fix the bug and run tests", bug is fixed -> "run the tests"
- After code written -> "try it out"
- Agent offers options -> suggest the one the user would likely pick, based on conversation
- Agent asks to continue -> "yes" or "go ahead"
- Task complete, obvious follow-up -> "commit this" or "push it"
- After error or misunderstanding -> silence (let them assess/correct)

Be specific: "run the tests" beats "continue".

NEVER SUGGEST:
- Evaluative ("looks good", "thanks")
- Questions ("what about...?")
- Assistant-voice ("Let me...", "I'll...", "Here's...")
- New ideas they didn't ask about
- Multiple sentences

Stay silent if the next step isn't obvious from what the user said.

Stay silent if a suggestion could be unsafe or inappropriate - including any sensitive topic (security incidents, credentials, harm, private data). Even when the user is doing legitimate security work, do not predict potentially unsafe actions.

Format: 2-12 words, match the user's style. Or nothing.

Reply with ONLY the suggestion, no quotes or explanation.`;

export function parseModel(spec: string): { provider: string; modelId: string } | undefined {
  const raw = spec.trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;

  const provider = raw.slice(0, slash).trim();
  const modelId = raw.slice(slash + 1).trim();
  if (!provider || !modelId) return undefined;

  return { provider, modelId };
}

// Shared by user and assistant messages: keeping only "text" parts is what
// strips tool-use and thinking blocks out of the transcript.
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => (part as { text: string }).text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

interface TranscriptItem {
  role: "user" | "assistant";
  text: string;
}

function formatTranscriptItem(item: TranscriptItem): string {
  return `[${item.role}]\n${item.text}`;
}

/** Entries come oldest-first from the session branch; output keeps that order, newest last. */
export function renderTranscript(entries: readonly TranscriptEntryLike[]): string {
  const items: TranscriptItem[] = [];

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const { role } = entry.message;
    if (role !== "user" && role !== "assistant") continue;

    const text = truncateMiddle(
      extractMessageText(entry.message.content),
      MAX_TRANSCRIPT_MESSAGE_CHARS,
      "\n[…]\n",
    );
    if (text) items.push({ role, text });
  }

  if (items.length === 0) return "";

  // Keep the most recent content: drop oldest items first when over budget.
  let totalChars = items.reduce((sum, item) => sum + item.text.length, 0);
  let start = 0;
  while (totalChars > MAX_TRANSCRIPT_CHARS && start < items.length - 1) {
    totalChars -= items[start]!.text.length;
    start++;
  }

  return items.slice(start).map(formatTranscriptItem).join("\n\n");
}

/** Returns undefined when there is nothing worth showing as a ghost. */
export function sanitizeSuggestion(raw: string): string | undefined {
  let text = raw.trim();
  if (!text) return undefined;

  const quoteChars = new Set(['"', "'", "`"]);
  if (text.length >= 2 && text[0] === text[text.length - 1] && quoteChars.has(text[0]!)) {
    text = text.slice(1, -1).trim();
  }
  if (!text) return undefined;

  text =
    text
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "";
  if (!text) return undefined;

  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount === 0 || wordCount > MAX_SUGGESTION_WORDS) return undefined;

  const lower = text.toLowerCase();
  if (ASSISTANT_VOICE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return undefined;

  return text;
}

export interface GenerateSuggestionDeps {
  model: PiModel;
  transcriptEntries: readonly TranscriptEntryLike[];
  timeoutMs: number;
  sessionId?: string;
  modelRegistry: {
    complete(
      model: PiModel,
      context: unknown,
      options?: Record<string, unknown>,
    ): Promise<AssistantMessage>;
  };
}

function getResponseText(response: AssistantMessage): string {
  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/** Never throws: any failure, abort, or non-"stop" completion means no suggestion. */
export async function generateSuggestion(
  deps: GenerateSuggestionDeps,
  signal: AbortSignal,
): Promise<string | undefined> {
  const transcript = renderTranscript(deps.transcriptEntries);
  if (!transcript) return undefined;

  let response: AssistantMessage;
  try {
    response = await deps.modelRegistry.complete(
      deps.model,
      {
        systemPrompt: SUGGESTION_SYSTEM_PROMPT,
        messages: [
          { role: "user", content: [{ type: "text", text: transcript }], timestamp: Date.now() },
        ],
      },
      {
        maxTokens: MAX_SUGGESTION_TOKENS,
        reasoningEffort: "minimal",
        cacheRetention: "short",
        sessionId: deps.sessionId,
        signal,
        timeoutMs: deps.timeoutMs,
      },
    );
  } catch {
    return undefined;
  }

  if (signal.aborted || response.stopReason !== "stop") return undefined;

  return sanitizeSuggestion(getResponseText(response));
}
