import type { Editor, TUI, TuiInputListenerResult } from "@earendil-works/pi-tui";
import { sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";

const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface SgrMouseEvent {
  readonly button: number;
  /** 0-based screen column. */
  readonly x: number;
  /** 0-based screen row. */
  readonly y: number;
  readonly release: boolean;
}

export interface Position {
  /** Index into the editor's logical lines. */
  readonly line: number;
  /** String index within that logical line. */
  readonly col: number;
}

export interface Selection {
  readonly anchor: Position;
  readonly focus: Position;
}

export interface SelectionRange {
  readonly start: Position;
  readonly end: Position;
}

/** A word-wrapped segment of a logical line, in string-index units. Matches pi-tui's own Editor#buildVisualLineMap shape. */
export interface VisualLine {
  readonly logicalLine: number;
  readonly startCol: number;
  readonly length: number;
}

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Local stand-in for pi-tui's unexported LayoutBox/LayoutFrame — only the shape this module reads. */
interface MinimalLayoutBox {
  readonly component: unknown;
  readonly rect: Rect;
  readonly clip: Rect;
  readonly children: readonly MinimalLayoutBox[];
  /** Rows trimmed off the top of `component`'s own rendered lines before they reach `rect`. */
  readonly lineOffset?: number;
}

interface MinimalLayoutFrame {
  readonly root: MinimalLayoutBox;
}

/** Duck-types pi-tui's Container — the shape used to walk into an unrecognized component's children. */
interface ContainerLike {
  readonly children: readonly unknown[];
}

function isContainerLike(value: unknown): value is ContainerLike {
  return (
    typeof value === "object" && value !== null && Array.isArray((value as ContainerLike).children)
  );
}

function renderedLineCount(component: unknown, width: number): number {
  const renderable = component as { render?: (width: number) => string[] };
  return typeof renderable.render === "function" ? renderable.render(width).length : 0;
}

/**
 * pi mounts the editor inside a plain Container with no layout node of its own
 * (`editorContainer.addChild(editor)`), so pi-tui's layout pass never recurses into it —
 * the container is the leaf box, and the editor never gets a box. Walks the container's
 * (possibly nested) children in render order to find how many lines land before the
 * editor, so its position within that leaf box's rendered lines can be recovered.
 */
function locateInContainer(
  container: ContainerLike,
  editor: unknown,
  width: number,
): { linesBefore: number } | undefined {
  let linesBefore = 0;
  for (const child of container.children) {
    if (child === editor) return { linesBefore };
    if (isContainerLike(child)) {
      const nested = locateInContainer(child, editor, width);
      if (nested) return { linesBefore: linesBefore + nested.linesBefore };
    }
    linesBefore += renderedLineCount(child, width);
  }
  return undefined;
}

/**
 * Finds where the editor renders on screen: by identity when it has its own layout box,
 * otherwise by locating it inside the nearest ancestor Container's leaf box and folding
 * that container's lineOffset (see layout.js's leaf-box branch) and the editor's
 * position within the container's own rendered lines into a synthetic rect.
 */
function locateEditorBox(
  root: MinimalLayoutBox,
  editor: unknown,
): { rect: Rect; clip: Rect } | undefined {
  const stack: MinimalLayoutBox[] = [root];
  const containerBoxes: MinimalLayoutBox[] = [];
  while (stack.length > 0) {
    const box = stack.pop()!;
    if (box.component === editor) return { rect: box.rect, clip: box.clip };
    // A VStack/HStack/ScrollView already gets its own children recursed into (box.children
    // is populated), so it can't be hiding the editor. Only a leaf box — no layout node of
    // its own, hence no children here — can be an opaque plain Container hiding it.
    if (box.children.length === 0 && isContainerLike(box.component)) containerBoxes.push(box);
    for (const child of box.children) stack.push(child);
  }

  for (const box of containerBoxes) {
    const located = locateInContainer(box.component as ContainerLike, editor, box.rect.width);
    if (!located) continue;
    return {
      clip: box.clip,
      rect: {
        x: box.rect.x,
        y: box.rect.y - (box.lineOffset ?? 0) + located.linesBefore,
        width: box.rect.width,
        height: box.rect.height,
      },
    };
  }
  return undefined;
}

export interface RowHighlightRange {
  /** Inclusive, in visible columns, absolute within the rendered row (includes left padding). */
  readonly startCol: number;
  /** Exclusive. */
  readonly endCol: number;
}

// ---------------------------------------------------------------------------
// SGR mouse parsing and classification (pure)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Layout geometry (pure)
// ---------------------------------------------------------------------------

export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

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

/** Walks graphemes (via Intl.Segmenter) to convert a visible column inside `text` to a string index, snapping past the end. */
export function columnToStringIndex(text: string, targetCol: number): number {
  if (targetCol <= 0 || text.length === 0) return 0;
  let col = 0;
  for (const { segment, index } of graphemeSegmenter.segment(text)) {
    const width = visibleWidth(segment);
    if (targetCol < col + width) return index;
    col += width;
  }
  return text.length;
}

export interface ClickMappingInput {
  readonly rectX: number;
  readonly rectY: number;
  readonly rectWidth: number;
  /** Raw (unclamped) paddingX, as returned by Editor#getPaddingX(). */
  readonly paddingX: number;
  readonly scrollOffset: number;
  readonly visualLines: readonly VisualLine[];
  readonly lines: readonly string[];
  readonly screenX: number;
  readonly screenY: number;
}

/** Screen (x, y) → logical (line, col), clamped to the nearest text row/column. */
export function mapScreenPointToPosition(input: ClickMappingInput): Position | undefined {
  const { visualLines } = input;
  if (visualLines.length === 0) return undefined;

  const relativeRow = input.screenY - input.rectY - 1 + input.scrollOffset;
  const vl = visualLines[Math.max(0, Math.min(visualLines.length - 1, relativeRow))]!;

  const lineText = input.lines[vl.logicalLine] ?? "";
  const chunkText = lineText.slice(vl.startCol, vl.startCol + vl.length);
  const chunkWidth = visibleWidth(chunkText);

  const paddingX = computePaddingX(input.paddingX, input.rectWidth);
  const relativeCol = input.screenX - input.rectX - paddingX;
  const clampedCol = Math.max(0, Math.min(chunkWidth, relativeCol));
  const index = columnToStringIndex(chunkText, clampedCol);

  return { line: vl.logicalLine, col: vl.startCol + index };
}

// ---------------------------------------------------------------------------
// Selection (pure)
// ---------------------------------------------------------------------------

function comparePositions(a: Position, b: Position): number {
  return a.line !== b.line ? a.line - b.line : a.col - b.col;
}

/** Undefined for a collapsed (empty) selection. */
export function normalizeSelection(selection: Selection | undefined): SelectionRange | undefined {
  if (!selection) return undefined;
  const order = comparePositions(selection.anchor, selection.focus);
  if (order === 0) return undefined;
  return order < 0
    ? { start: selection.anchor, end: selection.focus }
    : { start: selection.focus, end: selection.anchor };
}

export function deleteRangeFromLines(
  lines: readonly string[],
  range: SelectionRange,
): { lines: string[]; cursor: Position } {
  const { start, end } = range;
  const firstLine = lines[start.line] ?? "";
  const lastLine = lines[end.line] ?? "";
  const merged = firstLine.slice(0, start.col) + lastLine.slice(end.col);
  const next = [...lines.slice(0, start.line), merged, ...lines.slice(end.line + 1)];
  return { lines: next, cursor: { line: start.line, col: start.col } };
}

// ---------------------------------------------------------------------------
// Highlight rendering (pure)
// ---------------------------------------------------------------------------

/** Reasserts inverse video after any embedded reset so an interior cursor cell's `\x1b[0m` can't cut the highlight short. */
function wrapInverseVideo(text: string): string {
  return `\x1b[7m${text.replaceAll("\x1b[0m", "\x1b[0m\x1b[7m")}\x1b[0m`;
}

export function computeRowHighlightRange(
  vl: VisualLine,
  logicalLineText: string,
  selection: SelectionRange,
  paddingX: number,
): RowHighlightRange | undefined {
  if (vl.logicalLine < selection.start.line || vl.logicalLine > selection.end.line)
    return undefined;

  if (vl.length === 0) {
    const fullyInterior =
      vl.logicalLine > selection.start.line && vl.logicalLine < selection.end.line;
    return fullyInterior ? { startCol: paddingX, endCol: paddingX + 1 } : undefined;
  }

  const chunkStart = vl.startCol;
  const chunkEnd = vl.startCol + vl.length;
  const selStartInLine =
    vl.logicalLine === selection.start.line ? selection.start.col : Number.NEGATIVE_INFINITY;
  const selEndInLine =
    vl.logicalLine === selection.end.line ? selection.end.col : Number.POSITIVE_INFINITY;
  const overlapStart = Math.max(chunkStart, selStartInLine);
  const overlapEnd = Math.min(chunkEnd, selEndInLine);
  if (overlapEnd <= overlapStart) return undefined;

  const chunkText = logicalLineText.slice(chunkStart, chunkEnd);
  const startCol = paddingX + visibleWidth(chunkText.slice(0, overlapStart - chunkStart));
  const endCol = paddingX + visibleWidth(chunkText.slice(0, overlapEnd - chunkStart));
  return { startCol, endCol };
}

/** Wraps the given visible-column range of an already-rendered row in inverse video, preserving its total width. */
export function applySelectionHighlightToRow(row: string, range: RowHighlightRange): string {
  const width = visibleWidth(row);
  const start = Math.max(0, Math.min(width, range.startCol));
  const end = Math.max(start, Math.min(width, range.endCol));
  if (end <= start) return row;

  const before = sliceByColumn(row, 0, start, true);
  const highlighted = sliceByColumn(row, start, end - start, true);
  const after = sliceByColumn(row, end, Math.max(0, width - end), true);
  return `${before}${wrapInverseVideo(highlighted)}${after}`;
}

// ---------------------------------------------------------------------------
// pi-tui Editor/TUI private-surface accessors (the one seam to fix on a pi upgrade)
// ---------------------------------------------------------------------------

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

interface EditorAccess {
  /** Live, mutable reference — matches how Editor's own methods mutate `this.state` in place. */
  getState(): EditorState;
  getScrollOffset(): number;
  buildVisualLineMap(width: number): VisualLine[];
  pushUndoSnapshot(): void;
}

function detectEditorAccess(editor: Editor): EditorAccess | undefined {
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

interface TuiPrivateSurface {
  handleViewportInput: (data: string) => TuiInputListenerResult;
  currentLayout: MinimalLayoutFrame | undefined;
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

export interface MouseSupport {
  hasSelection(): boolean;
  clearSelection(): void;
  /** Deletes the current selection as one undo step and moves the cursor to its start. No-op without a selection. */
  deleteSelection(): void;
  /** Post-processes already-rendered rows to inverse-highlight the current selection. Returns `lines` unchanged when there's none. */
  applyHighlight(lines: string[], width: number): string[];
}

/**
 * Wraps `tui.handleViewportInput` to intercept left-button press/drag/release inside
 * `editor`'s rendered box, leaving wheel, right-click, clicks elsewhere, FOCUS_IN/OUT,
 * and anything while an overlay is open untouched. Returns undefined — installing
 * nothing — the moment any expected pi-tui internal is missing.
 */
export function installMouseSupport(tui: TUI, editor: Editor): MouseSupport | undefined {
  const detected = detectEditorAccess(editor);
  if (!detected) return undefined;
  // Rebound so the function declarations below — hoisted, so TS can't see the guard above
  // narrowed it — see a plain EditorAccess instead of EditorAccess | undefined.
  const editorAccess: EditorAccess = detected;

  const rawTui = tui as unknown as Partial<TuiPrivateSurface>;
  const original = rawTui.handleViewportInput;
  if (typeof original !== "function") return undefined;
  if (typeof tui.hasOverlay !== "function") return undefined;
  if (!("currentLayout" in rawTui)) return undefined;
  if (typeof tui.terminal?.rows !== "number") return undefined;

  const callOriginal = original.bind(tui);
  const getCurrentLayout = () => (rawTui as TuiPrivateSurface).currentLayout;

  let selection: Selection | undefined;
  let dragging = false;

  function findEditorBox(): { rect: Rect; clip: Rect } | undefined {
    const frame = getCurrentLayout();
    return frame ? locateEditorBox(frame.root, editor) : undefined;
  }

  function resolvePosition(
    box: { rect: Rect; clip: Rect },
    x: number,
    y: number,
  ): Position | undefined {
    const state = editorAccess.getState();
    const paddingX = editor.getPaddingX();
    const layoutWidth = computeLayoutWidth(box.rect.width, paddingX);
    return mapScreenPointToPosition({
      rectX: box.rect.x,
      rectY: box.rect.y,
      rectWidth: box.rect.width,
      paddingX,
      scrollOffset: editorAccess.getScrollOffset(),
      visualLines: editorAccess.buildVisualLineMap(layoutWidth),
      lines: state.lines,
      screenX: x,
      screenY: y,
    });
  }

  function setCursor(position: Position): void {
    const state = editorAccess.getState();
    state.cursorLine = position.line;
    state.cursorCol = position.col;
  }

  function handlePress(event: SgrMouseEvent): TuiInputListenerResult {
    const box = findEditorBox();
    if (!box || !containsPoint(box.clip, event.x, event.y)) return undefined;
    const position = resolvePosition(box, event.x, event.y);
    if (!position) return undefined;

    setCursor(position);
    selection = { anchor: position, focus: position };
    dragging = true;
    tui.requestRender();
    return { consume: true };
  }

  function handleDrag(event: SgrMouseEvent): TuiInputListenerResult {
    if (!dragging) return undefined;
    // Once a press lands inside the editor, this owns every motion event for the
    // drag even after the pointer leaves the editor's box — pi's own handler must
    // never see a partial press/motion/release cycle.
    const box = findEditorBox();
    const position = box ? resolvePosition(box, event.x, event.y) : undefined;
    if (position) {
      setCursor(position);
      selection = { anchor: selection?.anchor ?? position, focus: position };
      tui.requestRender();
    }
    return { consume: true };
  }

  function handleRelease(): TuiInputListenerResult {
    if (!dragging) return undefined;
    dragging = false;
    return { consume: true };
  }

  function wrapped(data: string): TuiInputListenerResult {
    if (data === FOCUS_OUT) {
      dragging = false;
      return callOriginal(data);
    }
    if (data === FOCUS_IN) return callOriginal(data);

    const event = parseSgrMouseEvent(data);
    if (!event) return callOriginal(data);

    if (tui.hasOverlay()) {
      dragging = false;
      return callOriginal(data);
    }
    if (isWheelEvent(event) || isRightButton(event) || !isLeftButtonRelevant(event)) {
      return callOriginal(data);
    }

    const handled = event.release
      ? handleRelease()
      : isMotionEvent(event)
        ? handleDrag(event)
        : handlePress(event);
    return handled ?? callOriginal(data);
  }

  rawTui.handleViewportInput = wrapped;

  return {
    hasSelection: () => normalizeSelection(selection) !== undefined,

    clearSelection: () => {
      if (!selection) return;
      selection = undefined;
      tui.requestRender();
    },

    deleteSelection: () => {
      const range = normalizeSelection(selection);
      if (!range) return;

      editorAccess.pushUndoSnapshot();
      const state = editorAccess.getState();
      const result = deleteRangeFromLines(state.lines, range);
      state.lines = result.lines;
      state.cursorLine = result.cursor.line;
      state.cursorCol = result.cursor.col;
      selection = undefined;

      editor.onChange?.(editor.getText());
      tui.requestRender();
    },

    applyHighlight: (lines, width) => {
      const range = normalizeSelection(selection);
      if (!range) return lines;

      const state = editorAccess.getState();
      const rawPaddingX = editor.getPaddingX();
      const paddingX = computePaddingX(rawPaddingX, width);
      const layoutWidth = computeLayoutWidth(width, rawPaddingX);
      const visualLines = editorAccess.buildVisualLineMap(layoutWidth);
      const scrollOffset = editorAccess.getScrollOffset();
      const maxVisibleLines = computeMaxVisibleLines(tui.terminal.rows);
      const visibleCount = Math.max(
        0,
        Math.min(maxVisibleLines, visualLines.length - scrollOffset),
      );

      let result: string[] | undefined;
      for (let i = 0; i < visibleCount; i++) {
        const vl = visualLines[scrollOffset + i];
        if (!vl) continue;
        const highlightRange = computeRowHighlightRange(
          vl,
          state.lines[vl.logicalLine] ?? "",
          range,
          paddingX,
        );
        if (!highlightRange) continue;

        const rowIndex = i + 1; // row 0 is the top border
        const row = lines[rowIndex];
        if (row === undefined) continue;

        result ??= [...lines];
        result[rowIndex] = applySelectionHighlightToRow(row, highlightRange);
      }
      return result ?? lines;
    },
  };
}
