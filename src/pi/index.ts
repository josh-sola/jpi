export {
  computeLayoutWidth,
  computeMaxVisibleLines,
  computePaddingX,
  detectEditorAccess,
  type EditorAccess,
  matchIndices,
  type MinimalLayoutBox,
  type MinimalLayoutFrame,
  patchViewportInput,
} from "./editor.ts";
export { cloneExtensionApi } from "./extension-api.ts";
export { patchToolDefinitionLookup } from "./extension-runner.ts";
export { disableThinkingItalics, resolveMarkdownTheme } from "./markdown.ts";
export { countDiffStats, editResultDiff } from "./messages.ts";
export { getAgentDirectory } from "./settings.ts";
export type {
  BeforeAgentStartEvent,
  EventBus,
  Notifier,
  NotifyLevel,
  ToolRenderContext,
  TranscriptEntryLike,
} from "./types.ts";
export { removeUserMessagePadding } from "./user-message.ts";
