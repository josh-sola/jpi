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

  it("getToolDefinition and getAllRegisteredTools are real functions on the prototype", () => {
    expect(typeof ExtensionRunner.prototype.getToolDefinition).toBe("function");
    expect(typeof ExtensionRunner.prototype.getAllRegisteredTools).toBe("function");
  });

  it("patchToolDefinitionLookup transforms real direct and aggregate lookups idempotently", () => {
    const runner = handle.session.extensionRunner;
    expect(runner).toBeDefined();

    const originalGetToolDefinition = ExtensionRunner.prototype.getToolDefinition;
    const originalGetAllRegisteredTools = ExtensionRunner.prototype.getAllRegisteredTools;
    const patched = Symbol.for("jpi:style:mcp-tools-patched");
    const onDegrade = vi.fn();
    try {
      const originalEntry = originalGetAllRegisteredTools
        .call(runner!)
        .find((entry) => entry.definition.name === "PiCanaryTool");
      expect(originalEntry).toBeDefined();

      patchToolDefinitionLookup((toolName, lookup) => {
        const definition = lookup(toolName) as { name: string; label?: string } | undefined;
        return toolName === "PiCanaryTool" && definition
          ? { ...definition, label: "Styled PiCanaryTool" }
          : definition;
      }, onDegrade);
      expect(onDegrade).not.toHaveBeenCalled();

      const direct = runner!.getToolDefinition("PiCanaryTool") as
        | { name: string; label?: string }
        | undefined;
      expect(direct).toMatchObject({ name: "PiCanaryTool", label: "Styled PiCanaryTool" });

      const aggregateEntry = runner!
        .getAllRegisteredTools()
        .find((entry) => entry.definition.name === "PiCanaryTool");
      expect(aggregateEntry).toBeDefined();
      expect(aggregateEntry).not.toBe(originalEntry);
      expect(aggregateEntry!.definition).toMatchObject({
        name: "PiCanaryTool",
        label: "Styled PiCanaryTool",
      });
      expect(aggregateEntry!.sourceInfo).toBe(originalEntry!.sourceInfo);
      expect(originalEntry!.definition).not.toBe(aggregateEntry!.definition);

      const firstGetToolDefinitionPatch = ExtensionRunner.prototype.getToolDefinition;
      const firstGetAllRegisteredToolsPatch = ExtensionRunner.prototype.getAllRegisteredTools;
      patchToolDefinitionLookup((toolName, lookup) => lookup(toolName), onDegrade);
      expect(ExtensionRunner.prototype.getToolDefinition).toBe(firstGetToolDefinitionPatch);
      expect(ExtensionRunner.prototype.getAllRegisteredTools).toBe(firstGetAllRegisteredToolsPatch);
    } finally {
      ExtensionRunner.prototype.getToolDefinition = originalGetToolDefinition;
      ExtensionRunner.prototype.getAllRegisteredTools = originalGetAllRegisteredTools;
      delete (ExtensionRunner.prototype as unknown as Record<PropertyKey, unknown>)[patched];
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
