import { j } from "../../src/core/index.ts";

const MEBIBYTE = 1024 * 1024;

export const backgroundSchema = j.node({
  fields: {
    maxOutputBytes: j
      .number()
      .int()
      .positive()
      .describe("bytes of output a task may write before it is capped and killed")
      .default(20 * MEBIBYTE),
    defaultTimeoutSeconds: j
      .number()
      .int()
      .nonnegative()
      .describe("default per-task timeout in seconds; 0 means tasks run until they exit")
      .default(0),
    monitorTimeoutSeconds: j
      .number()
      .int()
      .positive()
      .describe("lifetime in seconds for a non-persistent monitor before it is stopped")
      .default(1800),
    maxMonitorEventsPerMinute: j
      .number()
      .int()
      .positive()
      .describe("monitor events allowed per minute before flood suppression kicks in")
      .default(30),
    ttlDays: j
      .number()
      .int()
      .positive()
      .describe("age in days after which a stale, no-longer-running session's task dir is swept")
      .default(7),
    runEnabled: j
      .boolean()
      .describe("register the run tool for structured zsh/typescript/python execution")
      .default(true),
    runDefaultTimeoutSeconds: j
      .number()
      .int()
      .nonnegative()
      .describe("default timeout in seconds for a foreground run; 0 disables it")
      .default(600),
    runBackgroundShortcut: j
      .string()
      .describe("key that detaches the current foreground run to the background")
      .default("ctrl+b"),
  },
});
