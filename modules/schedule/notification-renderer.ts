import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const SCHEDULE_NOTIFICATION_TYPE = "jpi-schedule-notification";

export interface ScheduleNotificationDetails {
  readonly id?: string;
  readonly cronExpression?: string;
}

/**
 * Collapses pi's default full-content box for this custom message type down
 * to a one-line `⧗ schedule: <id> · fired · <cron>` summary. Display only —
 * the LLM-visible message content is untouched. Never throws: any
 * unexpected shape falls back to a generic label.
 */
export const renderScheduleNotification: MessageRenderer<ScheduleNotificationDetails> = (
  message,
  _options,
  theme,
) => {
  try {
    const id = message.details?.id || "?";
    const cronExpression = message.details?.cronExpression;
    const status = cronExpression ? `· fired · ${cronExpression}` : "· fired";
    const icon = theme.fg("accent", "⧗");
    const line = `${icon} schedule: ${theme.bold(id)} ${theme.fg("dim", status)}`;
    return new Text(line, 0, 0);
  } catch {
    return new Text("schedule: (unavailable)", 0, 0);
  }
};
