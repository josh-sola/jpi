// <agent-dir>/jpi.kdl's `tasks { }` section provides settings shared across
// every workspace. There is no per-project override — see core's Config.

import { j } from "../../src/core/index.ts";

export const tasksSchema = j.node({
  fields: {
    scope: j
      .union(j.literal("memory"), j.literal("session"), j.literal("project"))
      .describe("where the task list is stored — memory, session, or project")
      .default("session"),
    autoClearCompleted: j
      .union(j.literal("never"), j.literal("on_list_complete"), j.literal("on_task_complete"))
      .describe("when completed tasks are swept from the list")
      .default("on_list_complete"),
  },
});
