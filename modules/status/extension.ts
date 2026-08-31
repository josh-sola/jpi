import { homedir } from "node:os";

import type { EventBus } from "@earendil-works/pi-coding-agent";

import type {
  FocusAwareTui,
  FooterContext,
  MessageEventInput,
  SessionInfoChangedInput,
  ToolExecutionStartInput,
} from "../../src/pi/index.ts";
import {
  loadStatusLineConfig,
  toStatusLineConfig,
  type StatusConfigLike,
  type StatusConfigValue,
  type StatusLineConfig,
} from "./config.ts";
import {
  createCustomStatusPayload,
  CustomStatusController,
  type IntervalScheduler,
} from "./custom.ts";
import { loadRepositoryMetadata, type ExecCommand, type RepositoryMetadata } from "./data.ts";
import {
  FLEET_CONSUMER_READY_CHANNEL,
  FLEET_PROVIDER_CHANNEL,
  isFleetProviderPayload,
  type FleetProviderPayload,
} from "./fleet-bridge.ts";
import { renderFooter, type WidthHelpers } from "./ui/render.ts";
import { FooterStats } from "./stats.ts";

const REFRESH_INTERVAL_MS = 10_000;

type Scheduler = IntervalScheduler;

export type StatusExtension = {
  onSessionStart(event: unknown, context: FooterContext): Promise<void>;
  onCommand(args: string, context: FooterContext): Promise<void>;
  onSessionInfoChanged(event: SessionInfoChangedInput): void;
  onTurnEnd(): void;
  onMessageStart(event: MessageEventInput): void;
  onMessageUpdate(event: MessageEventInput): void;
  onMessageEnd(event: MessageEventInput): void;
  onToolExecutionStart(event: ToolExecutionStartInput): void;
  onToolExecutionEnd(): void;
};

type ControllerOptions = {
  exec: ExecCommand;
  cwd: string;
  requestRender(): void;
  onBranchChange(callback: () => void): () => void;
  scheduler: Scheduler;
  onDispose(): void;
};

export class RepositoryMetadataController {
  metadata: RepositoryMetadata = {};

  private readonly options: ControllerOptions;
  private generation = 0;
  private pending = false;
  private disposed = false;
  private drainPromise?: Promise<void> | undefined;
  private abortController?: AbortController | undefined;
  private unsubscribe?: () => void;
  private timer?: ReturnType<typeof setInterval>;

  constructor(options: ControllerOptions) {
    this.options = options;
  }

  start(): void {
    this.unsubscribe = this.options.onBranchChange(() => {
      this.options.requestRender();
      void this.refresh();
    });
    this.timer = this.options.scheduler.setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.generation += 1;
    this.pending = true;
    if (!this.drainPromise) {
      this.drainPromise = this.drain().finally(() => {
        this.drainPromise = undefined;
      });
    }
    return this.drainPromise;
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.disposed) {
      this.pending = false;
      const generation = this.generation;
      const abortController = new AbortController();
      this.abortController = abortController;
      const metadata = await loadRepositoryMetadata(
        this.options.exec,
        this.options.cwd,
        abortController.signal,
      );
      if (!this.disposed && generation === this.generation) {
        this.metadata = metadata;
        this.options.requestRender();
      }
    }
    this.abortController = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.pending = false;
    this.abortController?.abort();
    this.unsubscribe?.();
    if (this.timer !== undefined) this.options.scheduler.clearInterval(this.timer);
    this.options.onDispose();
  }
}

/** Used when no event bus is supplied — the footer then behaves as if jpi-subagents were never installed. */
const noopEventBus: EventBus = { on: () => () => {}, emit: () => {} };

