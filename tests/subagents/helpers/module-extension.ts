/**
 * module-extension.ts — a default-exported `(pi) => Promise<void>` file for
 * `additionalExtensionPaths`, which loads a real file path as a bare pi
 * extension and cannot go through the `jpi` loader's `JpiModule` wrapping.
 * Re-exports `subagentsExtension` from boot-extension.ts as the default so
 * e2e runs boot the module the same way the wiring tests do.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { subagentsExtension } from "./boot-extension.ts";

export default function (pi: ExtensionAPI): Promise<void> {
  return subagentsExtension(pi);
}
