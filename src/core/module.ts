import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { z } from "zod";

import type { AnyJpiNodeSpec, InferNode, JpiNodeSpec } from "./builder.ts";
import { j } from "./builder.ts";
import type { Config } from "./config.ts";

type EmptyJpiNodeSpec = JpiNodeSpec<Record<never, never>, Record<never, never>>;
type EnabledSchema = z.ZodDefault<z.ZodBoolean>;

/** The schema a module declares, plus the `enabled` field injectEnabled prepends before load. */
export type WithEnabled<S extends AnyJpiNodeSpec> = JpiNodeSpec<
  S["attrs"],
  { readonly enabled: EnabledSchema } & S["fields"]
>;

export interface ModuleContext<S extends AnyJpiNodeSpec = AnyJpiNodeSpec> {
  readonly config: Config<WithEnabled<S>>;
  readonly value: InferNode<WithEnabled<S>>;
  readonly issues: readonly string[];
}

export interface JpiModule<S extends AnyJpiNodeSpec = AnyJpiNodeSpec> {
  /** Used to prefix notify/error messages, e.g. "guardian". */
  readonly name: string;
  /** jpi.kdl section name — usually equal to name. */
  readonly section: string;
  /** Omit for a module with no config beyond `enabled`. */
  readonly schema?: S;
  /** When multiple enabled modules share this group, the loader skips every member. */
  readonly exclusiveGroup?: string;
  /** The injected `enabled` value for generated stanzas and invalid-config fallbacks. */
  readonly enabledByDefault?: boolean;
  setup(pi: ExtensionAPI, ctx: ModuleContext<S>): void | Promise<void>;
}

/**
 * Wraps a module's schema with a leading `enabled` field so every stanza gets
 * one without each module declaring it. Fields render in insertion order
 * (codec.ts), so `enabled` must be inserted before the module's own fields
 * to land first in a freshly appended stanza.
 */
export function injectEnabled<S extends AnyJpiNodeSpec = EmptyJpiNodeSpec>(
  name: string,
  schema?: S,
  enabledByDefault = true,
): WithEnabled<S> {
  const base = (schema ?? j.node()) as AnyJpiNodeSpec;
  if ("enabled" in base.fields || "enabled" in base.attrs) {
    throw new Error(
      `${name}: module schema must not declare its own "enabled" field or attr — the loader injects it`,
    );
  }

  return j.node({
    attrs: base.attrs,
    fields: {
      enabled: j
        .boolean()
        .describe(`set to #false to disable the ${name} module entirely`)
        .default(enabledByDefault),
      ...base.fields,
    },
  }) as WithEnabled<S>;
}
