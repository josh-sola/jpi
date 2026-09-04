import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import titleModule from "../../modules/title/module.ts";
import { FakeEventBus } from "./jpi-title-test-helpers.ts";

test("title-mode registers as a dynamic string flag and resolves it at session start", async () => {
  vi.useFakeTimers();
  try {
    const events = new FakeEventBus();
    const handlers = new Map<string, (event: unknown, context: any) => Promise<void> | void>();
    const registrations: Array<{ name: string; options: unknown }> = [];
    const titles: string[] = [];
    let value: boolean | string | undefined = "static";
    let flagReads = 0;
    const pi = {
      registerFlag(name: string, options: unknown) {
        registrations.push({ name, options });
      },
      getFlag() {
        flagReads += 1;
        return value;
      },
      exec: async () => ({ code: 1 }),
      events,
      getSessionName: () => undefined,
      on(name: string, handler: (event: unknown, context: any) => Promise<void> | void) {
        handlers.set(name, handler);
      },
    } as unknown as ExtensionAPI;

    await titleModule.setup(pi, {} as never);
    assert.deepEqual(registrations, [
      {
        name: "title-mode",
        options: {
          description: "Title activity mode: static|dynamic",
          type: "string",
          default: "dynamic",
        },
      },
    ]);
    assert.equal(flagReads, 0);

    const context = {
      mode: "tui",
      cwd: "/repo/project",
      ui: { setTitle: (title: string) => titles.push(title) },
    };
    const sessionStart = handlers.get("session_start");
    const agentStart = handlers.get("agent_start");
    const shutdown = handlers.get("session_shutdown");
    assert.ok(sessionStart);
    assert.ok(agentStart);
    assert.ok(shutdown);

    await sessionStart({}, context);
    await agentStart({}, context);
    assert.equal(titles.at(-1), "◐ project");
    await vi.advanceTimersByTimeAsync(530);
    assert.equal(titles.at(-1), "◐ project");

    await shutdown({}, context);

    for (const dynamicValue of ["dynamic", "invalid", undefined]) {
      value = dynamicValue;
      await sessionStart({}, context);
      await agentStart({}, context);
      await vi.advanceTimersByTimeAsync(530);
      assert.equal(titles.at(-1), "◓ project");
      await shutdown({}, context);
    }
    assert.equal(flagReads, 4);
  } finally {
    vi.useRealTimers();
  }
});
