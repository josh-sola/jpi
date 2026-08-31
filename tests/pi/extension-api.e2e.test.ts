/**
 * extension-api.e2e.test.ts — canary for src/pi/extension-api.ts.
 *
 * `cloneExtensionApi` only works because every `ExtensionAPI` member is an
 * OWN ENUMERABLE property, so `{ ...pi, ...overrides }` copies all of them.
 * A mock `pi` (tests/subagents/helpers/boot-extension.ts's `makePi`) can't
 * catch a real Pi turning `ExtensionAPI` into a class instance or moving
 * members onto a prototype or behind getters — a mock is built as a plain
 * object either way. This asserts the real `pi` real extension factories
 * receive still has that shape, for the exact members jpi decorates
 * (`registerTool`, via `decorateToolRegistration`) or otherwise calls
 * directly (grepped from modules/extensions/src: `on`, `events`,
 * `registerCommand`, `registerEntryRenderer`, `registerMessageRenderer`,
 * `registerShortcut`, `sendMessage`, `appendEntry`, `exec`,
 * `getSessionName`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cloneExtensionApi } from "../../src/pi/extension-api.ts";
import { bootRealSession, type RealSessionHandle } from "./helpers/real-session.ts";

vi.setConfig({ testTimeout: 30_000 });

// Every ExtensionAPI member jpi reaches for, outside `registerTool` (see
// tool-registration.test.ts-equivalent coverage elsewhere for that one) —
// grepped as `pi.<member>` across modules/, extensions/, src/.
const USED_MEMBERS = [
  "registerTool",
  "on",
  "events",
  "registerCommand",
  "registerEntryRenderer",
  "registerMessageRenderer",
  "registerShortcut",
  "sendMessage",
  "appendEntry",
  "exec",
  "getSessionName",
] as const;

/** `ExtensionAPI` has no index signature, so a member-by-name read needs this escape hatch. */
function asRecord(api: ExtensionAPI): Record<string, unknown> {
  return api as unknown as Record<string, unknown>;
}

describe("extension-api: real ExtensionAPI members survive a spread (real pi)", () => {
  let handle: RealSessionHandle;
  let pi: ExtensionAPI;

  beforeAll(async () => {
    handle = await bootRealSession();
    pi = handle.pi;
  });
  afterAll(async () => {
    await handle.dispose();
  });

  it("captured a real ExtensionAPI", () => {
    expect(pi).toBeDefined();
  });

  it.each(USED_MEMBERS)("%s is an own enumerable property of the real pi", (member) => {
    expect(Object.prototype.hasOwnProperty.call(pi, member)).toBe(true);
    expect(Object.prototype.propertyIsEnumerable.call(pi, member)).toBe(true);
  });

  it("cloneExtensionApi's spread carries every used member through unchanged", () => {
    const cloned = cloneExtensionApi(pi, {});
    for (const member of USED_MEMBERS) {
      expect(asRecord(cloned)[member]).toBe(asRecord(pi)[member]);
    }
  });

  it("cloneExtensionApi's override still lands, alongside every other member", () => {
    const sentinel = vi.fn();
    const cloned = cloneExtensionApi(pi, { registerTool: sentinel as never });
    expect(cloned.registerTool).toBe(sentinel);
    // Every other used member is still the real pi's, not lost by the spread.
    for (const member of USED_MEMBERS) {
      if (member === "registerTool") continue;
      expect(asRecord(cloned)[member]).toBe(asRecord(pi)[member]);
    }
  });
});
