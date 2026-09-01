/**
 * mouse.ts — SGR mouse wire-format parsing shared across jpi's own mouse
 * support.
 *
 * pi-tui forwards raw SGR mouse escape sequences (`\x1b[<button;x;yM`/`m`)
 * to a focused component's `handleInput` unparsed — it exposes no parsed
 * mouse-event type or hook into that dispatch — so any component that wants
 * to read wheel or button input decodes and classifies the wire bytes
 * itself. Kept here, not in either caller's module, so both
 * `modules/history` (editor click/drag/select) and `modules/subagents`
 * (viewer wheel scroll) share one parser instead of duplicating it.
 */

const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

export interface SgrMouseEvent {
  readonly button: number;
  /** 0-based screen column. */
  readonly x: number;
  /** 0-based screen row. */
  readonly y: number;
  readonly release: boolean;
}

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
  const match = SGR_MOUSE_RE.exec(data);
  if (!match) return undefined;
  return {
    button: Number.parseInt(match[1]!, 10),
    x: Number.parseInt(match[2]!, 10) - 1,
    y: Number.parseInt(match[3]!, 10) - 1,
    release: match[4] === "m",
  };
}

export function isWheelEvent(event: SgrMouseEvent): boolean {
  return (event.button & 64) !== 0;
}

/**
 * Vertical scroll direction, or `undefined` for a horizontal wheel tick
 * (buttons 66/67, e.g. a trackpad's horizontal swipe) — matching pi-tui's
 * own `parseWheelEvent` (tui-alt-screen.js), which only recognizes `button &
 * 3` of 0 or 1. Only meaningful when `isWheelEvent` is true.
 */
export function verticalWheelDirection(event: SgrMouseEvent): -1 | 1 | undefined {
  const low = event.button & 3;
  return low === 0 ? -1 : low === 1 ? 1 : undefined;
}

export function isRightButton(event: SgrMouseEvent): boolean {
  return (event.button & 3) === 2;
}

export function isMotionEvent(event: SgrMouseEvent): boolean {
  return (event.button & 32) !== 0;
}

/** True for a left-button press/drag, or a release (some terminals report button 3 — "unspecified" — on release). */
export function isLeftButtonRelevant(event: SgrMouseEvent): boolean {
  const low = event.button & 3;
  return low === 0 || (event.release && low === 3);
}
