import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Loader,
  Markdown,
  matchesKey,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";

import { BorderBox, resolveMarkdownTheme } from "../../src/core/index.ts";

/**
 * Overlay maxHeight, as a percentage of terminal rows. Exported so the
 * `overlayOptions.maxHeight` passed to `ctx.ui.custom()` and this
 * component's own viewport math read the same number and never drift apart.
 */
export const BTW_OVERLAY_MAX_HEIGHT_PCT = 80;

/** Top border + header + divider + footer + bottom border. */
const CHROME_LINES = 5;
const MIN_VIEWPORT = 3;

export type BtwOverlayState =
  | { readonly status: "asking"; readonly question: string }
  | { readonly status: "done"; readonly question: string; readonly answer: string }
  | { readonly status: "error"; readonly question: string; readonly message: string };

/** Defers rendering to a callback so BorderBox's children stay simple, width-fed adapters. */
class CallbackLines implements Component {
  constructor(private readonly build: (width: number) => string[]) {}

  invalidate(): void {
    // No-op: the callback reads BtwOverlay's live state on every render() call.
  }

  render(width: number): string[] {
    return this.build(width);
  }
}

/**
 * The right-side `/btw` panel. Holds one exchange at a time — a new question
 * calls `setState()` on the same instance rather than opening another overlay
 * (see docs/tui.md's overlay lifecycle: a closed overlay's component is
 * disposed and must never be reused).
 */
export class BtwOverlay implements Component {
  private state: BtwOverlayState;
  private scrollOffset = 0;
  private lastInnerWidth = 1;
  private readonly markdown: Markdown;
  private readonly loader: Loader;
  private readonly border: BorderBox;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    initial: BtwOverlayState,
    private readonly done: (result: undefined) => void,
  ) {
    this.state = initial;
    this.markdown = new Markdown("", 0, 0, resolveMarkdownTheme(theme));
    this.loader = new Loader(
      tui,
      (text) => theme.fg("accent", text),
      (text) => theme.fg("dim", text),
      "thinking…",
    );
    this.border = new BorderBox(
      theme,
      [
        new CallbackLines((width) => [this.buildHeader(width)]),
        new CallbackLines((width) => this.buildBody(width)),
        new CallbackLines((width) => [this.buildFooter(width)]),
      ],
      0,
      "btw",
    );
    this.syncBody();
  }

  /** Reopens this same panel on a new question, or fills in the answer/error for the current one. */
  setState(state: BtwOverlayState): void {
    this.state = state;
    this.scrollOffset = 0;
    this.syncBody();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.close();
      return;
    }
    if (this.state.status === "asking") return;

    const width = this.lastInnerWidth;
    const total = this.markdown.render(width).length;
    const viewport = this.viewportHeight();
    const maxScroll = Math.max(0, total - viewport);

    if (this.keybindings.matches(data, "tui.select.up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
    } else if (this.keybindings.matches(data, "tui.select.down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
    } else if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewport);
    } else if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewport);
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
    } else {
      return;
    }

    this.tui.requestRender();
  }

  render(width: number): string[] {
    return this.border.render(width);
  }

  invalidate(): void {
    this.border.invalidate();
    this.markdown.invalidate();
  }

  dispose(): void {
    this.loader.stop();
  }

  private close(): void {
    this.loader.stop();
    this.done(undefined);
  }

  private syncBody(): void {
    if (this.state.status === "asking") {
      this.loader.start();
      return;
    }
    this.loader.stop();
    this.markdown.setText(this.state.status === "done" ? this.state.answer : this.state.message);
  }

  private buildHeader(width: number): string {
    const glyph =
      this.state.status === "asking"
        ? this.theme.fg("accent", "●")
        : this.state.status === "done"
          ? this.theme.fg("success", "✓")
          : this.theme.fg("error", "✗");
    const question = this.theme.fg("muted", this.state.question);
    return truncateToWidth(`${glyph} ${question}`, width, "…", true);
  }

  private buildBody(width: number): string[] {
    this.lastInnerWidth = Math.max(1, width);

    if (this.state.status === "asking") {
      return this.loader.render(width);
    }

    const lines = this.markdown.render(width);
    const viewport = this.viewportHeight();
    const maxScroll = Math.max(0, lines.length - viewport);

    // The answer arrives whole, so open at its top; End jumps to the bottom.
    const start = Math.min(this.scrollOffset, maxScroll);
    const visible = lines.slice(start, start + viewport);
    // Pad short answers out to the full viewport so the panel's height stays
    // steady instead of shrinking to fit the content.
    while (visible.length < viewport) visible.push("");
    return visible;
  }

  private buildFooter(width: number): string {
    return truncateToWidth(this.theme.fg("dim", "↑↓ scroll · esc close"), width, "…", true);
  }

  /** Mirrors the overlay's own `maxHeight` percentage, minus the fixed chrome around the body. */
  private viewportHeight(): number {
    const maxRows = Math.floor((this.tui.terminal.rows * BTW_OVERLAY_MAX_HEIGHT_PCT) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - CHROME_LINES);
  }
}
