import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { ModuleContext } from "../../src/core/index.ts";
import { askBtw, type BtwExchange, pushExchange, resolveAskModel } from "./ask.ts";
import type { btwSchema } from "./config.ts";
import { BTW_OVERLAY_MAX_HEIGHT_PCT, BtwOverlay, type BtwOverlayState } from "./overlay.ts";

export function registerBtw(pi: ExtensionAPI, ctx: ModuleContext<typeof btwSchema>): void {
  let ring: BtwExchange[] = [];
  let component: BtwOverlay | undefined;
  let controller: AbortController | undefined;
  let requestId = 0;
  let compacting = false;

  // A session switch mid-run isn't followed by any other lifecycle event, so
  // clear per-session state here too — otherwise a stale ring or a late
  // result from the old session could land in the new one.
  pi.on("session_start", () => {
    controller?.abort();
    controller = undefined;
    component = undefined;
    ring = [];
    compacting = false;
    requestId++;
  });

  // Compaction rewrites the session branch out from under a snapshot taken
  // mid-rewrite, so /btw refuses to ask while one is running.
  pi.on("session_before_compact", () => {
    compacting = true;
  });
  pi.on("session_compact", () => {
    compacting = false;
  });
  pi.on("session_compact_failed", () => {
    compacting = false;
  });

  function openOrUpdate(cmdCtx: ExtensionCommandContext, state: BtwOverlayState): void {
    if (component) {
      component.setState(state);
      return;
    }
    if (!cmdCtx.hasUI) return;

    void cmdCtx.ui
      .custom<undefined>(
        (tui, theme, keybindings, done) => {
          const overlay = new BtwOverlay(tui, theme, keybindings, state, (result) => {
            component = undefined;
            controller?.abort();
            done(result);
          });
          component = overlay;
          return overlay;
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "right-center",
            width: "38%",
            minWidth: 44,
            maxHeight: `${BTW_OVERLAY_MAX_HEIGHT_PCT}%`,
            margin: { right: 1, top: 1, bottom: 1 },
            visible: (width) => width >= 100,
          },
        },
      )
      .catch(() => {});
  }

  pi.registerCommand("btw", {
    description: "Ask a side question about this session without joining the conversation",
    handler: async (args, cmdCtx) => {
      const question = args.trim();

      if (!question) {
        const last = ring[ring.length - 1];
        if (!last) {
          cmdCtx.ui.notify("btw: usage is /btw <question>", "info");
          return;
        }
        openOrUpdate(cmdCtx, { status: "done", question: last.question, answer: last.answer });
        return;
      }

      if (compacting) {
        openOrUpdate(cmdCtx, { status: "error", question, message: "busy compacting — try again" });
        return;
      }

      // Snapshot everything the ask needs synchronously, before any await:
      // the branch this reads must be the one in force at dispatch time, not
      // whatever it has become by the time the config load or the floating
      // promise below gets to run.
      const sessionEntries = cmdCtx.sessionManager.buildContextEntries();
      const systemPrompt = cmdCtx.getSystemPrompt();
      const sessionId = cmdCtx.sessionManager.getSessionId();
      const priorExchanges = ring;

      const { value } = await ctx.config.load();
      const model = resolveAskModel(cmdCtx.modelRegistry, value.model, cmdCtx.model);
      if (!model) {
        cmdCtx.ui.notify(
          "btw: no model available — set btw.model in jpi.kdl or start a session with an active model.",
          "warning",
        );
        return;
      }

      controller?.abort();
      const localController = new AbortController();
      controller = localController;
      const id = ++requestId;

      openOrUpdate(cmdCtx, { status: "asking", question });

      // Pi awaits command handlers on the TUI submit path, so this must
      // return without awaiting the model call — otherwise /btw would stall
      // the editor until the answer (or its timeout) comes back.
      void (async () => {
        const result = await askBtw(
          {
            model,
            systemPrompt,
            sessionEntries,
            priorExchanges,
            question,
            sessionId,
            timeoutMs: value.timeoutMs,
            modelRegistry: cmdCtx.modelRegistry,
          },
          localController.signal,
        );

        if (id !== requestId) return;

        if ("answer" in result) {
          ring = pushExchange(ring, { question, answer: result.answer }, value.maxExchanges);
          component?.setState({ status: "done", question, answer: result.answer });
        } else {
          component?.setState({ status: "error", question, message: result.error });
        }
      })();
    },
  });
}
