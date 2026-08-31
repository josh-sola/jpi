import { ExtensionRunner } from "@earendil-works/pi-coding-agent";

const PATCHED = Symbol.for("jpi:style:mcp-tools-patched");

/**
 * Patches `ExtensionRunner.prototype.getToolDefinition` so every lookup runs
 * through `transform` first: `transform` receives the requested tool name
 * and a bound `original` lookup (`this`-correct, so it can be called more
 * than once or not at all) and returns whatever `getToolDefinition` should
 * now return for that name.
 *
 * `ExtensionRunner.getToolDefinition` is also the path pi's own execution
 * machinery and the HTML transcript exporter use to look up a tool by name,
 * so `transform` is responsible for preserving whatever contract callers
 * expect (falling through to `original` for names it doesn't care about,
 * returning the exact `undefined` `original` would have, etc.) — this
 * installer only owns the patch mechanics.
 *
 * Idempotent: safe to call more than once (across separate `transform`s or
 * the same one — the second call is a no-op either way). Degrades to a
 * no-op — `original` behavior stays, `transform` never runs — if
 * `ExtensionRunner`'s shape doesn't match what this expects; `onDegrade` is
 * called with the error instead of throwing.
 */
export function patchToolDefinitionLookup(
  transform: (toolName: string, original: (name: string) => unknown) => unknown,
  onDegrade: (error: unknown) => void,
): void {
  try {
    const proto = ExtensionRunner.prototype as unknown as Record<PropertyKey, unknown> & {
      [PATCHED]?: boolean;
    };
    if (proto[PATCHED]) return;

    const originalGetToolDefinition = proto.getToolDefinition;
    if (typeof originalGetToolDefinition !== "function") {
      throw new Error("ExtensionRunner.prototype is missing getToolDefinition");
    }

    proto.getToolDefinition = function (this: unknown, toolName: string): unknown {
      const original = (name: string): unknown =>
        (originalGetToolDefinition as (this: unknown, name: string) => unknown).call(this, name);
      return transform(toolName, original);
    };

    Object.defineProperty(proto, PATCHED, { value: true, configurable: true });
  } catch (error) {
    onDegrade(error);
  }
}
