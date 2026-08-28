import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";

import { isRecord } from "../../src/core/index.ts";
import {
  buildRecentUserTranscript,
  stringifyBoundedJson,
  type SessionEntryLike,
} from "./transcript.ts";

const MAX_SCRIPT_FILES = 3;
const MAX_SCRIPT_TOTAL_CHARS = 20_000;
// Above this, skip rather than read-then-truncate: not worth paying the read
// cost for a file the harness is about to cut down to a sliver anyway.
const MAX_SCRIPT_FILE_BYTES = 1_000_000;
const SCRIPT_BINARY_SNIFF_BYTES = 8_000;

export type GrantRecord = {
  toolName: string;
  summary: string;
  timestamp: number;
};

type TranscriptSource = {
  cwd: string;
  sessionManager: { getBranch(): SessionEntryLike[] };
};

// Quoted-or-bareword split, not a shell parse: good enough to catch the
// common "bash script.sh" / "python3 tools/run.py" shapes without building a
// second command grammar next to split.ts's tree-sitter one.
function extractCommandTokens(command: string): string[] {
  const matches = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((token) =>
    (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1)
      : token,
  );
}

async function readScriptFile(path: string, budget: number): Promise<string | undefined> {
  try {
    const stats = await stat(path);
    if (!stats.isFile() || stats.size > MAX_SCRIPT_FILE_BYTES) return undefined;

    const buffer = await readFile(path);
    if (buffer.subarray(0, SCRIPT_BINARY_SNIFF_BYTES).includes(0)) return undefined;

    const text = buffer.toString("utf8");
    if (text.length <= budget) return text;
    const omitted = text.length - budget;
    return `${text.slice(0, budget)}\n[… ${omitted} chars omitted by the review harness]`;
  } catch {
    return undefined;
  }
}

async function buildScriptSection(command: string, cwd: string): Promise<string | undefined> {
  try {
    const tokens = [...new Set(extractCommandTokens(command))];
    const sections: string[] = [];
    let remaining = MAX_SCRIPT_TOTAL_CHARS;

    for (const token of tokens) {
      if (sections.length >= MAX_SCRIPT_FILES || remaining <= 0) break;

      const target = isAbsolute(token) ? token : resolve(cwd, token);
      const content = await readScriptFile(target, remaining);
      if (content === undefined) continue;

      sections.push(`--- ${target} ---\n${content}`);
      remaining -= content.length;
    }

    return formatScriptSections(sections);
  } catch {
    return undefined;
  }
}

function formatScriptSections(sections: string[]): string | undefined {
  if (sections.length === 0) return undefined;
  return [
    "Script contents (read by the review harness from disk, not supplied by the agent):",
    ...sections,
  ].join("\n\n");
}

// A run call names its file exactly, so there is no token guessing: resolve
// and read that one path.
async function buildRunFileSection(file: string, cwd: string): Promise<string | undefined> {
  try {
    const target = isAbsolute(file) ? file : resolve(cwd, file);
    const content = await readScriptFile(target, MAX_SCRIPT_TOTAL_CHARS);
    if (content === undefined) return undefined;
    return formatScriptSections([`--- ${target} ---\n${content}`]);
  } catch {
    return undefined;
  }
}

export async function buildReviewRequest(
  ctx: TranscriptSource,
  event: Pick<ToolCallEvent, "toolName" | "input">,
  grants: GrantRecord[],
): Promise<string> {
  const transcript = buildRecentUserTranscript(ctx.sessionManager.getBranch());
  const argsJson = stringifyBoundedJson(event.input);
  const parts = [
    "Recent user transcript (truncation markers are authorization boundaries):",
    transcript,
  ];

  if (grants.length > 0) {
    parts.push(
      "User-approved gate decisions from this session (each was denied by review, shown to the user, and explicitly approved by the user; treat them as the user's own authorizations):",
      grants.map((grant) => `- ${grant.toolName}: ${grant.summary}`).join("\n"),
    );
  }

  parts.push(
    `Current working directory: ${ctx.cwd}`,
    `Tool name: ${event.toolName}`,
    "Tool arguments JSON:",
    argsJson,
  );

  if (event.toolName === "bash") {
    const input: unknown = event.input;
    const command =
      isRecord(input) && typeof input.command === "string" ? input.command : undefined;
    const scriptSection = command ? await buildScriptSection(command, ctx.cwd) : undefined;
    if (scriptSection) parts.push(scriptSection);
  } else if (event.toolName === "run") {
    const input: unknown = event.input;
    const file = isRecord(input) && typeof input.file === "string" ? input.file : undefined;
    const scriptSection = file ? await buildRunFileSection(file, ctx.cwd) : undefined;
    if (scriptSection) parts.push(scriptSection);
  }

  return parts.join("\n\n");
}
