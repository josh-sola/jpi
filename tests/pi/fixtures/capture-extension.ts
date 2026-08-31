/**
 * capture-extension.ts — a bare `(pi) => void` extension file, loaded through
 * `DefaultResourceLoader`'s `additionalExtensionPaths` exactly like
 * tests/subagents/helpers/module-extension.ts does for the real subagents
 * module. Instead of booting a jpi module, it stashes the REAL `pi` handle
 * pi's loader hands to extension factories on a global symbol so a test can
 * read it back, and registers one real tool so `getExtensions().extensions`
 * and `getToolDefinition` have something real to find.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** The captured `pi` handle, published so tests/pi's real-session helper can read it back. */
export const CAPTURED_PI = Symbol.for("jpi:tests-pi:captured-extension-api");

export default function captureExtension(pi: ExtensionAPI): void {
  (globalThis as Record<symbol, unknown>)[CAPTURED_PI] = pi;

  // A no-op handler so `hasHandlers("session_shutdown")` is true — the
  // extension-runner canary needs a real ExtensionRunner that WOULD emit,
  // to prove `emitSessionShutdown` reaches a live handler rather than only
  // exercising its no-handlers-registered short circuit.
  pi.on("session_shutdown", () => {});

  pi.registerTool({
    name: "PiCanaryTool",
    label: "PiCanaryTool",
    description:
      "No-op tool the tests/pi canary suite registers to prove real tool lookup/listing still works.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
    },
  });
}
