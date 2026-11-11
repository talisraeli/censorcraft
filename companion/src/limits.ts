export interface LimitConfig {
  requestsPerMinute: number;
  perPlayerRequestsPerMinute: number;
  maxRequestsPerDay: number;
  maxConcurrentRequests: number;
  /** 0 = unlimited */
  dailyTokenBudget: number;
}

export class LimitError extends Error {
  constructor(
    readonly reason: "player_rate" | "global_rate" | "daily_requests" | "daily_tokens",
    message: string,
  ) {
    super(message);
  }
}

/** Rate, concurrency and cost guard in front of the AI provider. */
export class Limiter {
  private readonly global: number[] = [];
  private readonly perPlayer = new Map<string, number[]>();
  private day = "";
  private dayRequests = 0;
  private dayTokens = 0;
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly config: LimitConfig,
    private readonly now: () => number = Date.now,
  ) {}

  /** Throws LimitError when the request may not be made; otherwise records it. */
  check(playerId: string): void {
    const now = this.now();
    this.rollDay(now);
    const windowStart = now - 60_000;
    prune(this.global, windowStart);
    const mine = this.perPlayer.get(playerId) ?? [];
    prune(mine, windowStart);
    this.perPlayer.set(playerId, mine);

    if (this.config.dailyTokenBudget > 0 && this.dayTokens >= this.config.dailyTokenBudget) {
      throw new LimitError("daily_tokens", "Today's AI token budget is used up. Class resumes tomorrow.");
    }
    if (this.dayRequests >= this.config.maxRequestsPerDay) {
      throw new LimitError("daily_requests", "Today's question limit is used up. Class resumes tomorrow.");
    }
    if (mine.length >= this.config.perPlayerRequestsPerMinute) {
      throw new LimitError("player_rate", "One moment - you are asking faster than I can think. Try again in a minute.");
    }
    if (this.global.length >= this.config.requestsPerMinute) {
      throw new LimitError("global_rate", "The classroom is busy right now. Try again in a minute.");
    }
    this.global.push(now);
    mine.push(now);
    this.dayRequests++;
  }

  recordTokens(count: number): void {
    this.rollDay(this.now());
    this.dayTokens += Math.max(0, count);
  }

  /** Run `fn` holding one of the maxConcurrentRequests slots. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.config.maxConcurrentRequests) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  get stats(): { dayRequests: number; dayTokens: number } {
    return { dayRequests: this.dayRequests, dayTokens: this.dayTokens };
  }

  private rollDay(now: number): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.dayRequests = 0;
      this.dayTokens = 0;
    }
  }
}

function prune(list: number[], windowStart: number): void {
  while (list.length && (list[0] as number) <= windowStart) list.shift();
}
