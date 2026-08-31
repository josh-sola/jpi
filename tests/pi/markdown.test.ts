/**
 * markdown.test.ts — canary for src/pi/markdown.ts's `disableThinkingItalics`
 * monkeypatch, against the real pi-tui `Markdown` class.
 *
 * `resolveMarkdownTheme`/`resolveWidgetMarkdownTheme`'s probe-based fallback
 * (getMarkdownTheme()'s lazy-throw) is out of scope here — see
 * src/pi/README.md's ledger, which marks that row "marker only" for this
 * pass. This canary only needs to prove the REAL `Markdown.prototype` still
 * has the two methods and the `defaultTextStyle` field the patch reaches
 * into.
 */
import { describe, expect, it } from "vite-plus/test";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { disableThinkingItalics } from "../../src/pi/markdown.ts";

const NOOP_THEME: MarkdownTheme = {
  heading: (t) => t,
  link: (t) => t,
  linkUrl: (t) => t,
  code: (t) => t,
  codeBlock: (t) => t,
  codeBlockBorder: (t) => t,
  quote: (t) => t,
  quoteBorder: (t) => t,
  hr: (t) => t,
  listBullet: (t) => t,
  bold: (t) => t,
  italic: (t) => `*${t}*`,
  underline: (t) => t,
  strikethrough: (t) => t,
};

// applyDefaultStyle/getDefaultStylePrefix are private on Markdown (same
// members src/pi/markdown.ts's disableThinkingItalics patches) — this cast
// is the same escape hatch that patch uses to reach them.
const markdownProto = Markdown.prototype as unknown as Record<PropertyKey, unknown>;

describe("markdown: Markdown.prototype (real pi-tui)", () => {
  it("applyDefaultStyle and getDefaultStylePrefix are real functions on the prototype", () => {
    expect(typeof markdownProto.applyDefaultStyle).toBe("function");
    expect(typeof markdownProto.getDefaultStylePrefix).toBe("function");
  });

  it("a real instance has a writable defaultTextStyle field", () => {
    const md = new Markdown("hello", 0, 0, NOOP_THEME, { italic: true });
    // Real ES class field — an own instance property, not inherited/getter-only.
    expect(Object.prototype.hasOwnProperty.call(md, "defaultTextStyle")).toBe(true);
    expect(
      (md as unknown as { defaultTextStyle?: { italic?: boolean } }).defaultTextStyle?.italic,
    ).toBe(true);
    (md as unknown as { defaultTextStyle: unknown }).defaultTextStyle = { italic: false };
    expect(
      (md as unknown as { defaultTextStyle: { italic?: boolean } }).defaultTextStyle.italic,
    ).toBe(false);
  });

  it("disableThinkingItalics strips italic from a thinking-styled instance's rendered output", () => {
    disableThinkingItalics();
    const md = new Markdown("plain text", 0, 0, NOOP_THEME, { italic: true });
    const lines = md.render(80);
    // NOOP_THEME's `italic` wraps text in literal asterisks — a real signal
    // the patch strips (not just "some SGR code changed").
    expect(lines.join("\n")).not.toContain("*");
  });

  it("disableThinkingItalics is idempotent (a second install doesn't double-patch)", () => {
    const afterFirst = markdownProto.applyDefaultStyle;
    disableThinkingItalics();
    expect(markdownProto.applyDefaultStyle).toBe(afterFirst);
  });

  it("leaves non-italic default styling alone", () => {
    disableThinkingItalics();
    const md = new Markdown("plain text", 0, 0, NOOP_THEME, { italic: false });
    const lines = md.render(80);
    expect(lines.join("\n")).toContain("plain text");
  });
});
