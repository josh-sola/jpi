import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Returns an `ExtensionAPI` handle identical to `pi` except for the members
 * in `overrides`.
 *
 * Load-bearing assumption: this only works while every `ExtensionAPI` member
 * is an own enumerable property, since it's built with a plain object spread.
 * If upstream ever makes `ExtensionAPI` a class instance, or moves members to
 * a prototype or getters, every decorated method silently disappears —
 * `{ ...pi }` won't pick them up.
 */
export function cloneExtensionApi(
  pi: ExtensionAPI,
  overrides: Partial<ExtensionAPI>,
): ExtensionAPI {
  return { ...pi, ...overrides };
}
