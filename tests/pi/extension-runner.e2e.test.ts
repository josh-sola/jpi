/**
 * extension-runner.e2e.test.ts — canary for src/pi/extension-runner.ts, all
 * against one shared real `AgentSession` (faux model, no network).
 *
 * `getToolDefinition` reads a private `this.extensions` list internally, so
 * `patchToolDefinitionLookup` can only be proven against a REAL
 * `ExtensionRunner` instance, not a hand-built stand-in — a fake `this`
 * throws inside pi's own method the moment it iterates that field.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import {
  emitSessionShutdown,
  listExtensionTools,
  patchToolDefinitionLookup,
} from "../../src/pi/extension-runner.ts";
import { bootRealSession, type RealSessionHandle } from "./helpers/real-session.ts";

vi.setConfig({ testTimeout: 30_000 });

describe("extension-runner (real pi)", () => {
  let handle: RealSessionHandle;

  beforeAll(async () => {
    handle = await bootRealSession();
  });
  afterAll(async () => {
    await handle.dispose();
  });

  it("getToolDefinition is a real function on the prototype", () => {
    expect(typeof ExtensionRunner.prototype.getToolDefinition).toBe("function");
  });

  it("patchToolDefinitionLookup installs, transforms a real lookup, and is idempotent", () => {
    const runner = handle.session.extensionRunner;
    expect(runner).toBeDefined();

    const original = ExtensionRunner.prototype.getToolDefinition;
    const onDegrade = vi.fn();
    try {
      const seen: string[] = [];
      patchToolDefinitionLookup((toolName, lookup) => {
        seen.push(toolName);
        return lookup(toolName);
      }, onDegrade);
      expect(onDegrade).not.toHaveBeenCalled();

      const definition = runner!.getToolDefinition("PiCanaryTool");
      expect(seen).toEqual(["PiCanaryTool"]);
      expect((definition as { name?: string } | undefined)?.name).toBe("PiCanaryTool");

      // Idempotent: a second install doesn't double-wrap the prototype method.
      const afterFirstInstall = ExtensionRunner.prototype.getToolDefinition;
      patchToolDefinitionLookup((toolName, lookup) => lookup(toolName), onDegrade);
      expect(ExtensionRunner.prototype.getToolDefinition).toBe(afterFirstInstall);
    } finally {
      ExtensionRunner.prototype.getToolDefinition = original;
    }
  });

  it("listExtensionTools sees the real registered tool", () => {
    const infos = listExtensionTools(handle.loader);
    const withOurTool = infos.find((info) => info.toolNames.includes("PiCanaryTool"));
    expect(withOurTool).toBeDefined();
  });

  it("emitSessionShutdown resolves against a real session's extensionRunner", async () => {
    await expect(emitSessionShutdown(handle.session)).resolves.toBeUndefined();
  });

  it("emitSessionShutdown is a no-op (undefined, synchronous) with no extensionRunner", () => {
    const result = emitSessionShutdown({});
    expect(result).toBeUndefined();
  });
});
