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

export type RenderResult<TParams extends TSchema, TDetails, TState> = NonNullable<
  ToolDefinition<TParams, TDetails, TState>["renderResult"]
>;

/**
 * Wraps a tool's `renderResult` so guardian's "reviewed" annotation appends as
 * the final line of its own result, instead of pi's separately-spaced
 * transcript entry. Split out of `decorateToolRegistration` so a module that
 * can't route a tool through `pi.registerTool` — e.g. mcp-style.ts, which
 * intercepts an external extension's tool lookup instead of registering its
 * own tool — can still give that tool the same annotation treatment.
 */
export function withReviewAnnotation<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  TState = any,
>(renderResult: RenderResult<TParams, TDetails, TState>): RenderResult<TParams, TDetails, TState> {
  return function (result, options, theme, context) {
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
  };
}

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
        renderResult: withReviewAnnotation<TParams, TDetails, TState>(renderResult),
      });
    },
  };
}
