import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Store } from "../../src/core/index.ts";

export interface PromptEntry {
  text: string;
  timestamp: string;
  cwd: string;
}

const PROMPTS_FILE = "prompts.jsonl";

// Constructed on first use, not at import time: a merged test process loads
// this module once for every test file, and an eager singleton would leak
// one process's state (and PI_CODING_AGENT_DIR) into another's.
let defaultStore: Store | undefined;

function getDefaultStore(): Store {
  return (defaultStore ??= new Store("history"));
}

const dirsEnsured = new WeakSet<Store>();

async function ensureLogDir(store: Store): Promise<void> {
  if (dirsEnsured.has(store)) return;
  await mkdir(dirname(store.path(PROMPTS_FILE)), { recursive: true });
  dirsEnsured.add(store);
}

/**
 * Appends via fs.appendFile, not Store's atomic whole-file writes: those
 * would drop whichever concurrent pi session wrote last, while a single
 * JSONL line under O_APPEND doesn't interleave across processes.
 */
export async function appendPrompt(
  entry: PromptEntry,
  store: Store = getDefaultStore(),
): Promise<void> {
  await ensureLogDir(store);
  await appendFile(store.path(PROMPTS_FILE), `${JSON.stringify(entry)}\n`, "utf8");
}

interface RawPromptEntry {
  text?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
}

function parsePromptLine(line: string): PromptEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;

  const entry = raw as RawPromptEntry;
  if (typeof entry.text !== "string" || entry.text.trim() === "") return undefined;

  return {
    text: entry.text,
    timestamp: typeof entry.timestamp === "string" ? entry.timestamp : "",
    cwd: typeof entry.cwd === "string" ? entry.cwd : "",
  };
}

/**
 * Reads the plugin's own prompt log, newest first, deduped by exact text
 * (the newest occurrence wins). Never throws — a missing or unreadable log
 * is treated as empty.
 */
export async function readPrompts(store: Store = getDefaultStore()): Promise<PromptEntry[]> {
  let contents: string;
  try {
    contents = await readFile(store.path(PROMPTS_FILE), "utf8");
  } catch {
    return [];
  }

  const entries: PromptEntry[] = [];
  for (const line of contents.split("\n")) {
    const entry = parsePromptLine(line);
    if (entry) entries.push(entry);
  }

  // The log is append-only, so file order is chronological; reverse it to
  // get newest first.
  entries.reverse();

  const seen = new Set<string>();
  const deduped: PromptEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.text)) continue;
    seen.add(entry.text);
    deduped.push(entry);
  }
  return deduped;
}

/**
 * Trims the log to its newest `maxSize` lines, kept verbatim (malformed
 * lines count toward the total and age out like any other). A no-op when
 * the log is already at or under the cap or doesn't exist yet.
 *
 * Runs once per session start, not per append: the rewrite races a
 * concurrent session's append landing between this read and the rename.
 */
export async function trimLog(maxSize: number, store: Store = getDefaultStore()): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(store.path(PROMPTS_FILE), "utf8");
  } catch {
    return;
  }

  const lines = contents.split("\n").filter((line) => line.trim() !== "");
  if (lines.length <= maxSize) return;

  const kept = lines.slice(lines.length - maxSize);
  await store.writeText(PROMPTS_FILE, `${kept.join("\n")}\n`);
}
