import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The exclusive-create flag makes the missing-file check and the write
 * atomic, so a file that already exists is never touched.
 */
export async function seedIfMissing(targetPath: string, defaultContent: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await writeFile(targetPath, defaultContent, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }
}
