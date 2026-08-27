import { join } from "node:path";

import { INDEX_FILENAME, type CapacityStatus, type MemoryIndexResult } from "./memory-index.ts";

function formatKb(byteSize: number): string {
  return `${(byteSize / 1024).toFixed(1)}KB`;
}

function capacityWarning(capacity: CapacityStatus, indexPath: string, byteSize: number): string {
  if (capacity === "over") {
    return `Warning: ${indexPath} is ${formatKb(byteSize)}, over the size where it stays cheap to inject every turn. The write succeeded, but the index is now oversized — rewrite it now: keep one line per entry, move detail into the memory files themselves, and merge or drop stale entries.`;
  }
  if (capacity === "warn") {
    return `${indexPath} is ${formatKb(byteSize)}, approaching the size where it stops being cheap to inject every turn. Compact it soon: keep one line per entry, move detail into the memory files themselves, and merge or drop stale entries.`;
  }
  return "";
}

export function buildMemorySection(
  memoryDir: string,
  indexResult: MemoryIndexResult,
  capacity: CapacityStatus,
): string {
  const indexPath = join(memoryDir, INDEX_FILENAME);
  const content = indexResult.missing ? "" : indexResult.content;
  const hasEntries = content.trim().length > 0;

  const indexBody = hasEntries
    ? content
    : indexResult.missing
      ? `The index is empty. ${INDEX_FILENAME} will be created at ${indexPath} with your first memory.`
      : `The index is empty. ${INDEX_FILENAME} exists at ${indexPath} but has no entries yet.`;

  const warning = hasEntries
    ? capacityWarning(capacity, indexPath, Buffer.byteLength(content, "utf8"))
    : "";

  return `# Memory

You have a persistent file-based memory at \`${memoryDir}\`. This directory already exists — write your memory files there directly. Each memory is one file holding one fact, with frontmatter:

\`\`\`markdown
---
name: <short-kebab-case-slug>
description: <one-line summary, used to decide relevance during recall>
metadata:
  type: user | feedback | project | reference
---

<the fact; for feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>
\`\`\`

\`[[their-name]]\` links to another memory's \`name:\` slug (not its filename) when the two inform each other.

## Memory types

### user

Contain information about the user's role, goals, responsibilities, and knowledge. Good user memories help you tailor your future behavior to the user's preferences and perspective — the aim is to build up an understanding of who the user is and how you can be most helpful to them specifically. Collaborate with a senior engineer differently than a student writing their first program. Avoid memories about the user that read as a negative judgement or that aren't relevant to the work.

Use these when your work should be informed by the user's profile or perspective — for example, tailoring an explanation to the domain knowledge they already have.

### feedback

Guidance the user has given you about how to approach work — both what to avoid and what to keep doing. This is the type to keep most current: it is what lets you stay coherent and responsive to how the user wants you to work. Record from failure AND success — if you only save corrections, you avoid past mistakes but drift away from approaches the user already validated, and you grow overly cautious. Before saving one, check it doesn't contradict an existing feedback memory; if it does, either skip the save or note the override explicitly.

**Body:** lead with the rule itself, then a **Why:** line (the reason the user gave — often a past incident or strong preference) and a **How to apply:** line (when this guidance kicks in). Knowing why lets you judge edge cases instead of blindly following the rule.

**When to save:** any time the user corrects your approach ("no not that", "don't", "stop doing X") or confirms a non-obvious approach worked ("yes exactly", "perfect, keep doing that", accepting an unusual choice without pushback). Corrections are easy to notice; confirmations are quieter — watch for them. Save what's applicable to future conversations, especially if it's surprising or not obvious from the code, and include the why so you can judge edge cases later.

### project

Information you learn about ongoing work, goals, initiatives, bugs, or incidents in this project that isn't otherwise derivable from the code or git history. Project memories help you understand the broader context and motivation behind the work the user is doing in this directory.

**Body:** lead with the fact or decision, then a **Why:** line (the motivation — often a constraint, deadline, or stakeholder ask) and a **How to apply:** line (how this should shape your suggestions). Project memories decay fast, so the why helps future-you judge whether the memory is still load-bearing.

**When to save:** when you learn who is doing what, why, or by when. These states change quickly, so keep your understanding current. Always convert relative dates in user messages to absolute dates when saving (e.g. "Thursday" becomes the actual calendar date), so the memory stays interpretable after time passes.

### reference

Pointers to external resources — URLs, dashboards, tickets — that are worth coming back to but don't belong inline in another memory file.

## Saving a memory

**Step 1** — write one memory file at \`${memoryDir}/<name>.md\` with the frontmatter above (create a new file, or update the matching one if this refines an existing memory).

**Step 2** — add a pointer to it in \`${INDEX_FILENAME}\`. \`${INDEX_FILENAME}\` is an index, not a memory — each entry is one line, under about 150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into \`${INDEX_FILENAME}\`.

## What's worth saving

A good memory is applicable, durable, and legible:

- **Applicable** — would directly change your behavior in future sessions: an approach the user corrected or steered you away from, or a standing preference they expressed. Not ambient code context, and not something you worked out yourself — the lesson must come from something the user told you or corrected you on.
- **Durable** — applies across future sessions and tasks, not just this one: a standing preference or correction that will come up again and that the user would otherwise have to restate. Watch for words that widen or narrow scope — "never...", "always...", "whenever you..." widen and are durable; "this time...", "for now..." narrow. If you're unsure whether a lesson is durable, assume it isn't and don't save it.
- **Legible** — polished and readable without the original session: one topic per file, written in connected full sentences, like a short encyclopedia entry. Include the why, not just the what. Avoid shorthand, scratchpad prose, or unresolvable references ("the fix", a bare ticket ID).

Check each reply before you send it — including replies that are only tool calls — for whether the user's latest message just taught you a durable, applicable lesson. Save only that lesson, not a correction from an earlier turn you let pass at the time. If it did, write the memory file and its index pointer in that same reply, before you treat your turn as finished. Doing what the user asked does not discharge the save, and neither does writing their guidance into AGENTS.md or a README — that edit ships the change, the memory is what carries the preference into next session.

## What NOT to save in memory

- What the repo already records: code structure, git history, and the content of AGENTS.md/README files.
- Session-only state: anything only useful within the scope of the current conversation.
- Transient task plans or status: in-progress steps and progress tracking for the current task.
- Secrets or credentials: API keys, tokens, passwords, or anything else that shouldn't sit in a plain-text file.

Memory persists across sessions; it is not the place for information that is only useful within the current conversation.

When you use a recalled memory, treat it as a past snapshot to verify against current sources, not as a definitive source of truth.

## Memory index (${INDEX_FILENAME})

${indexBody}
${warning ? `\n${warning}\n` : ""}`;
}
