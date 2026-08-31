/**
 * Pi 0.80.8 replaced `createAgentSession`'s `modelRegistry` option with
 * `modelRuntime`, but `ExtensionContext` still exposes only the registry
 * facade — `runtime` is a private field on it, not part of the documented
 * `ModelRegistry` shape. Reading it off `ctx.modelRegistry` is how callers
 * that build their OWN `createAgentSession` call (subagent spawns, mention
 * clones) carry the parent's providers across the full supported Pi range:
 * pass both `modelRegistry` and `modelRuntime` — pre-0.80.8 only the former
 * is used, 0.80.8+ prefers the latter.
 *
 * Returns `any` rather than `unknown` so it flows straight into a
 * `createAgentSession(...)` options object's `modelRuntime` field without a
 * cast at the call site: pre-0.80.8 that field doesn't exist on the options
 * type at all (callers add a `modelRuntime?: unknown` shim to their own
 * options type to hold it), and 0.80.8+ types it as the real `ModelRuntime` —
 * a shape an opaque read off the private facade field could never honestly
 * satisfy. Forcing that once here, rather than with an `as never` at every
 * call site, keeps the unsafe cast in the one place that owns this coupling.
 */
export function getModelRuntime(ctx: { modelRegistry: unknown }): any {
  return (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
}
