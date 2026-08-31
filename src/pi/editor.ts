import type { Editor, TUI, TuiInputListenerResult } from "@earendil-works/pi-tui";

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Local stand-in for pi-tui's unexported LayoutBox/LayoutFrame — only the shape this module reads. */
export interface MinimalLayoutBox {
  readonly component: unknown;
  readonly rect: Rect;
  readonly clip: Rect;
  readonly children: readonly MinimalLayoutBox[];
  /** Rows trimmed off the top of `component`'s own rendered lines before they reach `rect`. */
  readonly lineOffset?: number;
}

export interface MinimalLayoutFrame {
  readonly root: MinimalLayoutBox;
}

// ---------------------------------------------------------------------------
// Layout geometry (pure)
// ---------------------------------------------------------------------------

/** Mirrors Editor#render's own padding clamp: `Math.min(paddingX, Math.floor((width - 1) / 2))`. */
export function computePaddingX(rawPaddingX: number, width: number): number {
  const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
  return Math.min(rawPaddingX, maxPadding);
}

/** Mirrors Editor#render's own layout-width formula, the width buildVisualLineMap must be called with. */
export function computeLayoutWidth(width: number, rawPaddingX: number): number {
  const paddingX = computePaddingX(rawPaddingX, width);
  const contentWidth = Math.max(1, width - paddingX * 2);
  return Math.max(1, contentWidth - (paddingX ? 0 : 1));
}

/** Mirrors Editor#render's own `maxVisibleLines` formula. */
export function computeMaxVisibleLines(terminalRows: number): number {
  return Math.max(5, Math.floor(terminalRows * 0.3));
}

// ---------------------------------------------------------------------------
// pi-tui Editor private-surface access
// ---------------------------------------------------------------------------

/** A word-wrapped segment of a logical line, in string-index units. Matches pi-tui's own Editor#buildVisualLineMap shape. */
interface VisualLine {
  readonly logicalLine: number;
  readonly startCol: number;
  readonly length: number;
}

interface EditorState {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

function isEditorState(value: unknown): value is EditorState {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as EditorState).lines) &&
    typeof (value as EditorState).cursorLine === "number" &&
    typeof (value as EditorState).cursorCol === "number"
  );
}

interface EditorPrivateSurface {
  state: EditorState;
  scrollOffset: number;
  buildVisualLineMap(width: number): VisualLine[];
  pushUndoSnapshot(): void;
}

export interface EditorAccess {
  /** Live, mutable reference — matches how Editor's own methods mutate `this.state` in place. */
  getState(): EditorState;
  getScrollOffset(): number;
  buildVisualLineMap(width: number): VisualLine[];
  pushUndoSnapshot(): void;
}

export function detectEditorAccess(editor: Editor): EditorAccess | undefined {
  const surface = editor as unknown as Partial<EditorPrivateSurface>;
  if (!isEditorState(surface.state)) return undefined;
  if (typeof surface.scrollOffset !== "number") return undefined;
  if (typeof surface.buildVisualLineMap !== "function") return undefined;
  if (typeof surface.pushUndoSnapshot !== "function") return undefined;

  const typed = editor as unknown as EditorPrivateSurface;
  return {
    getState: () => typed.state,
    getScrollOffset: () => typed.scrollOffset,
    buildVisualLineMap: (width) => typed.buildVisualLineMap(width),
    pushUndoSnapshot: () => typed.pushUndoSnapshot(),
  };
}

// ---------------------------------------------------------------------------
// pi-tui TUI private-surface access
// ---------------------------------------------------------------------------

interface TuiPrivateSurface {
  handleViewportInput: (data: string) => TuiInputListenerResult;
  currentLayout: MinimalLayoutFrame | undefined;
}

/**
 * Patches `tui.handleViewportInput` — pi-tui's own unexported per-input
 * listener slot — so every call runs through `wrap(original)` first. `wrap`
 * receives the original handler (already bound to `tui`) and returns the
 * replacement; the replacement is free to call the original for any input it
 * doesn't want to intercept.
 *
 * Returns undefined — installing nothing — the moment `handleViewportInput`
 * or `currentLayout` isn't present on `tui`, matching pi-tui's private
 * shape this depends on. On success, also returns a `getCurrentLayout`
 * accessor for `tui`'s own private `currentLayout` field, read fresh on
 * every call (it changes every render).
 */
export function patchViewportInput(
  tui: TUI,
  wrap: (
    original: (data: string) => TuiInputListenerResult,
  ) => (data: string) => TuiInputListenerResult,
): { getCurrentLayout: () => MinimalLayoutFrame | undefined } | undefined {
  const rawTui = tui as unknown as Partial<TuiPrivateSurface>;
  const original = rawTui.handleViewportInput;
  if (typeof original !== "function") return undefined;
  if (!("currentLayout" in rawTui)) return undefined;

  const callOriginal = original.bind(tui);
  rawTui.handleViewportInput = wrap(callOriginal);

  return { getCurrentLayout: () => (rawTui as TuiPrivateSurface).currentLayout };
}

// ---------------------------------------------------------------------------
// Fuzzy-match highlighting (pure)
// ---------------------------------------------------------------------------

/**
 * Greedy in-order case-insensitive character walk, mirroring pi-tui's
 * fuzzyMatch loop (minus its letter/digit-swap fallback). Tokens are
 * whitespace/slash separated, same as fuzzyFilter; a token that doesn't
 * fully match contributes no indices.
 */
export function matchIndices(query: string, text: string): Set<number> {
  const indices = new Set<number>();
  const trimmed = query.trim();
  if (!trimmed) return indices;

  const textLower = text.toLowerCase();
  const tokens = trimmed.split(/[\s/]+/).filter((token) => token.length > 0);

  for (const token of tokens) {
    const tokenLower = token.toLowerCase();
    const tokenIndices: number[] = [];
    let tokenIndex = 0;
    for (let i = 0; i < textLower.length && tokenIndex < tokenLower.length; i++) {
      if (textLower[i] === tokenLower[tokenIndex]) {
        tokenIndices.push(i);
        tokenIndex++;
      }
    }
    if (tokenIndex === tokenLower.length) {
      for (const index of tokenIndices) indices.add(index);
    }
  }

  return indices;
}
