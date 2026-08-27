import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ModuleContext } from "../../src/core/index.ts";
import type { historySchema } from "./config.ts";
import { HistoryEditor } from "./editor.ts";
import { PromptPicker } from "./picker.ts";
import { generateSuggestion, parseModel, type PiModel } from "./suggest.ts";
import { appendPrompt, readPrompts, trimLog } from "./store.ts";

const MAX_SEEDED_PROMPTS = 100;

async function openPicker(ctx: ExtensionContext): Promise<void> {
  const entries = await readPrompts();

  const text = await ctx.ui.custom<string | undefined>(
    (_tui, theme, keybindings, done) => new PromptPicker(theme, keybindings, entries, done),
    { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "70%" } },
  );
  if (text !== undefined) {
    ctx.ui.setEditorText(text);
  }
}

/** Undefined means the model spec is unset, unknown, or unauthenticated — suggestions stay off. */
function resolveSuggestModel(ctx: ExtensionContext, spec: string): PiModel | undefined {
  const parsed = parseModel(spec);
  const model = parsed && ctx.modelRegistry.find(parsed.provider, parsed.modelId);
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
  return model;
}

interface SuggestState {
  ctx: ExtensionContext;
  model: PiModel;
  timeoutMs: number;
  sessionId: string;
}

export function registerHistory(pi: ExtensionAPI, ctx: ModuleContext<typeof historySchema>): void {
  let editor: HistoryEditor | undefined;

  // Reread per session_start (config and auth can change between sessions in
  // the same process), but agent_settled/agent_start are registered once
  // below — session_start can fire again on a session switch, and
  // re-registering them there would stack duplicate handlers.
  let suggestState: SuggestState | undefined;
  let controller: AbortController | undefined;
  let requestId = 0;

  pi.on("session_start", async (_event, sessionCtx) => {
    if (!sessionCtx.hasUI) return;

    const { value } = await ctx.config.load();

    // A session switch mid-run isn't followed by agent_start, so bump the id
    // here too — otherwise a late suggestion from the old session could land
    // in the new one once its abort settles.
    controller?.abort();
    controller = undefined;
    requestId++;

    const model = value.suggest.enabled
      ? resolveSuggestModel(sessionCtx, value.suggest.model)
      : undefined;
    if (value.suggest.enabled && model === undefined) {
      sessionCtx.ui.notify(
        `history: suggest.model "${value.suggest.model}" is unavailable or unauthenticated; ghost-text suggestions are off for this session.`,
        "warning",
      );
    }
    suggestState =
      model === undefined
        ? undefined
        : { ctx: sessionCtx, model, timeoutMs: value.suggest.timeoutMs, sessionId: randomUUID() };

    const dim = (text: string) => sessionCtx.ui.theme.fg("dim", text);

    sessionCtx.ui.setEditorComponent((tui, theme, keybindings) => {
      const instance = new HistoryEditor(tui, theme, keybindings);
      if (suggestState) instance.dim = dim;
      instance.onHistorySearch = () => {
        void openPicker(sessionCtx).catch(() => {});
      };
      instance.onPromptRecorded = (text) => {
        void appendPrompt({ text, timestamp: new Date().toISOString(), cwd: sessionCtx.cwd }).catch(
          () => {},
        );
        editor?.clearGhostText();
      };
      editor = instance;
      return instance;
    });

    // Don't block session start on the log read. Errors here must never
    // break the session — up-arrow just falls back to session-local history.
    void readPrompts()
      .then((prompts) => {
        const seedTexts = prompts
          .slice(0, MAX_SEEDED_PROMPTS)
          .map((prompt) => prompt.text)
          .reverse();
        editor?.seedHistory(seedTexts);
        void trimLog(value.maxSize).catch(() => {});
      })
      .catch(() => {});
  });

  pi.on("agent_settled", (_event, eventCtx) => {
    const state = suggestState;
    if (!state) return;

    controller?.abort();
    const localController = new AbortController();
    controller = localController;
    const id = ++requestId;

    // Pi awaits extension handlers in load order, so this must return
    // without awaiting the model call — otherwise every settle stalls event
    // dispatch for up to timeoutMs. generateSuggestion never throws.
    const signals = [
      localController.signal,
      AbortSignal.timeout(state.timeoutMs),
      eventCtx.signal,
    ].filter((s): s is AbortSignal => s !== undefined);
    const signal = AbortSignal.any(signals);

    void (async () => {
      const suggestion = await generateSuggestion(
        {
          model: state.model,
          transcriptEntries: state.ctx.sessionManager.getBranch(),
          timeoutMs: state.timeoutMs,
          sessionId: state.sessionId,
          modelRegistry: state.ctx.modelRegistry,
        },
        signal,
      );

      if (id !== requestId || !suggestion) return;
      editor?.setGhostText(suggestion);
    })();
  });

  pi.on("agent_start", () => {
    controller?.abort();
    requestId++;
    editor?.clearGhostText();
  });
}
