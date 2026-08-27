import { scratchpadDir, scratchpadRoot } from "../../src/core/index.ts";

import { buildScratchpadSection, ensureScratchpadDir, sweepStale } from "./scratchpad.ts";

export type SessionStartEvent = {
  reason: "startup" | "reload" | "new" | "resume" | "fork";
};

export type BeforeAgentStartEvent = {
  systemPrompt: string;
};

export type ScratchpadExtensionContext = {
  cwd: string;
  sessionManager: { getSessionId(): string };
};

export type ScratchpadExtension = {
  onSessionStart(event: SessionStartEvent, ctx: ScratchpadExtensionContext): Promise<void>;
  onBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ScratchpadExtensionContext,
  ): Promise<{ systemPrompt: string }>;
};

export type ScratchpadExtensionDeps = {
  ttlDays: number;
  tempRoot?: string;
  now?: () => number;
};

export function createScratchpadExtension(deps: ScratchpadExtensionDeps): ScratchpadExtension {
  const tempRoot = deps.tempRoot;
  const now = deps.now ?? Date.now;

  const resolveDir = (ctx: ScratchpadExtensionContext) =>
    scratchpadDir(ctx.cwd, ctx.sessionManager.getSessionId(), tempRoot);

  return {
    async onSessionStart(_event, ctx) {
      const dir = resolveDir(ctx);
      await ensureScratchpadDir(dir);
      await sweepStale(scratchpadRoot(tempRoot), deps.ttlDays, now(), dir);
    },

    async onBeforeAgentStart(event, ctx) {
      // The session id can change across new/resume/fork, so re-ensure the
      // dir rather than trusting the one session_start already created.
      const dir = resolveDir(ctx);
      await ensureScratchpadDir(dir);

      const section = buildScratchpadSection(dir);
      return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
    },
  };
}
