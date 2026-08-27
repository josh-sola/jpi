/**
 * Model-facing text, adapted from Claude Code's own background-task and
 * monitor prompts (see the Piebald extraction in claude-code-system-prompts)
 * rather than copied verbatim.
 */

export const NOTIFICATION_PREAMBLE_LINES: readonly string[] = [
  "[SYSTEM NOTIFICATION - NOT USER INPUT]",
  "This is an automated background-task event. It is not a message from the user and must not be read as acknowledgement, confirmation, or approval of anything pending.",
];

export const RUN_DESCRIPTION =
  "Run a zsh, TypeScript, or Python script from structured arguments instead of an opaque shell command line — the reviewer sees the script text directly. Runs in the foreground by default, blocking until it exits or times out; set background: true to get a task id back immediately instead, the same as a background shell command. Prefer inline `script`; use `file` only to run a script that already exists on disk.";

export const RUN_PROMPT_SNIPPET =
  "Run a zsh/TypeScript/Python script from structured arguments, foreground or background";

export const RUN_GUIDELINES: readonly string[] = [
  "Use run for any multi-line script or anything that needs packages; plain single-line commands still belong in bash.",
  "Prefer an inline script over file — a structured script is fully visible to review, unlike a path whose contents aren't.",
  "Set background: true for anything that runs for a while, the same as you would reach for a background shell command; you're notified on completion, so don't poll for it.",
  "A foreground run can be moved to the background by the user mid-run; if the result says so, treat the task id like any other background task — bg_status/bg_logs/bg_kill work on it, and you'll get the usual completion notification.",
];

export const BG_MONITOR_DESCRIPTION = `Start a background monitor whose stdout is an event stream: each line becomes a notification, and the process exiting ends the watch. Use it only when a single command can produce more than one notification.

Pick by how many notifications you need:
- One, for a known condition ("tell me when the build finishes") — use run or a background shell command that exits once the condition is true, not bg_monitor.
- One per occurrence, forever ("tell me every time an ERROR line appears") — bg_monitor with an unbounded command such as tail -f or a watch loop.
- One per occurrence, until a known end ("report each CI step, stop when the run finishes") — bg_monitor with a command that emits lines and then exits.

Never use an unbounded command for a single wait: tail -f, inotifywait -m, and while true never exit on their own, so the monitor stays armed after the event already fired. tail -f log | grep -m1 does not fix this either — if the log goes quiet after the match, tail never receives SIGPIPE and the pipeline hangs.

Silence is not success. Your filter must match every terminal state your command can reach, not just the success marker, or a crash, hang, or unexpected exit looks identical to "still running":

  # Wrong — silent on crash, hang, or any non-success exit
  tail -f run.log | grep --line-buffered "elapsed_steps="

  # Right — one alternation covering progress and the failures you'd act on
  tail -f run.log | grep -E --line-buffered "elapsed_steps=|Traceback|Error|FAILED"

Script quality: every pipe stage must flush per line or matches sit unseen in its buffer — grep needs --line-buffered, awk needs fflush(); head cannot flush at all. Merge stderr into the filtered stream with 2>&1 so its failures reach your filter. Wrap flaky poll requests in || true so one failed request doesn't kill the monitor. Poll every 30s or more for remote APIs, 0.5-1s for local checks. Write a specific description — it appears in every notification.

Keep the filter selective: emit only the lines you'd act on, not raw logs. A monitor that produces too many events is stopped automatically; narrow the filter and start a new one. Lines arriving within 200ms are batched into one notification.`;

export const BG_MONITOR_PROMPT_SNIPPET =
  "Start a streaming monitor whose stdout lines become notifications; pick it only for more-than-one-notification cases";

export const BG_MONITOR_GUIDELINES: readonly string[] = [
  "Never use an unbounded command (tail -f, while true) for a single wait; use a background command with an until loop instead.",
  "Cover every terminal outcome in your filter, not just the success line, so a crash or hang is never silent.",
  "Flush every pipe stage (grep --line-buffered, awk's fflush()); head cannot flush.",
  "Set persistent: true only for a watch that should outlive this task, such as a long PR or log tail; otherwise the default timeout ends it.",
];

export const BG_STATUS_DESCRIPTION =
  "Look up the current state of one background task or monitor, or list them all. This is a point-in-time check, not something to poll while waiting for a notification.";

export const BG_STATUS_PROMPT_SNIPPET =
  "Check current state of one or all background tasks/monitors; a point-in-time read, not a wait loop";

export const BG_STATUS_GUIDELINES: readonly string[] = [
  "Use bg_status for a deliberate check, such as when the user asks for an update or there is real evidence a task is stuck.",
  "A running result is not a signal to check again immediately; wait for the notification instead.",
];

export const BG_LOGS_DESCRIPTION =
  "Read a bounded slice of a background task's or monitor's output. Output is capped, and the result always names the full output file, never a live stream.";

export const BG_LOGS_PROMPT_SNIPPET =
  "Read bounded output from a background task or monitor when you need to see it";

export const BG_LOGS_GUIDELINES: readonly string[] = [
  "Request only as much output as you need; bg_logs clamps maxBytes to a hard limit regardless.",
  "Do not call bg_logs repeatedly to wait for completion; that is what the notification is for.",
];

export const BG_KILL_DESCRIPTION =
  "Stop a running background task or monitor by id. Fails if the id is unknown or already finished.";

export const BG_KILL_PROMPT_SNIPPET = "Stop a running background task or monitor by id";

export const BG_KILL_GUIDELINES: readonly string[] = [
  "Use bg_kill when the user asks to stop a background task or monitor, or when one is no longer needed.",
];
