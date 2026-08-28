/**
 * Wraps `pi.registerTool` so guardian's "⛨ reviewed" annotation is wired in
 * automatically for any tool with a `renderResult`, instead of every module
 * marking itself as a consumer and calling a render helper by hand. A tool
 * with no `renderResult` passes through unclaimed — guardian falls back to
 * its own transcript entry for those.
 */

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";

import {
  formatReviewDuration,
  getReviewAnnotation,
  markReviewAnnotationConsumer,
  onReviewAnnotation,
} from "./review-annotations.ts";

/** Returns an `ExtensionAPI` handle identical to `pi` except for `registerTool`. */
export function decorateToolRegistration(pi: ExtensionAPI): ExtensionAPI {
  return {
    ...pi,
    registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = any>(
      def: ToolDefinition<TParams, TDetails, TState>,
    ): void {
      const renderResult = def.renderResult;
      if (!renderResult) {
        pi.registerTool(def);
        return;
      }

      markReviewAnnotationConsumer([def.name]);
      pi.registerTool({
        ...def,
        renderResult(result, options, theme, context) {
          const component = renderResult(result, options, theme, context);
          if (options.isPartial) return component;

          const container = new Container();
          container.addChild(component);
          const annotation = getReviewAnnotation(context.toolCallId);
          if (annotation) {
            container.addChild(
              new Text(
                `  ${theme.fg("dim", `⛨ reviewed · ${formatReviewDuration(annotation.durationMs)}`)}`,
                0,
                0,
              ),
            );
          } else {
            onReviewAnnotation(context.toolCallId, () => context.invalidate());
          }
          return container;
        },
      });
    },
  };
}
