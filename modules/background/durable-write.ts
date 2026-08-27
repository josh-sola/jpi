import { randomBytes } from "node:crypto";
import { open, rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Write JSON so a reader never observes a partial or missing file: write to a
 * sibling temp file, fsync it, rename over the target, then fsync the
 * directory so the rename itself survives a crash.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const dir = dirname(path);
  const tempPath = join(
    dir,
    `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  const data = `${JSON.stringify(value, null, 2)}\n`;

  const file = await open(tempPath, "w", 0o600);
  try {
    await file.writeFile(data, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }

  await rename(tempPath, path);

  const dirHandle = await open(dir, "r");
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}
