import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";

import { errorMessage } from "./errors.ts";
import { getAgentDirectory } from "../pi/index.ts";

export type StoreReadResult = { value: unknown } | { missing: true } | { problem: string };
export type StoreTextReadResult = { value: string } | { missing: true } | { problem: string };
export type StoreRemoveResult = { problem: string } | undefined;

// The one character class a Store path segment may contain — NAME_PATTERN
// validates it, sanitizeStoreSegment() below replaces anything outside it.
const SEGMENT_CHARS = "A-Za-z0-9._-";
const NAME_PATTERN = new RegExp(`^[${SEGMENT_CHARS}]+$`);
const INVALID_SEGMENT_CHARS = new RegExp(`[^${SEGMENT_CHARS}]`, "g");

function assertValidName(kind: "extension" | "file", name: string): void {
  if (name.startsWith(".") || !NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid ${kind} name "${name}": must match ${NAME_PATTERN} and not start with a dot`,
    );
  }
}

/** Replaces every character outside a Store path segment's allowed class with "-". */
export function sanitizeStoreSegment(raw: string): string {
  return raw.replace(INVALID_SEGMENT_CHARS, "-");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

/**
 * Reads and writes one plugin's private JSON and text state under the shared
 * jpi agent directory, namespaced by extension so plugins can't collide.
 */
export class Store {
  readonly #directory: string;

  constructor(
    extension: string,
    env: NodeJS.ProcessEnv = process.env,
    homeDirectory: string = homedir(),
  ) {
    assertValidName("extension", extension);
    this.#directory = join(getAgentDirectory(env, homeDirectory), "jpi", extension);
  }

  path(file: string): string {
    const segments = file.split("/");
    for (const segment of segments) {
      assertValidName("file", segment);
    }
    return join(this.#directory, ...segments);
  }

  async read(file: string): Promise<StoreReadResult> {
    const path = this.path(file);
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return { missing: true };
      }
      const message = errorMessage(error);
      return { problem: `could not read state: ${message}` };
    }

    try {
      return { value: JSON.parse(text) };
    } catch (error) {
      const message = errorMessage(error);
      return { problem: `invalid JSON: ${message}` };
    }
  }

  async write(file: string, value: unknown): Promise<void> {
    await this.#writeAtomic(this.path(file), `${JSON.stringify(value, null, 2)}\n`);
  }

  async readText(file: string): Promise<StoreTextReadResult> {
    const path = this.path(file);
    try {
      return { value: await readFile(path, "utf8") };
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return { missing: true };
      }
      const message = errorMessage(error);
      return { problem: `could not read state: ${message}` };
    }
  }

  async writeText(file: string, text: string): Promise<void> {
    await this.#writeAtomic(this.path(file), text);
  }

  async ensureDirectory(dir: string): Promise<string> {
    const path = this.path(dir);
    await mkdir(path, { recursive: true });
    return path;
  }

  async list(dir: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.path(dir));
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return entries.filter((entry) => !entry.startsWith("."));
  }

  async #writeAtomic(path: string, data: string): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });

    const tempPath = join(directory, `.${randomUUID()}.tmp`);
    await writeFile(tempPath, data, "utf8");
    try {
      await rename(tempPath, path);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  async remove(file: string): Promise<StoreRemoveResult> {
    const path = this.path(file);
    try {
      await unlink(path);
      return undefined;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return undefined;
      }
      const message = errorMessage(error);
      return { problem: `could not remove state: ${message}` };
    }
  }
}
