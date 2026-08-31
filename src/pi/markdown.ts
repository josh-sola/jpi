import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

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
