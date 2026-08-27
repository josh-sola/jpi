import type { StatusLineConfig } from "./config.ts";
import { CUSTOM_COMPONENT_PREFIX, customOccurrenceKey } from "./custom.ts";
import type { PullRequestMetadata, RepositoryMetadata } from "./data.ts";
import type { JpiComponentId, StatusLineFormat } from "./layout.ts";

const ESC = "\x1b[";
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const UNDERLINE = `${ESC}4m`;
const UNDERLINE_OFF = `${ESC}24m`;
const SEPARATOR = `${DIM} · ${RESET}`;
const LINE_PREFIX = " ";

export type WidthHelpers = {
  visibleWidth(text: string): number;
  truncateToWidth(text: string, width: number, ellipsis?: string): string;
};

export type FooterSnapshot = {
  modelName: string;
  contextPercent?: number;
  contextWindow?: number;
  contextTokens?: number;
  sessionName?: string;
  turnCount?: number;
  liveSpeed?: number;
  cost?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheRead?: number;
  cacheWrite?: number;
  activeToolName?: string;
  cwd?: string;
  homeDirectory?: string;
  repository: RepositoryMetadata;
  statuses: ReadonlyMap<string, string>;
  customOutputs?: ReadonlyMap<string, string>;
  config: StatusLineConfig;
};

function color(code: number, text: string): string {
  return `${ESC}38;5;${code}m${text}${RESET}`;
}

function contextColor(percent: number): number {
  if (percent >= 80) return 174;
  if (percent >= 50) return 179;
  return 108;
}

function joinSegments(segments: Array<string | undefined>): string | undefined {
  const present = segments.filter((segment): segment is string => Boolean(segment));
  return present.length > 0 ? present.join(SEPARATOR) : undefined;
}

export function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function formatStatusSegments(
  statuses: ReadonlyMap<string, string>,
  disabledStatuses: ReadonlySet<string>,
): string[] {
  return [...statuses.entries()]
    .filter(([key]) => !disabledStatuses.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => sanitizeStatusText(text))
    .filter(Boolean);
}

export function formatStatuses(
  statuses: ReadonlyMap<string, string>,
  disabledStatuses: ReadonlySet<string> = new Set(),
): string | undefined {
  return joinSegments(formatStatusSegments(statuses, disabledStatuses));
}

export function formatPullRequest(pullRequest: PullRequestMetadata): string {
  const label = pullRequest.draft
    ? `${DIM}#${pullRequest.number} draft${RESET}`
    : `#${pullRequest.number}`;
  if (!pullRequest.url) return label;
  const open = `\x1b]8;;${pullRequest.url}\x1b\\`;
  const close = "\x1b]8;;\x1b\\";
  return `${open}${UNDERLINE}${label}${UNDERLINE_OFF}${close}`;
}

function formatModel(modelName: string): string {
  return `${BOLD}${color(139, modelName)}${RESET}`;
}

