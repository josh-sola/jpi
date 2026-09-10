import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  createHerdrClient,
  type HerdrConnect,
  type HerdrSocket,
} from "../../modules/herdr-status/client.ts";

class ManualScheduler {
  timers: Array<{ callback: () => void; delay: number; cleared: boolean }> = [];

  setTimeout(callback: () => void, delay: number) {
    const timer = { callback, delay, cleared: false };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(timer: unknown) {
    (timer as { cleared: boolean }).cleared = true;
  }

  fire(timer: { callback: () => void; cleared: boolean }) {
    if (timer.cleared) return;
    timer.cleared = true;
    timer.callback();
  }

  active(delay: number) {
    return this.timers.filter((timer) => timer.delay === delay && !timer.cleared);
  }
}

class FakeSocket implements HerdrSocket {
  listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  written: string[] = [];
  destroyed = false;

  on(event: string, listener: (...args: unknown[]) => void) {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  write(data: string) {
    this.written.push(data);
  }

  destroy() {
    this.destroyed = true;
  }

  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function harness() {
  const scheduler = new ManualScheduler();
  const sockets: FakeSocket[] = [];
  const connect: HerdrConnect = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };
  const client = createHerdrClient({ socketPath: "/tmp/herdr.sock", connect, scheduler });
  return { scheduler, sockets, client };
}

test("resolves true on the first attempt when data comes back", async () => {
  const { sockets, client } = harness();
  const pending = client.send({ id: "1", method: "pane.report_agent", params: {} });
  sockets[0]!.emit("connect");
  sockets[0]!.emit("data");
  assert.equal(await pending, true);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0]!.destroyed, true);
  assert.equal(sockets[0]!.written[0], '{"id":"1","method":"pane.report_agent","params":{}}\n');
});

test("retries with a second attempt after the first attempt times out", async () => {
  const { scheduler, sockets, client } = harness();
  const pending = client.send({ id: "1", method: "pane.report_agent", params: {} });

  const first = scheduler.active(500)[0];
  assert.ok(first);
  scheduler.fire(first);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(sockets.length, 2);
  assert.equal(sockets[0]!.destroyed, true);
  sockets[1]!.emit("connect");
  sockets[1]!.emit("data");
  assert.equal(await pending, true);
});

test("resolves false after both attempts time out", async () => {
  const { scheduler, sockets, client } = harness();
  const pending = client.send({ id: "1", method: "pane.report_agent", params: {} });

  const first = scheduler.active(500)[0];
  assert.ok(first);
  scheduler.fire(first);
  await Promise.resolve();
  await Promise.resolve();

  const second = scheduler.active(1500)[0];
  assert.ok(second);
  scheduler.fire(second);

  assert.equal(await pending, false);
  assert.equal(sockets.length, 2);
  assert.equal(sockets[1]!.destroyed, true);
});

test("a socket error fails the attempt and the client retries", async () => {
  const { sockets, client } = harness();
  const pending = client.send({ id: "1", method: "pane.report_agent", params: {} });
  sockets[0]!.emit("error");
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(sockets.length, 2, "an error fails just the one attempt, not the whole send");
  sockets[1]!.emit("connect");
  sockets[1]!.emit("data");
  assert.equal(await pending, true);
  assert.equal(sockets[0]!.destroyed, true);
});
