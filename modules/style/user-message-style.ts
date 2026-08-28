/**
 * pi pads every user message with a blank background line above and below
 * the text (pi-coding-agent's UserMessageComponent.rebuild():
 * `new Box(this.outputPad, 1, bgFn)` — the `1` is vertical padding) and
 * gives extensions no theme token or hook to turn it off. This monkeypatches
 * the component's `rebuild()` to zero out that Box's vertical padding right
 * after pi builds it, leaving horizontal padding, the background, and
 * `render()`'s OSC 133 zone markers untouched.
 *
 * Fragile by nature: depends on `rebuild()` adding exactly one content child
 * shaped like pi-tui's Box (a plain `paddingY` field plus an
 * `invalidateCache()` method) — an upstream change to either silently turns
 * this into a no-op (padding stays).
 */

import { UserMessageComponent } from "@earendil-works/pi-coding-agent";

import { errorMessage } from "../../src/core/errors.ts";

const PATCHED = Symbol.for("jpi:style:user-message-padding-patched");

interface PaddedBoxLike {
  paddingY?: unknown;
  invalidateCache?: () => void;
}

interface ContainerLike {
  children?: readonly unknown[];
}

function zeroOutVerticalPadding(instance: ContainerLike): void {
  for (const child of instance.children ?? []) {
    const box = child as PaddedBoxLike;
    if (typeof box.paddingY === "number" && box.paddingY !== 0) {
      box.paddingY = 0;
      box.invalidateCache?.();
    }
  }
}

/**
 * Patches pi-coding-agent's UserMessageComponent so it no longer pads a
 * blank line above and below the message. Idempotent: safe to call more
 * than once. Degrades to a no-op — padding stays — if the component's
 * shape doesn't match what this expects.
 */
export function removeUserMessagePadding(): void {
  try {
    const proto = UserMessageComponent.prototype as unknown as Record<PropertyKey, unknown> & {
      [PATCHED]?: boolean;
    };
    if (proto[PATCHED]) return;

    const originalRebuild = proto.rebuild;
    if (typeof originalRebuild !== "function") {
      throw new Error("UserMessageComponent.prototype is missing rebuild");
    }

    proto.rebuild = function (this: ContainerLike): void {
      (originalRebuild as (this: ContainerLike) => void).call(this);
      zeroOutVerticalPadding(this);
    };

    Object.defineProperty(proto, PATCHED, { value: true, configurable: true });
  } catch (error) {
    console.warn(`[jpi-style] could not remove user-message padding: ${errorMessage(error)}`);
  }
}
