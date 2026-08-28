import { BACKGROUND_NOTIFICATION_TYPE } from "../notification-renderer.ts";
import { NOTIFICATION_PREAMBLE_LINES } from "../prompts.ts";
import type { CompletionNotificationSender } from "../registry.ts";
import { snapshot, type BgTask } from "./task.ts";

export const DEFAULT_MAX_RECENT_TASKS = 20;

function buildNotificationContent(task: BgTask, outputTail: string): string {
  const lines = [
    ...NOTIFICATION_PREAMBLE_LINES,
    `task_id: ${task.id}`,
    `name: ${task.name}`,
    `status: ${task.status}`,
  ];
  if (task.exitCode !== undefined && task.exitCode !== null)
    lines.push(`exit_code: ${task.exitCode}`);
  if (task.error) lines.push(`error: ${task.error}`);
  lines.push(`output_path: ${task.outputPath}`);
  lines.push("output_tail:", outputTail.length > 0 ? outputTail : "(no output)");
  lines.push("Use bg_logs to read more output if needed. Do not poll for status.");
  return lines.join("\n");
}

/** Sends a task's completion wake through the injected sender. */
export class TaskCompletionNotifier {
  constructor(private readonly sendNotification: CompletionNotificationSender) {}

  /** Sends at most once per task; resets the flag and rethrows if the sender fails. */
  notify(task: BgTask, outputTail: string): void {
    if (!task.wakeOnCompletion || task.notified || task.awaited) return;
    task.notified = true;
    const content = buildNotificationContent(task, outputTail);
    try {
      this.sendNotification(
        {
          customType: BACKGROUND_NOTIFICATION_TYPE,
          content,
          display: true,
          details: snapshot(task),
        },
        { deliverAs: "followUp", triggerTurn: task.wakeOnCompletion },
      );
    } catch (error) {
      task.notified = false;
      throw error;
    }
  }
}

/** Evicts the oldest finished tasks once `tasks` exceeds `maxRecentTasks`; running tasks are never evicted. */
export function pruneOldTasks(tasks: Map<string, BgTask>, maxRecentTasks: number): void {
  if (tasks.size <= maxRecentTasks) return;
  const finished = [...tasks.values()]
    .filter((task) => task.status !== "running")
    .sort((a, b) => (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime));
  while (tasks.size > maxRecentTasks && finished.length > 0) {
    const task = finished.shift();
    if (task) tasks.delete(task.id);
  }
}
