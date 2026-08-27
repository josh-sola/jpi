import { projectSlug, Store } from "../../src/core/index.ts";

import { capacityStatus, entryCount, INDEX_FILENAME, readMemoryIndex } from "./memory-index.ts";
import { getMemoryDirectory } from "./paths.ts";
import { buildMemorySection } from "./prompt.ts";

type NotifyLevel = "info" | "warning" | "error";

export type SessionStartContext = {
  cwd: string;
};

export type BeforeAgentStartEvent = {
  systemPrompt: string;
};

export type BeforeAgentStartContext = {
  cwd: string;
};

export type CommandContext = {
  cwd: string;
  ui: {
    notify(message: string, level?: NotifyLevel): void;
  };
};

export type MemoryExtension = {
  onSessionStart(event: unknown, ctx: SessionStartContext): Promise<void>;
  onBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: BeforeAgentStartContext,
  ): Promise<{ systemPrompt: string }>;
  onCommand(args: string, ctx: CommandContext): Promise<void>;
};

export type MemoryExtensionDeps = {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
};

function formatBytes(byteSize: number): string {
  return `${(byteSize / 1024).toFixed(1)}KB`;
}

export function createMemoryExtension(deps: MemoryExtensionDeps = {}): MemoryExtension {
  const env = deps.env ?? process.env;
  const homeDirectory = deps.homeDirectory;
  const store = new Store("memories", env, homeDirectory);

  const resolveMemoryDir = (cwd: string) => getMemoryDirectory(cwd, env, homeDirectory);

  return {
    async onSessionStart(_event, ctx) {
      await store.ensureDirectory(projectSlug(ctx.cwd));
    },

    async onBeforeAgentStart(event, ctx) {
      const slug = projectSlug(ctx.cwd);
      const memoryDir = resolveMemoryDir(ctx.cwd);
      const indexResult = await readMemoryIndex(store, slug);
      const byteSize = indexResult.missing ? 0 : Buffer.byteLength(indexResult.content, "utf8");
      const section = buildMemorySection(memoryDir, indexResult, capacityStatus(byteSize));
      return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
    },

    async onCommand(_args, ctx) {
      const slug = projectSlug(ctx.cwd);
      const memoryDir = resolveMemoryDir(ctx.cwd);
      const indexResult = await readMemoryIndex(store, slug);
      const exists = !indexResult.missing;
      const byteSize = exists ? Buffer.byteLength(indexResult.content, "utf8") : 0;
      const entries = exists ? entryCount(indexResult.content) : 0;
      const files = await store.list(slug);
      const memoryFileCount = files.filter(
        (name) => name.endsWith(".md") && name !== INDEX_FILENAME,
      ).length;
      const capacity = capacityStatus(byteSize);

      const lines = [
        `Memory directory: ${memoryDir}`,
        `Index (${INDEX_FILENAME}) exists: ${exists ? "yes" : "no"}`,
        `Index size: ${formatBytes(byteSize)}`,
        `Index entries: ${entries}`,
        `Memory files: ${memoryFileCount}`,
        `Capacity status: ${capacity}`,
      ];

      ctx.ui.notify(lines.join("\n"), capacity === "over" ? "warning" : "info");
    },
  };
}
