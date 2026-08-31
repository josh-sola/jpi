import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

import { errorMessage } from "./errors.ts";
import type { WidgetTheme } from "./types.ts";

/**
 * Pi's own Markdown theme when this process has one, else a theme built from
 * `theme`. Preferring pi's buys syntax-highlighted code fences and keeps
 * rendering consistent with pi's own chat.
 *
 * `getMarkdownTheme()` has to be *probed* rather than try/caught around the
 * call: it returns arrow functions that read pi's global theme lazily, so an
 * uninitialized theme throws inside `render()` — long after this returns —
 * which is the case in tests and any embedded session that never called
 * `initTheme()`.
 */
export function resolveMarkdownTheme(theme: Theme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    return fallbackMarkdownTheme(theme);
  }
}

/**
 * `Theme` carries only `fg` and `bold`, so the three remaining inline styles
 * are written as raw SGR codes. Rendering them as plain text instead would
 * silently drop `*emphasis*`'s markers with nothing in their place, turning a
 * formatting change into a content change.
 */
function fallbackMarkdownTheme(theme: Theme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: (text) => theme.bold(theme.fg("accent", text)),
    link: (text) => theme.fg("accent", text),
    linkUrl: (text) => theme.fg("muted", text),
    code: (text) => theme.fg("muted", text),
    codeBlock: (text) => theme.fg("muted", text),
    codeBlockBorder: (text) => theme.fg("dim", text),
    quote: (text) => theme.fg("muted", text),
    quoteBorder: (text) => theme.fg("dim", text),
    hr: (text) => theme.fg("dim", text),
    listBullet: (text) => theme.fg("accent", text),
    bold: (text) => theme.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

/**
 * Same probe as `resolveMarkdownTheme` above, but for callers that only carry
 * jpi's narrow `WidgetTheme` (`{ fg, bold }`) rather than pi's real `Theme` —
 * subagents' `ConversationViewer` overlay is built from a `ctx.ui`-sourced
 * widget theme, not pi's own. Kept as a separate function (rather than
 * widening `resolveMarkdownTheme`'s parameter) because the two fallback
 * themes genuinely differ: this one derives every SGR style from
 * `WidgetTheme`'s two primitives, the other reads pi's own `Theme` methods
 * directly.
 */
export function resolveWidgetMarkdownTheme(theme: WidgetTheme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    return fallbackWidgetMarkdownTheme(theme);
  }
}

/**
 * `WidgetTheme` carries only `fg` and `bold`, so the three remaining styles
 * are written as raw SGR. Rendering them as plain text instead would
 * silently drop `*emphasis*`'s markers with nothing in their place, turning
 * a formatting change into a content change.
 */
function fallbackWidgetMarkdownTheme(theme: WidgetTheme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: (text) => theme.bold(theme.fg("accent", text)),
    link: (text) => theme.fg("accent", text),
    linkUrl: (text) => theme.fg("muted", text),
    code: (text) => theme.fg("muted", text),
    codeBlock: (text) => theme.fg("muted", text),
    codeBlockBorder: (text) => theme.fg("dim", text),
    quote: (text) => theme.fg("muted", text),
    quoteBorder: (text) => theme.fg("dim", text),
    hr: (text) => theme.fg("dim", text),
    listBullet: (text) => theme.fg("accent", text),
    bold: (text) => theme.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

/**
 * pi hardcodes `italic: true` on the Markdown component it builds for
 * assistant thinking blocks (pi-coding-agent's AssistantMessage component)
 * and gives extensions no theme token or hook to
 * turn that off. This is a deliberate runtime monkeypatch of pi-tui's
 * Markdown class to strip that italic, leaving `*emphasis*` and blockquote
 * italics (separate code paths, styled directly via `theme.italic`) alone.
 *
 * Fragile by nature: pi-tui's Markdown class declares `defaultTextStyle` as
 * a real ES class field, so the constructor's `this.defaultTextStyle = ...`
 * assignment always creates an own instance property that shadows any
 * accessor put on `Markdown.prototype` — a `defaultTextStyle` setter can't
 * intercept it. Instead this patches the two prototype methods that read
 * `defaultTextStyle.italic` (`applyDefaultStyle`, `getDefaultStylePrefix`),
 * swapping in an italic-stripped copy of the style for the duration of the
 * call. This depends on those method names and on `defaultTextStyle` staying
 * pi-tui's field name for the default style.
 */

const THINKING_ITALICS_PATCHED = Symbol.for("jpi:style:thinking-italics-patched");

interface DefaultTextStyle {
  italic?: boolean;
  [key: string]: unknown;
}

interface StyleBearing {
  defaultTextStyle?: DefaultTextStyle;
}

function withoutItalic<T>(instance: StyleBearing, run: () => T): T {
  const style = instance.defaultTextStyle;
  if (!style?.italic) return run();
  instance.defaultTextStyle = { ...style, italic: false };
  try {
    return run();
  } finally {
    instance.defaultTextStyle = style;
  }
}

/**
 * Patches pi-tui's Markdown class so thinking blocks render without italics.
 * Idempotent: safe to call more than once. Degrades to a no-op — italics
 * stay — if pi-tui's Markdown shape doesn't match what this expects (a
 * different module copy from jiti's module graph, or an upstream change).
 */
export function disableThinkingItalics(): void {
  try {
    const proto = Markdown.prototype as unknown as Record<PropertyKey, unknown> & {
      [THINKING_ITALICS_PATCHED]?: boolean;
    };
    if (proto[THINKING_ITALICS_PATCHED]) return;

    const originalApplyDefaultStyle = proto.applyDefaultStyle;
    const originalGetDefaultStylePrefix = proto.getDefaultStylePrefix;
    if (
      typeof originalApplyDefaultStyle !== "function" ||
      typeof originalGetDefaultStylePrefix !== "function"
    ) {
      throw new Error("Markdown.prototype is missing applyDefaultStyle/getDefaultStylePrefix");
    }

    proto.applyDefaultStyle = function (this: StyleBearing, text: string): string {
      return withoutItalic(this, () =>
        (originalApplyDefaultStyle as (this: StyleBearing, text: string) => string).call(
          this,
          text,
        ),
      );
    };
    proto.getDefaultStylePrefix = function (this: StyleBearing): string {
      return withoutItalic(this, () =>
        (originalGetDefaultStylePrefix as (this: StyleBearing) => string).call(this),
      );
    };

    Object.defineProperty(proto, THINKING_ITALICS_PATCHED, { value: true, configurable: true });
  } catch (error) {
    console.warn(`[jpi-style] could not disable thinking-block italics: ${errorMessage(error)}`);
  }
}
