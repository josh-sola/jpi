import { AssistantMessageComponent, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { errorMessage } from "./errors.ts";

export type AssistantMessageThemeResolver = () => Theme | undefined;

interface MarkdownLike {
  defaultTextStyle?: { italic?: unknown };
  paddingX?: unknown;
  render(width: number): string[];
  invalidate(): void;
}

interface ContentContainerLike {
  children?: unknown[];
}

interface MouseRegionLike {
  child: unknown;
}

interface AssistantMessageComponentLike {
  contentContainer?: ContentContainerLike;
  isStreaming?: boolean;
}

interface TimingState {
  timestamp: number;
  isStreaming: boolean;
  frozenSeconds?: number;
}

const timings = new WeakMap<object, TimingState>();
let themeResolver: AssistantMessageThemeResolver | undefined;
let patched = false;

function elapsedSeconds(timestamp: number): number {
  return Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
}

function timingFor(
  component: object,
  message: AssistantMessage,
  isStreaming: boolean,
): TimingState {
  const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
  let timing = timings.get(component);
  if (!timing || timing.timestamp !== timestamp) {
    timing = { timestamp, isStreaming: false };
    timings.set(component, timing);
  }

  if (isStreaming) {
    timing.isStreaming = true;
    delete timing.frozenSeconds;
  } else {
    timing.frozenSeconds = timing.isStreaming
      ? elapsedSeconds(timestamp)
      : (timing.frozenSeconds ?? 0);
    timing.isStreaming = false;
  }

  return timing;
}

function resolvedTheme(): Theme | undefined {
  try {
    return themeResolver?.();
  } catch {
    return undefined;
  }
}

function header(seconds: number, theme: Theme | undefined): string {
  if (!theme) return `⏺ Thinking (${seconds} seconds)`;
  return `${theme.fg("accent", "⏺")} ${theme.bold("Thinking")}${theme.fg("muted", ` (${seconds} seconds)`)}`;
}

function treePrefix(first: boolean, theme: Theme | undefined): string {
  const prefix = first ? "  ⎿  " : "     ";
  return theme ? theme.fg("dim", prefix) : prefix;
}

function isThinkingMarkdown(child: unknown): child is MarkdownLike {
  if (!child || typeof child !== "object") return false;
  const markdown = child as Partial<MarkdownLike>;
  return (
    markdown.defaultTextStyle?.italic === true &&
    typeof markdown.render === "function" &&
    typeof markdown.invalidate === "function"
  );
}

function isMouseRegion(child: unknown): child is MouseRegionLike {
  return !!child && typeof child === "object" && "child" in child;
}

class ThinkingBlockComponent extends Container {
  constructor(
    private readonly markdown: MarkdownLike,
    private readonly timing: TimingState,
  ) {
    super();
    this.addChild(markdown);
  }

  override render(width: number): string[] {
    const availableWidth = Math.max(0, width);
    const theme = resolvedTheme();
    const seconds = this.timing.isStreaming
      ? elapsedSeconds(this.timing.timestamp)
      : (this.timing.frozenSeconds ?? 0);
    const lines = [truncateToWidth(header(seconds, theme), availableWidth)];
    const firstPrefix = treePrefix(true, theme);
    const contentWidth = Math.max(0, availableWidth - visibleWidth(firstPrefix));
    const originalPaddingX = this.markdown.paddingX;

    if (typeof originalPaddingX === "number") this.markdown.paddingX = 0;
    try {
      let first = true;
      for (const markdownLine of this.markdown.render(contentWidth)) {
        if (!stripTerminalSequences(markdownLine).trim()) continue;
        const prefix = treePrefix(first, theme);
        const bodyWidth = Math.max(0, availableWidth - visibleWidth(prefix));
        const body = truncateToWidth(markdownLine.trimEnd(), bodyWidth, "");
        lines.push(truncateToWidth(prefix + body, availableWidth, ""));
        first = false;
      }
    } finally {
      if (typeof originalPaddingX === "number") this.markdown.paddingX = originalPaddingX;
    }

    return lines;
  }
}

function replaceThinkingMarkdowns(
  component: AssistantMessageComponentLike,
  timing: TimingState,
): void {
  const children = component.contentContainer?.children;
  if (!children) return;

  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (isThinkingMarkdown(child)) {
      children[index] = new ThinkingBlockComponent(child, timing);
    } else if (isMouseRegion(child) && isThinkingMarkdown(child.child)) {
      child.child = new ThinkingBlockComponent(child.child, timing);
    }
  }
}

export function patchAssistantMessage(theme?: AssistantMessageThemeResolver): void {
  if (theme) themeResolver = theme;
  if (patched) return;

  try {
    const proto = AssistantMessageComponent.prototype as unknown as Record<string, unknown>;
    const originalUpdateContent = proto.updateContent;
    if (typeof originalUpdateContent !== "function") {
      throw new Error("AssistantMessageComponent.prototype is missing updateContent");
    }

    proto.updateContent = function (
      this: AssistantMessageComponentLike,
      message: AssistantMessage,
      isStreaming?: boolean,
    ): void {
      (
        originalUpdateContent as (
          this: AssistantMessageComponentLike,
          message: AssistantMessage,
          isStreaming?: boolean,
        ) => void
      ).call(this, message, isStreaming);
      replaceThinkingMarkdowns(
        this,
        timingFor(
          this,
          message,
          typeof this.isStreaming === "boolean" ? this.isStreaming : Boolean(isStreaming),
        ),
      );
    };
    patched = true;
  } catch (error) {
    console.warn(`[jpi-style] could not patch assistant thinking layout: ${errorMessage(error)}`);
  }
}
