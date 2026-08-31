/**
 * model-registry.test.ts — canary for src/pi/model-registry.ts.
 *
 * `getModelRuntime` reads the private `runtime` field off pi's real
 * `ModelRegistry` — no session needed, `ModelRegistry`'s own constructor is
 * `constructor(runtime)`. Exported from pi-coding-agent's root barrel.
 */
import { describe, expect, it } from "vite-plus/test";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getModelRuntime } from "../../src/pi/model-registry.ts";

describe("model-registry: getModelRuntime vs a real ModelRegistry (real pi-coding-agent)", () => {
  it("returns the exact runtime a real ModelRegistry was constructed with", () => {
    const runtime = { marker: "the-real-runtime" };
    const registry = new ModelRegistry(runtime as never);
    expect(getModelRuntime({ modelRegistry: registry })).toBe(runtime);
  });

  it("returns undefined for a registry-shaped object with no private runtime field", () => {
    expect(getModelRuntime({ modelRegistry: {} })).toBeUndefined();
  });
});
