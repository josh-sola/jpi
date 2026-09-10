import net from "node:net";

import type { Scheduler } from "../../src/core/index.ts";

/** Matches the subset of node:net.Socket createHerdrClient needs, so tests can inject a fake. */
export type HerdrSocket = {
  write(data: string): void;
  destroy(): void;
  on(event: "connect" | "data" | "end" | "error", listener: (...args: unknown[]) => void): unknown;
};

export type HerdrConnect = (socketPath: string) => HerdrSocket;

export type CreateHerdrClientOptions = {
  socketPath: string;
  connect?: HerdrConnect;
  scheduler?: Scheduler;
};

export type HerdrClient = {
  send(request: unknown): Promise<boolean>;
};

const defaultScheduler: Scheduler = {
  setTimeout: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    timer.unref?.();
    return timer;
  },
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function attempt(
  connect: HerdrConnect,
  scheduler: Scheduler,
  socketPath: string,
  request: unknown,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let timer: unknown;
    const socket = connect(socketPath);
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timer !== undefined) scheduler.clearTimeout(timer);
      socket.destroy();
      resolve(delivered);
    };
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    // herdr's socket protocol has no explicit ack for a request: any bytes back
    // from the server are the delivery signal, so we don't parse them.
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timer = scheduler.setTimeout(() => finish(false), timeoutMs);
  });
}

export function createHerdrClient(options: CreateHerdrClientOptions): HerdrClient {
  const connect: HerdrConnect =
    options.connect ?? ((socketPath) => net.createConnection(socketPath) as unknown as HerdrSocket);
  const scheduler = options.scheduler ?? defaultScheduler;

  return {
    async send(request: unknown): Promise<boolean> {
      if (await attempt(connect, scheduler, options.socketPath, request, 500)) return true;
      return attempt(connect, scheduler, options.socketPath, request, 1500);
    },
  };
}
