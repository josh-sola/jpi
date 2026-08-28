import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";

import { errorMessage } from "../../../src/core/index.ts";
import type { ReadOutputOptions, ReadOutputResult } from "../registry.ts";
import { appendError, type BgTask } from "./task.ts";

export const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
export const MIN_LOG_BYTES = 1;
export const MAX_LOG_BYTES = 50 * 1024;

export interface TaskOutputStreamHooks {
  /** The output file itself failed to accept writes; task.error/killKind are already set. */
  onWriteError(task: BgTask): void;
  /** The task's output has been truncated at the configured cap; task.error/killKind are already set. */
  onCapExceeded(task: BgTask): void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function clampMaxBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_LOG_BYTES;
  return Math.max(MIN_LOG_BYTES, Math.min(MAX_LOG_BYTES, Math.floor(value)));
}

function closeOutputStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      stream.off("error", fail);
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.off("close", finish);
      reject(error);
    };
    stream.once("close", finish);
    stream.once("error", fail);
    stream.end();
  });
}

async function boundedRead(
  filePath: string,
  maxBytes: number,
  tail: boolean,
): Promise<{ content: string; truncated: boolean; bytesRead: number; totalBytes: number }> {
  const stats = await stat(filePath);
  const totalBytes = stats.size;
  const bytesToRead = Math.min(totalBytes, maxBytes);
  if (bytesToRead === 0) return { content: "", truncated: false, bytesRead: 0, totalBytes };

  const file = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const position = tail ? Math.max(0, totalBytes - bytesToRead) : 0;
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: totalBytes > bytesRead,
      bytesRead,
      totalBytes,
    };
  } finally {
    await file.close();
  }
}

/**
 * Owns a task's durable output file: the write stream, the hard byte cap,
 * and bounded reads back off it. Kill decisions on failure/cap-breach are
 * left to the registry via hooks — this class only detects and records them.
 */
export class TaskOutputStream {
  private maxOutputBytes: number;

  constructor(
    private readonly hooks: TaskOutputStreamHooks,
    maxOutputBytes: number,
  ) {
    this.maxOutputBytes = maxOutputBytes;
  }

  configure(maxOutputBytes: number): void {
    this.maxOutputBytes = maxOutputBytes;
  }

  open(task: BgTask, outputAbsPath: string): WriteStream {
    const stream = createWriteStream(outputAbsPath, { flags: "a" });
    stream.on("error", (error) => {
      if (task.status !== "running") return;
      task.error = appendError(task.error, `output file write failed: ${errorMessage(error)}`);
      task.killKind = task.killKind ?? "write_error";
      this.hooks.onWriteError(task);
    });
    return stream;
  }

  handleChildOutput(task: BgTask, chunk: Buffer, source: "stdout" | "stderr"): void {
    if (chunk.length === 0) return;
    if (task.outputListeners.size > 0) {
      const text = chunk.toString("utf8");
      for (const listener of task.outputListeners) listener(text, source);
    }
    this.writeToStream(task, chunk);
  }

  writeNotice(task: BgTask, text: string): void {
    this.writeToStream(task, Buffer.from(text, "utf8"));
  }

  private writeToStream(task: BgTask, buffer: Buffer): void {
    if (!task.stream || task.stream.destroyed || buffer.length === 0) return;

    const nextBytes = task.bytesWritten + buffer.length;
    if (nextBytes <= this.maxOutputBytes) {
      task.stream.write(buffer);
      task.bytesWritten = nextBytes;
      return;
    }

    const remaining = Math.max(0, this.maxOutputBytes - task.bytesWritten);
    if (remaining > 0) {
      task.stream.write(buffer.subarray(0, remaining));
      task.bytesWritten += remaining;
    }

    if (task.capExceeded) return;
    task.capExceeded = true;
    task.error = `Output exceeded the ${formatBytes(this.maxOutputBytes)} cap; task was killed`;
    const notice = `\n[background task output cap: ${task.error}]\n`;
    task.stream.write(notice);
    task.bytesWritten += Buffer.byteLength(notice, "utf8");
    task.killKind = "output_cap";
    this.hooks.onCapExceeded(task);
  }

  close(stream: WriteStream): Promise<void> {
    return closeOutputStream(stream);
  }

  /** Best-effort raw tail read, e.g. for a completion notification; callers decide how to handle a failure. */
  async tail(outputAbsPath: string, maxBytes: number): Promise<string> {
    const read = await boundedRead(outputAbsPath, maxBytes, true);
    return read.content;
  }

  async readOutput(task: BgTask, options: ReadOutputOptions = {}): Promise<ReadOutputResult> {
    const tail = options.tail ?? true;
    const maxBytes = clampMaxBytes(options.maxBytes);

    if (!existsSync(task.outputAbsPath)) {
      return {
        text: "(no output yet)",
        truncated: false,
        bytesRead: 0,
        totalBytes: 0,
        outputPath: task.outputPath,
      };
    }

    const read = await boundedRead(task.outputAbsPath, maxBytes, tail);
    let text = read.content.length > 0 ? read.content : "(no output yet)";
    if (read.truncated) {
      const omitted = read.totalBytes - read.bytesRead;
      const direction = tail ? "tail" : "head";
      const notice = `[Showing ${direction} ${read.bytesRead} of ${read.totalBytes} bytes; ${omitted} omitted. Full output: ${task.outputPath}]`;
      text = tail ? `${notice}\n${text}` : `${text}\n${notice}`;
    } else {
      text += `\n[Full output: ${task.outputPath}]`;
    }

    return {
      text,
      truncated: read.truncated,
      bytesRead: read.bytesRead,
      totalBytes: read.totalBytes,
      outputPath: task.outputPath,
    };
  }
}
