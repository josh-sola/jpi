import type { Store } from "../../src/core/index.ts";

export const INDEX_FILENAME = "MEMORY.md";

export type MemoryIndexResult = { missing: true } | { missing: false; content: string };

export type CapacityStatus = "ok" | "warn" | "over";

export const WARN_BYTES = 20 * 1024;
export const OVER_BYTES = 25 * 1024;

export async function readMemoryIndex(store: Store, slug: string): Promise<MemoryIndexResult> {
  const result = await store.readText(`${slug}/${INDEX_FILENAME}`);
  if ("missing" in result) return { missing: true };
  if ("problem" in result) throw new Error(result.problem);
  return { missing: false, content: result.value };
}

export function entryCount(content: string): number {
  return content.split("\n").filter((line) => line.startsWith("- [")).length;
}

export function capacityStatus(byteSize: number): CapacityStatus {
  if (byteSize > OVER_BYTES) return "over";
  if (byteSize > WARN_BYTES) return "warn";
  return "ok";
}
