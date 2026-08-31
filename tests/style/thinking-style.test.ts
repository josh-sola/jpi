/**
 * The MarkdownTheme stub below wraps each style in its own literal ANSI
 * marker instead of using pi's real theme/chalk, since chalk silently drops
 * all styling when it detects no color support (as it does under the test
 * runner) — that would make every assertion here pass or fail regardless of
 * whether the patch works.
 */
import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { Markdown } from "@earendil-works/pi-tui";

import { disableThinkingItalics } from "../../src/pi/markdown.ts";

const ITALIC_ON = "\x1b[3m";

function stubMarkdownTheme(): MarkdownTheme {
  const identity = (text: string) => text;
  return {
    heading: identity,
    link: identity,
    linkUrl: identity,
    code: identity,
    codeBlock: identity,
    codeBlockBorder: identity,
    quote: identity,
    quoteBorder: identity,
    hr: identity,
    listBullet: identity,
    bold: (text) => `\x1b[1m${text}\x1b[22m`,
    italic: (text) => `${ITALIC_ON}${text}\x1b[23m`,
    underline: identity,
    strikethrough: identity,
  };
}

function renderMarkdown(text: string, width = 80): string {
  const markdown = new Markdown(
    text,
    0,
    0,
    stubMarkdownTheme(),
    { color: (t) => `<c>${t}</c>`, italic: true },
    {},
  );
  return markdown.render(width).join("\n");
}

test("thinking-block italics disappear after the patch", () => {
  disableThinkingItalics();
  const rendered = renderMarkdown("plain thinking text");
  assert.ok(!rendered.includes(ITALIC_ON), "should not contain an italic escape");
});

test("color from defaultTextStyle still applies after the patch", () => {
  disableThinkingItalics();
  const rendered = renderMarkdown("plain thinking text");
  assert.ok(
    rendered.includes("<c>plain thinking text</c>"),
    "color function should still wrap the text",
  );
});

test("*emphasis* still renders italic after the patch", () => {
  disableThinkingItalics();
  const rendered = renderMarkdown("plain *emph* text");
  assert.ok(rendered.includes(ITALIC_ON), "emphasis should still carry the italic escape");
});

test("patching twice is idempotent", () => {
  disableThinkingItalics();
  disableThinkingItalics();
  assert.ok(!renderMarkdown("still no italics").includes(ITALIC_ON));
  assert.ok(renderMarkdown("still *works*").includes(ITALIC_ON));
});
