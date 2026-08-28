import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

import { installMouseSupport, type MouseSupport } from "./mouse.ts";

const GHOST_HINT = "  (tab to accept)";
const CURSOR_MARKER = "\x1b[7m \x1b[0m";

/** Splices dim ghost text right after the empty-editor cursor marker; falls back to a line below when no rendered line carries that marker. */
export function spliceGhostText(
  lines: readonly string[],
  ghost: string,
  dim: (text: string) => string,
): string[] {
  const styled = dim(`${ghost}${GHOST_HINT}`);

  const lineIndex = lines.findIndex((line) => line.includes(CURSOR_MARKER));
  if (lineIndex === -1) return [...lines, `  ${styled}`];

  const line = lines[lineIndex]!;
  const insertAt = line.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length;
  const spliced = [...lines];
  spliced[lineIndex] = line.slice(0, insertAt) + styled + line.slice(insertAt);
  return spliced;
}

export interface HistoryEditorOptions extends EditorOptions {
  /** Claude Code-style click-to-move-cursor and drag-to-select. Installs nothing when the tui doesn't support it. */
  mouse?: boolean;
}

/**
 * The editor pi's TUI is live-swapped to. Records every submission locally
 * (pi's own `history` field is private) and can seed history from the
 * plugin's prompt log without losing anything submitted before that read
 * finishes.
 */
export class HistoryEditor extends CustomEditor {
  private readonly submissions: string[] = [];
  private seeded = false;
  private ghost: string | undefined;
  // CustomEditor's own `keybindings` field is private to that class, so this
  // keeps its own copy of the same manager passed to the constructor.
  private readonly appKeybindings: KeybindingsManager;
  private readonly mouse: MouseSupport | undefined;

  /**
   * Fired on ctrl+r instead of going through pi.registerShortcut, which
   * flags a startup conflict for any shortcut that shadows a built-in
   * default (ctrl+r is app.session.rename's).
   */
  onHistorySearch?: () => void;

  /** Fired with the trimmed text every time the user submits a prompt. */
  onPromptRecorded?: (text: string) => void;

  /** Set at session start; render() falls back to unstyled text without it. */
  dim?: (text: string) => string;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    options?: HistoryEditorOptions,
  ) {
    super(tui, theme, keybindings, options);
    this.appKeybindings = keybindings;
    // Ghost text is only ever valid for the text it was suggested against;
    // any edit invalidates it. index.ts must not reassign onChange.
    this.onChange = () => this.clearGhostText();
    this.mouse = options?.mouse ? installMouseSupport(tui, this) : undefined;
  }

  /** No-ops when the editor already has text — a ghost only makes sense over an empty prompt. */
  setGhostText(text: string): void {
    if (this.getText() !== "") return;
    this.ghost = text;
    this.tui.requestRender();
  }

  clearGhostText(): void {
    if (this.ghost === undefined) return;
    this.ghost = undefined;
    this.tui.requestRender();
  }

  override handleInput(data: string): void {
    if (this.mouse?.hasSelection() && this.isDeleteKey(data)) {
      this.mouse.deleteSelection();
      return;
    }
    this.mouse?.clearSelection();

    if (this.onHistorySearch && matchesKey(data, "ctrl+r")) {
      this.onHistorySearch();
      return;
    }
    if (
      this.ghost &&
      this.getText() === "" &&
      !this.isShowingAutocomplete() &&
      matchesKey(data, "tab")
    ) {
      const accepted = this.ghost;
      this.ghost = undefined;
      this.setText(accepted);
      this.tui.requestRender();
      return;
    }
    super.handleInput(data);
  }

  private isDeleteKey(data: string): boolean {
    return (
      this.appKeybindings.matches(data, "tui.editor.deleteCharBackward") ||
      this.appKeybindings.matches(data, "tui.editor.deleteCharForward")
    );
  }

  override render(width: number): string[] {
    const rendered = super.render(width);
    const lines = this.mouse ? this.mouse.applyHighlight(rendered, width) : rendered;
    if (!this.ghost || this.getText() !== "") return lines;

    const dim = this.dim ?? ((text: string) => text);
    return spliceGhostText(lines, this.ghost, dim);
  }

  override addToHistory(text: string): void {
    super.addToHistory(text);
    const trimmed = text.trim();
    if (!trimmed) return;
    this.submissions.push(trimmed);
    this.onPromptRecorded?.(trimmed);
  }

  /**
   * Seeds history from the prompt log. `texts` must be oldest first.
   * Replays session-local submissions afterward so anything typed before
   * the async read finished still lands ahead of the seeded history. A
   * no-op after the first call, since the read can only complete once per
   * editor.
   */
  seedHistory(texts: readonly string[]): void {
    if (this.seeded) return;
    this.seeded = true;

    for (const text of texts) {
      super.addToHistory(text);
    }
    for (const text of this.submissions) {
      super.addToHistory(text);
    }
  }
}
