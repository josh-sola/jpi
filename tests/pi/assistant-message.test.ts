import { describe, expect, it } from "vite-plus/test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

import { patchAssistantMessage } from "../../src/pi/assistant-message.ts";

initTheme();

const NOOP_MARKDOWN_THEME: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  strikethrough: (text) => text,
};

function thinkingMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "thinking", thinking: "Planning the canary" }],
    timestamp: Date.now(),
  } as AssistantMessage;
}

describe("assistant-message: AssistantMessageComponent.prototype.updateContent (real pi-coding-agent)", () => {
  it("is a real prototype method", () => {
    expect(
      typeof (AssistantMessageComponent.prototype as unknown as { updateContent?: unknown })
        .updateContent,
    ).toBe("function");
  });

  it("replaces the Markdown in Pi 0.85's thinking MouseRegion", () => {
    patchAssistantMessage();
    const component = new AssistantMessageComponent(
      undefined,
      false,
      NOOP_MARKDOWN_THEME,
      "Thinking...",
      0,
    );
    component.updateContent(thinkingMessage(), true);

    const contentContainer = (
      component as unknown as {
        contentContainer?: { children?: unknown[] };
      }
    ).contentContainer;
    expect(contentContainer?.children).toBeDefined();

    const mouseRegion = contentContainer?.children?.find((child) => {
      const region = child as { child?: unknown };
      return region.child !== undefined;
    }) as { constructor: { name: string }; child: unknown } | undefined;
    expect(mouseRegion).toBeDefined();
    expect(mouseRegion?.constructor.name).toBe("MouseRegion");

    const thinkingBlock = mouseRegion?.child as {
      children?: unknown[];
      constructor: { name: string };
    };
    expect(thinkingBlock.constructor.name).toBe("ThinkingBlockComponent");

    const markdown = thinkingBlock.children?.[0] as {
      constructor: { name: string };
      defaultTextStyle?: { italic?: boolean };
    };
    expect(markdown.constructor.name).toBe("Markdown");
    expect(markdown.defaultTextStyle?.italic).toBe(true);
  });

  it("is idempotent", () => {
    patchAssistantMessage();
    const afterFirst = (
      AssistantMessageComponent.prototype as unknown as { updateContent: unknown }
    ).updateContent;
    patchAssistantMessage();
    expect(
      (AssistantMessageComponent.prototype as unknown as { updateContent: unknown }).updateContent,
    ).toBe(afterFirst);
  });
});
