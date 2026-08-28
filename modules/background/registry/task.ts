import type { WriteStream } from "node:fs";

import type {
  BackgroundChildProcess,
  BgTaskSnapshot,
  KillKind,
  RunLanguage,
  TaskStatus,
} from "../registry.ts";

/** Internal, mutable state for one background task; `BgTaskSnapshot` is its read-only public projection. */
export interface BgTask {
  id: string;
  name: string;
  command: string;
  cwd: string;
  status: TaskStatus;
  outputPath: string;
  outputAbsPath: string;
  metadataAbsPath: string;
  startTime: number;
  endTime: number | undefined;
  exitCode: number | null | undefined;
  signal: string | null | undefined;
  pid: number | undefined;
  bytesWritten: number;
  capExceeded: boolean;
  killKind: KillKind | undefined;
  killSignalSent: boolean;
  killEscalationTimer: NodeJS.Timeout | undefined;
  timeoutHandle: NodeJS.Timeout | undefined;
  timeoutSeconds: number | undefined;
  wakeOnCompletion: boolean;
  notified: boolean;
  error: string | undefined;
  finalized: boolean;
  awaited: boolean;
  language: RunLanguage | undefined;
  stageDir: string | undefined;
  child: BackgroundChildProcess | undefined;
  stream: WriteStream | undefined;
  waiters: Array<() => void>;
  outputListeners: Set<(chunk: string, source: "stdout" | "stderr") => void>;
  metadataWriteChain: Promise<void> | undefined;
}

export function snapshot(task: BgTask): BgTaskSnapshot {
  return {
    kind: "task",
    id: task.id,
    name: task.name,
    command: task.command,
    cwd: task.cwd,
    status: task.status,
    outputPath: task.outputPath,
    startTime: task.startTime,
    endTime: task.endTime,
    exitCode: task.exitCode,
    signal: task.signal,
    pid: task.pid,
    bytesWritten: task.bytesWritten,
    error: task.error,
    notified: task.notified,
    wakeOnCompletion: task.wakeOnCompletion,
    timeoutSeconds: task.timeoutSeconds,
    killKind: task.killKind,
    ...(task.language !== undefined && { language: task.language }),
    ...(task.stageDir !== undefined && { stageDir: task.stageDir }),
  };
}

export function appendError(existing: string | undefined, next: string): string {
  if (!existing) return next;
  if (existing.includes(next)) return existing;
  return `${existing}; ${next}`;
}
