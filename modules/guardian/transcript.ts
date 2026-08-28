import { isRecord, truncateMiddle } from "../../src/core/index.ts";

const MAX_TRANSCRIPT_CHARS = 16_000;
const MAX_TRANSCRIPT_MESSAGE_CHARS = 1_200;
// Reserves room for the session's opening messages (task framing, standing
// grants) so a long session's tail-favoring fill can't crowd them out entirely.
const MAX_TRANSCRIPT_HEAD_CHARS = 4_000;
const MAX_JSON_DEPTH = 4;
const MAX_JSON_KEYS = 40;
const MAX_JSON_ITEMS = 20;
const MAX_JSON_STRING = 40_000;
const MAX_TOOL_ARGS_CHARS = 40_000;
// Canonical tool name from @juicesharp/rpiv-ask-user-question. Its
// toolResult details carry both question and answer, so no pairing with
// the originating toolCall is needed.
const QUESTION_TOOL_NAMES = new Set(["ask_user_question"]);

function truncateTranscriptText(value: string): string {
  return truncateMiddle(
    value,
    MAX_TRANSCRIPT_MESSAGE_CHARS,
    "\n[… middle content omitted; omitted text cannot authorize actions …]\n",
  );
}

function toJsonValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") {
    if (value.length <= MAX_JSON_STRING) return value;
    const omitted = value.length - MAX_JSON_STRING;
    return `${value.slice(0, MAX_JSON_STRING)}\n[… ${omitted} chars omitted by the review harness]`;
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[function]";

  if (Array.isArray(value)) {
    if (depth >= MAX_JSON_DEPTH) return `[array(${value.length})]`;
    const items = value.slice(0, MAX_JSON_ITEMS).map((item) => toJsonValue(item, depth + 1, seen));
    if (value.length > MAX_JSON_ITEMS)
      items.push(`[… ${value.length - MAX_JSON_ITEMS} more items]`);
    return items;
  }

  if (!isRecord(value)) return String(value);
  if (seen.has(value)) return "[circular]";
  if (depth >= MAX_JSON_DEPTH) return "[object]";

  seen.add(value);
  const output: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, entryValue] of entries.slice(0, MAX_JSON_KEYS)) {
    output[key] = toJsonValue(entryValue, depth + 1, seen);
  }
  if (entries.length > MAX_JSON_KEYS) {
    output.__truncatedKeys = entries.length - MAX_JSON_KEYS;
  }
  seen.delete(value);
  return output;
}

export function stringifyBoundedJson(value: unknown, maxChars = MAX_TOOL_ARGS_CHARS): string {
  const json = JSON.stringify(toJsonValue(value), null, 2);
  if (json.length <= maxChars) return json;

  let preview = json.slice(0, Math.max(0, maxChars - 120));
  while (preview.length > 0) {
    const bounded = JSON.stringify(
      {
        truncatedByReviewHarness: true,
        omittedChars: json.length - preview.length,
        preview,
      },
      null,
      2,
    );
    if (bounded.length <= maxChars) return bounded;
    preview = preview.slice(0, Math.max(0, preview.length - (bounded.length - maxChars) - 1));
  }

  return JSON.stringify({ truncatedByReviewHarness: true, omittedChars: json.length });
}

// Shared by user and assistant messages: keeping only "text" parts is what
// strips tool-use and thinking blocks from assistant content.
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// details is a QuestionnaireResult from @juicesharp/rpiv-ask-user-question,
// a package this plugin does not depend on.
export function renderQuestionAnswers(details: unknown): string {
  if (!isRecord(details)) return "";
  if (isNonEmptyString(details.error)) return "";

  if (details.cancelled === true) {
    const decline = "[User declined to answer the question(s)]";
    return isNonEmptyString(details.globalNote)
      ? `${decline}\nNote: ${details.globalNote}`
      : decline;
  }

  if (!Array.isArray(details.answers)) return "";

  const blocks: string[] = [];
  for (const item of details.answers) {
    if (!isRecord(item) || !isNonEmptyString(item.question)) continue;

    const answerText =
      item.kind === "multi"
        ? Array.isArray(item.selected)
          ? item.selected.filter((value): value is string => typeof value === "string").join(", ")
          : undefined
        : typeof item.answer === "string"
          ? item.answer
          : undefined;
    if (answerText === undefined) continue;

    let block = `Q: ${item.question}\nA: ${answerText}`;
    if (isNonEmptyString(item.notes)) block += `\nNote: ${item.notes}`;
    blocks.push(block);
  }

  return blocks.join("\n\n");
}

