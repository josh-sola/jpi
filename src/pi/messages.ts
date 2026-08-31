import type { EditToolDetails } from "@earendil-works/pi-coding-agent";

/**
 * Pulls the diff string out of an edit tool result's `details`. `details` is
 * `unknown` on the wire (it's whatever shape the tool that produced it
 * chose); this only recognizes pi's own edit tool shape.
 */
export function editResultDiff(details: unknown): string | undefined {
  return (details as EditToolDetails | undefined)?.diff;
}

/** Added/removed line counts from an edit tool's unified-style diff string. */
export function countDiffStats(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++;
    else if (line.startsWith("-") && !line.startsWith("---")) removals++;
  }
  return { additions, removals };
}
