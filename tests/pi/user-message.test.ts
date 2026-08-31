/**
 * user-message.test.ts — canary for src/pi/user-message.ts's
 * `removeUserMessagePadding` monkeypatch, against the real
 * `UserMessageComponent` from pi-coding-agent.
 */
import { describe, expect, it } from "vite-plus/test";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { removeUserMessagePadding } from "../../src/pi/user-message.ts";

const NOOP_MARKDOWN_THEME: MarkdownTheme = {
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
  italic: (t) => t,
  underline: (t) => t,
  strikethrough: (t) => t,
};

interface PaddedBoxLike {
  paddingY?: unknown;
  invalidateCache?: () => void;
}

function childBox(component: UserMessageComponent): PaddedBoxLike {
  const children = (component as unknown as { children?: readonly unknown[] }).children ?? [];
  expect(children.length).toBeGreaterThan(0);
  return children[0] as PaddedBoxLike;
}

describe("user-message: UserMessageComponent.prototype.rebuild (real pi-coding-agent)", () => {
  it("rebuild is a real function on the prototype", () => {
    expect(
      typeof (UserMessageComponent.prototype as unknown as { rebuild?: unknown }).rebuild,
    ).toBe("function");
  });

  it("before the patch, rebuild adds a padded Box child with the shape the patch reaches into", () => {
    // Passing markdownTheme explicitly skips the constructor's
    // getMarkdownTheme() default arg, which throws without initTheme().
    const component = new UserMessageComponent("hello", NOOP_MARKDOWN_THEME, 1);
    const box = childBox(component);
    expect(typeof box.paddingY).toBe("number");
    expect(typeof box.invalidateCache).toBe("function");
    expect(box.paddingY).not.toBe(0);
  });

  it("removeUserMessagePadding zeroes the vertical padding after a real rebuild()", () => {
    removeUserMessagePadding();
    const component = new UserMessageComponent("hello", NOOP_MARKDOWN_THEME, 1);
    const box = childBox(component);
    expect(box.paddingY).toBe(0);
  });

  it("is idempotent (a second install doesn't double-patch)", () => {
    const afterFirst = (UserMessageComponent.prototype as unknown as { rebuild: unknown }).rebuild;
    removeUserMessagePadding();
    expect((UserMessageComponent.prototype as unknown as { rebuild: unknown }).rebuild).toBe(
      afterFirst,
    );
  });

  it("setOutputPad re-runs rebuild and stays patched", () => {
    const component = new UserMessageComponent("hello", NOOP_MARKDOWN_THEME, 1);
    component.setOutputPad(3);
    const box = childBox(component);
    expect(box.paddingY).toBe(0);
  });
});