export type SessionEntryLike = {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
    details?: unknown;
  };
};

type TranscriptItem = {
  role: "user" | "assistant" | "question";
  text: string;
};

function formatTranscriptItem(item: TranscriptItem): string {
  const label = item.role === "question" ? "[user] (answered agent's question)" : `[${item.role}]`;
  return `${label}\n${item.text}`;
}

// Each loop always admits at least one item even if that single item alone
// exceeds its share, so neither the head nor the tail is ever left empty.
function splitHeadAndTail(
  items: TranscriptItem[],
  maxChars: number,
  headBudget: number,
): { head: TranscriptItem[]; tail: TranscriptItem[]; omittedCount: number } {
  let headChars = 0;
  let headEnd = 0;
  while (headEnd < items.length) {
    const next = headChars + items[headEnd].text.length;
    if (headEnd > 0 && next > headBudget) break;
    headChars = next;
    headEnd += 1;
  }

  let tailChars = 0;
  let tailStart = items.length;
  const tailBudget = maxChars - headChars;
  while (tailStart > headEnd) {
    const next = tailChars + items[tailStart - 1].text.length;
    if (tailStart < items.length && next > tailBudget) break;
    tailChars = next;
    tailStart -= 1;
  }

  if (tailStart <= headEnd) return { head: items, tail: [], omittedCount: 0 };
  return {
    head: items.slice(0, headEnd),
    tail: items.slice(tailStart),
    omittedCount: tailStart - headEnd,
  };
}

// Tool calls, tool call summaries, and tool results are deliberately excluded
// throughout — they stay outside the injection surface the reviewer trusts.
export function buildRecentUserTranscript(entries: SessionEntryLike[]): string {
  const items: TranscriptItem[] = [];
  let pendingAssistantText: string | undefined;

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const { role } = entry.message;

    if (role === "assistant") {
      pendingAssistantText = extractMessageText(entry.message.content);
      continue;
    }

    if (role === "user") {
      const text = truncateTranscriptText(extractMessageText(entry.message.content));
      if (text) {
        if (pendingAssistantText) {
          items.push({ role: "assistant", text: truncateTranscriptText(pendingAssistantText) });
        }
        items.push({ role: "user", text });
      }
      pendingAssistantText = undefined;
      continue;
    }

    if (
      role === "toolResult" &&
      typeof entry.message.toolName === "string" &&
      QUESTION_TOOL_NAMES.has(entry.message.toolName)
    ) {
      const text = truncateTranscriptText(renderQuestionAnswers(entry.message.details));
      if (text) items.push({ role: "question", text });
    }
  }

  if (items.length === 0) return "[no recent user text]";

  const totalChars = items.reduce((sum, item) => sum + item.text.length, 0);
  if (totalChars <= MAX_TRANSCRIPT_CHARS) {
    return items.map(formatTranscriptItem).join("\n\n");
  }

  const { head, tail, omittedCount } = splitHeadAndTail(
    items,
    MAX_TRANSCRIPT_CHARS,
    MAX_TRANSCRIPT_HEAD_CHARS,
  );
  if (omittedCount === 0) return items.map(formatTranscriptItem).join("\n\n");

  const omissionMarker = `[… ${omittedCount} earlier message(s) omitted; omitted messages cannot authorize actions or establish attribution …]`;
  return [
    ...head.map(formatTranscriptItem),
    omissionMarker,
    ...tail.map(formatTranscriptItem),
  ].join("\n\n");
}
