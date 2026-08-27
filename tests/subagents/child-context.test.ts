import { describe, expect, it, vi } from "vite-plus/test";
import {
  inChildSessionContext,
  runInChildSessionContext,
} from "../../modules/subagents/child-context.ts";
import { subagentsExtension } from "./helpers/boot-extension.ts";

describe("child session async context", () => {
  it("is scoped to the child async branch", async () => {
    expect(inChildSessionContext()).toBe(false);
    await runInChildSessionContext(async () => {
      expect(inChildSessionContext()).toBe(true);
      await Promise.resolve();
      expect(inChildSessionContext()).toBe(true);
    });
    expect(inChildSessionContext()).toBe(false);
  });

  it("prevents a child resource load from creating another extension manager", async () => {
    const pi = new Proxy(
      {},
      {
        get: vi.fn(() => {
          throw new Error("child extension factory must be a no-op");
        }),
      },
    );

    await runInChildSessionContext(async () => {
      expect(() => subagentsExtension(pi as any)).not.toThrow();
    });
  });
});
