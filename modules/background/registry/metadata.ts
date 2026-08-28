import { writeJsonAtomic } from "../../../src/core/index.ts";
import type { BgTaskSnapshot } from "../registry.ts";
import type { BgTask } from "./task.ts";

function noop(): void {
  return undefined;
}

/**
 * Persists a task's metadata snapshot atomically, one write at a time per
 * task: each write is chained onto the previous one (success or failure)
 * so two overlapping writes for the same task can never race on disk.
 */
export class TaskMetadataWriter {
  async write(task: BgTask, value: BgTaskSnapshot): Promise<void> {
    const previous = task.metadataWriteChain ?? Promise.resolve();
    const write = () => writeJsonAtomic(task.metadataAbsPath, value);
    const next = previous.then(write, write);
    task.metadataWriteChain = next.catch(noop);
    await next;
  }
}
