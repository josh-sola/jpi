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

import { Markdown } from "@earendil-works/pi-tui";

import { errorMessage } from "../../src/core/errors.ts";

const PATCHED = Symbol.for("jpi:style:thinking-italics-patched");

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
      [PATCHED]?: boolean;
    };
    if (proto[PATCHED]) return;

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

    Object.defineProperty(proto, PATCHED, { value: true, configurable: true });
  } catch (error) {
    console.warn(`[jpi-style] could not disable thinking-block italics: ${errorMessage(error)}`);
  }
}
