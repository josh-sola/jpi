export const SCHEDULE_NOTIFICATION_PREAMBLE_LINES: readonly string[] = [
  "[SYSTEM NOTIFICATION - NOT USER INPUT]",
  "This is a scheduled prompt the user set up earlier, delivered automatically now that its cron schedule fired. Act on it as instructed, but its presence is not live user approval of anything pending.",
];

export const SCHEDULE_DESCRIPTION =
  'Create a scheduled prompt that fires on a cron expression and injects the prompt text into this session\'s chat when it fires. Accepts 5-field (minute precision) or 6-field (leading seconds column) cron, with */n step support in every field — e.g. "every 5 minutes" is "*/5 * * * *", "every 30 seconds" is "*/30 * * * * *".';

export const SCHEDULE_PROMPT_SNIPPET =
  "Schedule a prompt to fire later on a cron expression, injected into this session's chat";

export const SCHEDULE_GUIDELINES: readonly string[] = [
  'Use a step ("*/n") for a simple repeating cadence instead of reasoning about it by hand: "*/5 * * * *" is every 5 minutes, "*/30 * * * * *" (6-field) is every 30 seconds.',
  "Schedules are scoped to this session: they survive compaction and /reload, and re-arm when this session is resumed, but never appear in a different session.",
  'There is no one-shot "run once at 3pm" mode; stop the schedule with stop_schedule once it has served its purpose.',
];

export const LIST_SCHEDULES_DESCRIPTION =
  "List every scheduled prompt for this session: id, cron expression, next run, run count, and a preview of the prompt text.";

export const LIST_SCHEDULES_PROMPT_SNIPPET = "List this session's scheduled prompts";

export const STOP_SCHEDULE_DESCRIPTION =
  "Stop a scheduled prompt by id, or an unambiguous prefix of one. Fails if the id is unknown or ambiguous.";

export const STOP_SCHEDULE_PROMPT_SNIPPET = "Stop a scheduled prompt by id or unambiguous prefix";