export function createStatusExtension(
  exec: ExecCommand,
  helpers: WidthHelpers,
  scheduler: Scheduler,
  statusConfig: StatusConfigLike,
  initialValue: StatusConfigValue,
  events: EventBus = noopEventBus,
): StatusExtension {
  const stats = new FooterStats();
  let activeController: RepositoryMetadataController | undefined;
  let activeCustomController: CustomStatusController | undefined;

  // The loader already loaded the config once (and surfaces plain decode
  // issues itself); only the extra component-id check below is genuinely new
  // information, so it's the only thing worth re-notifying on session start.
  const initial = toStatusLineConfig(initialValue);
  let statusLineConfig: StatusLineConfig = initial.config;
  const initialProblem = initial.problem;
  let requestFooterRender: (() => void) | undefined;

  const reloadConfig = async (context: FooterContext, announce: boolean): Promise<void> => {
    const result = await loadStatusLineConfig(statusConfig);
    statusLineConfig = result.config;
    if (activeCustomController) {
      await activeCustomController.updateFormat(statusLineConfig.format);
    } else if (announce) {
      requestFooterRender?.();
    }

    if (result.problem) {
      context.ui.notify(
        `Could not load jpi-status config at ${result.path}: ${result.issues.join("; ")}. Using the default config.`,
        "warning",
      );
      return;
    }

    if (result.issues.length > 0) {
      context.ui.notify(
        `jpi-status config at ${result.path} has issues: ${result.issues.join("; ")}.`,
        "warning",
      );
      return;
    }

    if (announce) context.ui.notify("jpi-status config reloaded.", "info");
  };

  return {
    async onSessionStart(_event, context) {
      if (context.mode !== "tui") return;
      stats.onSessionStart(context);
      if (initialProblem) {
        context.ui.notify(
          `Could not load jpi-status config at ${statusConfig.path}: ${initialProblem}. Using the default config.`,
          "warning",
        );
      }
      context.ui.setFooter((tui, theme, footerData) => {
        const renderFooterNow = () => tui.requestRender();
        let fleetProvider: FleetProviderPayload | undefined;
        let fleetDetach: (() => void) | undefined;
        const unsubscribeFleetProvider = events.on(FLEET_PROVIDER_CHANNEL, (data) => {
          if (!isFleetProviderPayload(data)) return;
          fleetDetach?.();
          fleetProvider = data;
          fleetDetach = data.attach({
            requestRender: renderFooterNow,
            getFocusedComponent: () => (tui as FocusAwareTui).getFocusedComponent?.(),
          });
        });
        events.emit(FLEET_CONSUMER_READY_CHANNEL, { schema: "subagents.fleet.consumer-ready.v1" });
        let controller: RepositoryMetadataController;
        controller = new RepositoryMetadataController({
          exec,
          cwd: context.cwd,
          requestRender: renderFooterNow,
          onBranchChange: (callback) => footerData.onBranchChange(callback),
          scheduler,
          onDispose: () => {
            if (activeController === controller) activeController = undefined;
            if (requestFooterRender === renderFooterNow) requestFooterRender = undefined;
          },
        });
        const customController = new CustomStatusController({
          exec,
          format: statusLineConfig.format,
          configPath: statusConfig.path,
          getPayload: () =>
            createCustomStatusPayload(
              context,
              controller.metadata,
              footerData.getExtensionStatuses(),
            ),
          requestRender: renderFooterNow,
          notify: (message, level) => context.ui.notify(message, level),
          scheduler,
        });
        activeController = controller;
        activeCustomController = customController;
        requestFooterRender = renderFooterNow;
        controller.start();
        void customController.start();

        return {
          invalidate() {},
          render(width) {
            const usage = context.getContextUsage();
            const percent = usage?.percent;
            const contextWindow = usage?.contextWindow ?? context.model?.contextWindow ?? undefined;
            const contextTokens = usage?.tokens ?? undefined;
            const statsSnapshot = stats.snapshot();
            const statusRows = renderFooter(
              {
                modelName: context.model?.name || context.model?.id || "no model",
                contextPercent: percent === null ? undefined : percent,
                contextWindow,
                contextTokens,
                sessionName: statsSnapshot.sessionName ?? undefined,
                turnCount: statsSnapshot.turnCount,
                liveSpeed: statsSnapshot.liveSpeed ?? undefined,
                cost: statsSnapshot.cost,
                tokensIn: statsSnapshot.tokensIn,
                tokensOut: statsSnapshot.tokensOut,
                cacheRead: statsSnapshot.cacheRead,
                cacheWrite: statsSnapshot.cacheWrite,
                activeToolName: statsSnapshot.activeToolName ?? undefined,
                cwd: context.cwd,
                homeDirectory: homedir(),
                repository: controller.metadata,
                statuses: footerData.getExtensionStatuses(),
                customOutputs: customController.outputs,
                config: statusLineConfig,
              },
              width,
              helpers,
            );
            let fleetRows: string[] = [];
            if (fleetProvider) {
              try {
                fleetRows = fleetProvider.render(width, theme);
              } catch {
                // A broken provider costs only its own rows, never the footer.
                fleetRows = [];
              }
            }
            return [...statusRows, ...fleetRows];
          },
          dispose: () => {
            unsubscribeFleetProvider();
            fleetDetach?.();
            customController.dispose();
            if (activeCustomController === customController) activeCustomController = undefined;
            controller.dispose();
          },
        };
      });
    },

    async onCommand(args, context) {
      const action = args.trim() || "status";
      if (action === "status") {
        context.ui.notify(
          activeController ? "jpi-status footer is active." : "jpi-status footer is not active.",
          "info",
        );
        return;
      }
      if (action === "refresh") {
        if (!activeController) {
          context.ui.notify("jpi-status footer is not active.", "warning");
          return;
        }
        void activeController.refresh();
        context.ui.notify("jpi-status metadata refresh requested.", "info");
        return;
      }
      if (action === "reload") {
        await reloadConfig(context, true);
        return;
      }
      context.ui.notify("Usage: /jpi-status [status|refresh|reload]", "warning");
    },

    onSessionInfoChanged(event) {
      stats.onSessionInfoChanged(event);
      requestFooterRender?.();
    },

    onTurnEnd() {
      stats.onTurnEnd();
      requestFooterRender?.();
    },

    onMessageStart(event) {
      stats.onMessageStart(event);
    },

    onMessageUpdate(event) {
      // Pi already repaints while an assistant message streams, so this
      // updates the sampled speed without requesting a render of its own.
      stats.onMessageUpdate(event);
    },

    onMessageEnd(event) {
      stats.onMessageEnd(event);
      requestFooterRender?.();
    },

    onToolExecutionStart(event) {
      stats.onToolExecutionStart(event);
      requestFooterRender?.();
    },

    onToolExecutionEnd() {
      stats.onToolExecutionEnd();
      requestFooterRender?.();
    },
  };
}
