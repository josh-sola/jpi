/**
 * Compact renderer for the "jpi-background-notification" custom message
 * type. monitor.ts sends one for every streamed event and one on a
 * monitor's terminal status; registry/completion.ts sends one for a plain
 * background task's completion — all three carry a snapshot (`MonitorSnapshot`
 * or `BgTaskSnapshot`) as `details`, but the message itself was never given a
 * renderer, so pi fell back to showing the full LLM-facing content (preamble,
 * monitor_id/task_id, output_path, "Use bg_logs..." instructions) in a padded
 * box. This collapses that to one line, mirroring
 * modules/subagents/notifications.ts's icon + bold label + dim status
 * convention. Display only — the LLM-facing message content is untouched.
 */

import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const BACKGROUND_NOTIFICATION_TYPE = "jpi-background-notification";

/**
 * Loose shape covering both snapshot variants this customType ever carries
 * (`MonitorSnapshot` uses `description`, `BgTaskSnapshot` uses `name`) — read
 * defensively since either can be malformed, partial, or missing entirely.
 */
export interface BackgroundNotificationDetails {
  readonly kind?: string;
  readonly id?: string;
  readonly description?: string;
  readonly name?: string;
  readonly status?: string;
  readonly exitCode?: number | null;
  readonly error?: string;
}

const FAILURE_STATUSES = new Set(["failed", "timeout", "cancelled"]);

/** `undefined` status renders no status segment at all; "exited" folds in the exit code the way the subagents renderer folds in duration/tokens. */
function statusText(
  status: string | undefined,
  exitCode: number | null | undefined,
): string | undefined {
  if (!status) return undefined;
  if (status !== "exited") return status;
  return exitCode !== undefined && exitCode !== null ? `completed · exit ${exitCode}` : "completed";
}

/** First non-empty line of a custom message's content, defensively — the fallback label when `details` carries neither `description` nor `name`. */
function firstContentLine(content: unknown): string {
  let text: unknown;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const block = content.find(
      (item): item is { type: string; text?: unknown } =>
        typeof item === "object" && item !== null && (item as { type?: unknown }).type === "text",
    );
    text = block?.text;
  }
  if (typeof text !== "string") return "";
  return text.split("\n").find((line) => line.trim().length > 0) ?? "";
}

/**
 * Renders a `✓ background: <label> · <status>` (or `✗ ...` for a failure
 * status) one-line summary. Never throws: any unexpected shape falls back to
 * the message's first content line, then a generic label.
 */
export const renderBackgroundNotification: MessageRenderer<BackgroundNotificationDetails> = (
  message,
  _options,
  theme,
) => {
  try {
    const details = message.details;
    const label =
      details?.description ||
      details?.name ||
      firstContentLine(message.content) ||
      "background task";
    const status = details?.status;
    const isError = status !== undefined && FAILURE_STATUSES.has(status);
    const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
    const statusPart = statusText(status, details?.exitCode);
    const line = statusPart
      ? `${icon} background: ${theme.bold(label)} ${theme.fg("dim", statusPart)}`
      : `${icon} background: ${theme.bold(label)}`;
    return new Text(line, 0, 0);
  } catch {
    return new Text("background: (unavailable)", 0, 0);
  }
};
