const SPEED_WINDOW_MS = 2_000;

export type FooterStatsSnapshot = {
  sessionName: string | null;
  turnCount: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  activeToolName: string | null;
  liveSpeed: number | null;
};

type MessageContentPart = {
  type?: string;
  text?: string;
};

type MessageUsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
};

export type MessageLike = {
  role?: string;
  stopReason?: string;
  usage?: MessageUsageLike;
  content?: string | MessageContentPart[];
};

export type BranchEntryLike = {
  type?: string;
  message?: MessageLike;
};

export type SessionStartInput = {
  sessionManager?: {
    getSessionName?(): string | undefined;
    getBranch?(): BranchEntryLike[];
  };
};

export type SessionInfoChangedInput = {
  name?: string;
};

export type MessageEventInput = {
  message?: MessageLike;
};

export type ToolExecutionStartInput = {
  toolName?: string;
};

function textLength(content: MessageLike["content"]): number {
  if (typeof content === "string") return content.length;
  if (Array.isArray(content)) {
    return content.reduce(
      (sum, part) =>
        sum + (part?.type === "text" && typeof part.text === "string" ? part.text.length : 0),
      0,
    );
  }
  return 0;
}

/**
 * Accumulates footer stats from Pi extension events. Every mutating method
 * mirrors one event; `snapshot()` is the only way `render()` reads it.
 */
export class FooterStats {
  private readonly now: () => number;

  private sessionName: string | null = null;
  private turnCount = 0;
  private tokensIn = 0;
  private tokensOut = 0;
  private cacheRead = 0;
  private cacheWrite = 0;
  private cost = 0;
  private activeToolName: string | null = null;
  private liveSpeed: number | null = null;
  private speedSamples: { t: number; tokens: number }[] = [];

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  onSessionStart(ctx: SessionStartInput): void {
    this.turnCount = 0;
    this.tokensIn = 0;
    this.tokensOut = 0;
    this.cacheRead = 0;
    this.cacheWrite = 0;
    this.cost = 0;
    this.activeToolName = null;
    this.liveSpeed = null;
    this.speedSamples = [];
    this.sessionName = ctx.sessionManager?.getSessionName?.() ?? null;

    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    let turns = 0;
    for (const entry of branch) {
      if (entry?.type !== "message") continue;
      const message = entry.message;
      if (message?.role !== "assistant") continue;
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      turns += 1;
      const usage = message.usage;
      this.tokensIn += usage?.input ?? 0;
      this.tokensOut += usage?.output ?? 0;
      this.cacheRead += usage?.cacheRead ?? 0;
      this.cacheWrite += usage?.cacheWrite ?? 0;
      this.cost += usage?.cost?.total ?? 0;
    }
    this.turnCount = turns;
  }

  onSessionInfoChanged(event: SessionInfoChangedInput): void {
    this.sessionName = event.name ?? null;
  }

  onTurnEnd(): void {
    this.turnCount += 1;
    this.activeToolName = null;
  }

  onMessageStart(event: MessageEventInput): void {
    if (event.message?.role !== "assistant") return;
    this.liveSpeed = null;
    this.speedSamples = [];
  }

  onMessageUpdate(event: MessageEventInput): void {
    if (event.message?.role !== "assistant") return;
    const now = this.now();

    const usageOut = event.message.usage?.output ?? 0;
    const tokens = usageOut > 0 ? usageOut : Math.round(textLength(event.message.content) / 4);
    if (tokens <= 0) return;

    this.speedSamples.push({ t: now, tokens });
    while (this.speedSamples.length > 1 && now - this.speedSamples[0]!.t > SPEED_WINDOW_MS) {
      this.speedSamples.shift();
    }

    if (this.speedSamples.length >= 2) {
      const oldest = this.speedSamples[0]!;
      const elapsedMs = now - oldest.t;
      const deltaTokens = tokens - oldest.tokens;
      if (elapsedMs > 0 && deltaTokens > 0) {
        this.liveSpeed = Math.round(deltaTokens / (elapsedMs / 1000));
      }
    }
  }

  onMessageEnd(event: MessageEventInput): void {
    const message = event.message;
    if (message?.role !== "assistant") return;
    this.liveSpeed = null;
    this.speedSamples = [];
    if (message.stopReason === "error" || message.stopReason === "aborted") return;

    const usage = message.usage;
    this.tokensIn += usage?.input ?? 0;
    this.tokensOut += usage?.output ?? 0;
    this.cacheRead += usage?.cacheRead ?? 0;
    this.cacheWrite += usage?.cacheWrite ?? 0;
    this.cost += usage?.cost?.total ?? 0;
  }

  onToolExecutionStart(event: ToolExecutionStartInput): void {
    this.activeToolName = event.toolName ?? null;
  }

  onToolExecutionEnd(): void {
    this.activeToolName = null;
  }

  snapshot(): FooterStatsSnapshot {
    return {
      sessionName: this.sessionName,
      turnCount: this.turnCount,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      cost: this.cost,
      activeToolName: this.activeToolName,
      liveSpeed: this.liveSpeed,
    };
  }
}
