/**
 * The MarkdownTheme stub below wraps each style in its own literal ANSI
 * marker instead of using pi's real theme/chalk, since chalk silently drops
 * all styling when it detects no color support (as it does under the test
 * runner) — that would make every assertion here pass or fail regardless of
 * whether the patch works.
 */
import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import { AssistantMessageComponent, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  Markdown,
  stripTerminalSequences,
  type MarkdownTheme,
  visibleWidth,
} from "@earendil-works/pi-tui";

import { patchAssistantMessage } from "../../src/pi/assistant-message.ts";
import { disableThinkingItalics } from "../../src/pi/markdown.ts";

const ITALIC_ON = "\x1b[3m";

initTheme();

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

const TEST_THEME = {
  fg: (_color: string, text: string) => `\x1b[38;5;244m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as Theme;

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

function thinkingMessage(thinking: string, timestamp = Date.now()): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking }],
    timestamp,
  } as AssistantMessage;
}

function thinkingComponent(
  message: AssistantMessage,
  isStreaming: boolean,
): AssistantMessageComponent {
  patchAssistantMessage(() => TEST_THEME);
  const component = new AssistantMessageComponent(
    undefined,
    false,
    stubMarkdownTheme(),
    "Thinking...",
    0,
  );
  component.updateContent(message, isStreaming);
  return component;
}

function visibleLines(component: AssistantMessageComponent, width = 120): string[] {
  return component
    .render(width)
    .map(stripTerminalSequences)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim());
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

test("thinking layout renders the Claude-style header and body without blank separators", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const component = thinkingComponent(
      thinkingMessage(`
Planning targeted status bar inspection

Evaluating test commands for status module

Tracing local wt tool repository path

Planning command schema investigation

Inspecting binary location and source commit
`),
      true,
    );

    assert.deepEqual(visibleLines(component), [
      "⏺ Thinking (0 seconds)",
      "  ⎿  Planning targeted status bar inspection",
      "     Evaluating test commands for status module",
      "     Tracing local wt tool repository path",
      "     Planning command schema investigation",
      "     Inspecting binary location and source commit",
    ]);
  } finally {
    vi.useRealTimers();
  }
});

test("thinking elapsed time updates while streaming and freezes when complete", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-01T00:00:00.000Z"));
    const message = thinkingMessage("Planning", Date.now());
    const component = thinkingComponent(message, true);

    vi.advanceTimersByTime(2_900);
    assert.equal(visibleLines(component)[0], "⏺ Thinking (2 seconds)");

    vi.advanceTimersByTime(100);
    component.updateContent(message, false);
    assert.equal(visibleLines(component)[0], "⏺ Thinking (3 seconds)");

    vi.advanceTimersByTime(10_000);
    assert.equal(visibleLines(component)[0], "⏺ Thinking (3 seconds)");
  } finally {
    vi.useRealTimers();
  }
});

test("a completed message first rendered during restore starts at zero elapsed", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-09-01T01:00:00.000Z"));
    const component = thinkingComponent(thinkingMessage("Restored", Date.now() - 60_000), false);
    assert.equal(visibleLines(component)[0], "⏺ Thinking (0 seconds)");
  } finally {
    vi.useRealTimers();
  }
});

test("thinking layout never renders a line wider than its supplied width", () => {
  const component = thinkingComponent(
    thinkingMessage("Planning a deliberately long status inspection with `inline formatting`"),
    true,
  );

  for (const width of [1, 2, 4, 5, 6, 12, 20]) {
    for (const line of component.render(width)) {
      assert.ok(
        visibleWidth(line) <= width,
        `${JSON.stringify(line)} is wider than ${width} columns`,
      );
    }
  }
});

test("thinking layout patching is idempotent and refreshes the theme resolver", () => {
  patchAssistantMessage(() => TEST_THEME);
  const afterFirst = (AssistantMessageComponent.prototype as unknown as { updateContent: unknown })
    .updateContent;
  const refreshedTheme = {
    fg: (_color: string, text: string) => `<refreshed>${text}</refreshed>`,
    bold: (text: string) => `<bold>${text}</bold>`,
  } as Theme;

  patchAssistantMessage(() => refreshedTheme);
  assert.equal(
    (AssistantMessageComponent.prototype as unknown as { updateContent: unknown }).updateContent,
    afterFirst,
  );

  const component = new AssistantMessageComponent(
    undefined,
    false,
    stubMarkdownTheme(),
    "Thinking...",
    0,
  );
  component.updateContent(thinkingMessage("Planning"), true);
  assert.ok(component.render(80).some((line) => line.includes("<refreshed>⏺</refreshed>")));
});

test("patching italics twice is idempotent", () => {
  disableThinkingItalics();
  disableThinkingItalics();
  assert.ok(!renderMarkdown("still no italics").includes(ITALIC_ON));
  assert.ok(renderMarkdown("still *works*").includes(ITALIC_ON));
});