function formatContext(contextPercent?: number): string | undefined {
  if (contextPercent === undefined || !Number.isFinite(contextPercent)) return undefined;
  const rounded = Math.round(contextPercent);
  return color(contextColor(rounded), `ctx ${rounded}%`);
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function label(text: string): string {
  return `${DIM}${text}${RESET}`;
}

function formatSessionName(sessionName?: string): string | undefined {
  return sessionName || undefined;
}

function formatContextTotal(contextWindow?: number): string | undefined {
  return contextWindow === undefined ? undefined : label(`max ${formatCount(contextWindow)}`);
}

function formatContextUsed(contextTokens?: number): string | undefined {
  return contextTokens === undefined ? undefined : label(`used ${formatCount(contextTokens)}`);
}

function formatContextRemaining(
  contextWindow?: number,
  contextTokens?: number,
): string | undefined {
  if (contextWindow === undefined || contextTokens === undefined) return undefined;
  return label(`left ${formatCount(Math.max(0, contextWindow - contextTokens))}`);
}

function formatTurns(turnCount?: number): string {
  return label(`turns ${turnCount ?? 0}`);
}

function formatSpeed(liveSpeed?: number): string | undefined {
  return liveSpeed === undefined ? undefined : label(`${liveSpeed} tok/s`);
}

function formatCost(cost?: number): string {
  return label(`$${(cost ?? 0).toFixed(3)}`);
}

function formatTokens(prefix: string, tokens?: number): string {
  return label(`${prefix} ${formatCount(tokens ?? 0)}`);
}

function formatDirectory(cwd?: string, homeDirectory?: string): string | undefined {
  if (!cwd) return undefined;
  if (homeDirectory && (cwd === homeDirectory || cwd.startsWith(`${homeDirectory}/`))) {
    return `~${cwd.slice(homeDirectory.length)}`;
  }
  return cwd;
}

function formatTool(activeToolName?: string): string | undefined {
  return activeToolName ? `${label("tool")} ${activeToolName}` : undefined;
}

export function formatModelLine(modelName: string, contextPercent?: number): string {
  return joinSegments([formatModel(modelName), formatContext(contextPercent)])!;
}

export function formatRepositoryLine(repository: RepositoryMetadata): string | undefined {
  return joinSegments([
    repository.repo ? `${BOLD}${color(109, repository.repo)}${RESET}` : undefined,
    repository.worktree ? color(repository.worktree.color, repository.worktree.name) : undefined,
    repository.branch,
    repository.pullRequest ? formatPullRequest(repository.pullRequest) : undefined,
    repository.stack
      ? `${DIM}stack ${repository.stack.position}/${repository.stack.total}${RESET}`
      : undefined,
  ]);
}

function formatLocalComponent(
  componentId: Exclude<JpiComponentId, "@jpi/slot">,
  snapshot: FooterSnapshot,
): string | undefined {
  const repository = snapshot.repository;
  switch (componentId) {
    case "@jpi/model":
      return formatModel(snapshot.modelName);
    case "@jpi/context":
      return formatContext(snapshot.contextPercent);
    case "@jpi/repository":
      return repository.repo ? `${BOLD}${color(109, repository.repo)}${RESET}` : undefined;
    case "@jpi/worktree":
      return repository.worktree
        ? color(repository.worktree.color, repository.worktree.name)
        : undefined;
    case "@jpi/branch":
      return repository.branch;
    case "@jpi/pull-request":
      return repository.pullRequest ? formatPullRequest(repository.pullRequest) : undefined;
    case "@jpi/stack":
      return repository.stack
        ? `${DIM}stack ${repository.stack.position}/${repository.stack.total}${RESET}`
        : undefined;
    case "@jpi/name":
      return formatSessionName(snapshot.sessionName);
    case "@jpi/ctx-total":
      return formatContextTotal(snapshot.contextWindow);
    case "@jpi/ctx-used":
      return formatContextUsed(snapshot.contextTokens);
    case "@jpi/ctx-remaining":
      return formatContextRemaining(snapshot.contextWindow, snapshot.contextTokens);
    case "@jpi/turns":
      return formatTurns(snapshot.turnCount);
    case "@jpi/speed":
      return formatSpeed(snapshot.liveSpeed);
    case "@jpi/cost":
      return formatCost(snapshot.cost);
    case "@jpi/tokens-in":
      return formatTokens("in", snapshot.tokensIn);
    case "@jpi/tokens-out":
      return formatTokens("out", snapshot.tokensOut);
    case "@jpi/tokens-total":
      return formatTokens(
        "total",
        (snapshot.tokensIn ?? 0) +
          (snapshot.tokensOut ?? 0) +
          (snapshot.cacheRead ?? 0) +
          (snapshot.cacheWrite ?? 0),
      );
    case "@jpi/directory":
      return formatDirectory(snapshot.cwd, snapshot.homeDirectory);
    case "@jpi/tool":
      return formatTool(snapshot.activeToolName);
  }
}

function placedStatusIds(format: StatusLineFormat): Set<string> {
  const ids = new Set<string>();
  for (const line of format) {
    for (const componentId of line) {
      if (componentId.startsWith("@jpi/")) continue;
      if (componentId.startsWith(CUSTOM_COMPONENT_PREFIX)) continue;
      ids.add(componentId);
    }
  }
  return ids;
}

function resolveComponent(
  componentId: string,
  lineIndex: number,
  componentIndex: number,
  snapshot: FooterSnapshot,
): string[] {
  if (componentId.startsWith(CUSTOM_COMPONENT_PREFIX)) {
    const value = snapshot.customOutputs?.get(customOccurrenceKey(lineIndex, componentIndex));
    if (value === undefined) return [];
    const formatted = sanitizeStatusText(value);
    return formatted ? [formatted] : [];
  }
  if (componentId === "@jpi/slot") {
    const hidden = new Set([
      ...snapshot.config.disabledStatuses,
      ...placedStatusIds(snapshot.config.format),
    ]);
    return formatStatusSegments(snapshot.statuses, hidden);
  }
  if (componentId.startsWith("@jpi/")) {
    const value = formatLocalComponent(
      componentId as Exclude<JpiComponentId, "@jpi/slot">,
      snapshot,
    );
    return value ? [value] : [];
  }

  const value = snapshot.statuses.get(componentId);
  if (value === undefined) return [];
  const formatted = sanitizeStatusText(value);
  return formatted ? [formatted] : [];
}

function fitLine(line: string, width: number, helpers: WidthHelpers): string | undefined {
  const safeWidth = Math.max(0, Math.floor(width));
  const prefixWidth = helpers.visibleWidth(LINE_PREFIX);
  if (safeWidth < prefixWidth) return undefined;
  const contentWidth = safeWidth - prefixWidth;
  const content =
    helpers.visibleWidth(line) <= contentWidth
      ? line
      : helpers.truncateToWidth(line, contentWidth, `${DIM}...${RESET}`);
  return `${LINE_PREFIX}${content}`;
}

export function renderFooter(
  snapshot: FooterSnapshot,
  width: number,
  helpers: WidthHelpers,
): string[] {
  const lines: string[] = [];
  for (let lineIndex = 0; lineIndex < snapshot.config.format.length; lineIndex += 1) {
    const configuredLine = snapshot.config.format[lineIndex]!;
    const segments = configuredLine.flatMap((componentId, componentIndex) =>
      resolveComponent(componentId, lineIndex, componentIndex, snapshot),
    );
    const line = joinSegments(segments);
    if (!line) continue;
    const fittedLine = fitLine(line, width, helpers);
    if (fittedLine !== undefined) lines.push(fittedLine);
  }
  return lines;
}
