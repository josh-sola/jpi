import { j } from "../../src/core/index.ts";

export const scheduleSchema = j.node({
  fields: {
    maxSchedules: j
      .number()
      .int()
      .positive()
      .describe("most scheduled prompts a session may hold at once")
      .default(10),
  },
});
