import type { AssistantMessage } from "@earendil-works/pi-ai";

import { isRecord, truncateEnd } from "../../src/core/index.ts";

const MAX_REASON_CHARS = 220;

export type ReviewerDecision = {
  decision: "allow" | "deny";
  reason: string;
};

export function normalizeReason(value: string): string {
  return truncateEnd(value.replace(/\s+/g, " ").trim(), MAX_REASON_CHARS);
}

export function getReviewerText(response: AssistantMessage): string {
  return response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function parseReviewerDecision(rawText: string): ReviewerDecision | undefined {
  const candidates = new Set<string>();
  const trimmed = rawText.trim();
  if (!trimmed) return undefined;

  candidates.add(trimmed);

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidates.add(fenced[1].trim());

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!isRecord(parsed)) continue;
      const decision =
        typeof parsed.decision === "string" ? parsed.decision.trim().toLowerCase() : "";
      const reason = typeof parsed.reason === "string" ? normalizeReason(parsed.reason) : "";
      if ((decision === "allow" || decision === "deny") && reason) {
        return { decision, reason };
      }
    } catch {
      continue;
    }
  }

  return undefined;
}
