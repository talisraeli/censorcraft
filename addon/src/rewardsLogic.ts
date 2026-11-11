/**
 * Pure reward + anti-abuse logic. No @minecraft imports, so it is unit-tested
 * in Node. The add-on's rewards.ts applies the decisions to a real player.
 */

export type TierName = "easy" | "medium" | "hard" | "test";

export interface RewardEntry {
  item: string;
  min?: number;
  max?: number;
  weight?: number;
  enchantments?: Record<string, number>;
}

export interface RewardTier {
  xpLevels: number;
  rolls: number;
  items: RewardEntry[];
  guaranteed?: RewardEntry[];
  title?: string;
  subtitle?: string;
}

export interface RewardConfig {
  cooldownSeconds: number;
  dailyRewardCap: number;
  partialCreditMinScore: number;
  rememberedQuestions: number;
  tiers: Record<TierName, RewardTier>;
}

export interface PlayerStats {
  /** UTC day (YYYY-MM-DD) that `rewardsToday` refers to. */
  day: string;
  rewardsToday: number;
  /** Epoch ms of the last granted reward. */
  lastRewardAt: number;
  /** Hashes of questions already answered (newest last). */
  hashes: string[];
  streak: number;
  bestStreak: number;
  correct: number;
  answered: number;
  testsTaken: number;
  testsPassed: number;
}

export interface GrantedItem {
  item: string;
  count: number;
  enchantments?: Record<string, number>;
}

export type DenyReason = "incorrect" | "duplicate" | "daily_cap" | "cooldown";

export interface RewardDecision {
  granted: boolean;
  reason?: DenyReason;
  /** Seconds until the cooldown ends (reason === "cooldown"). */
  waitSeconds?: number;
  /** True when a reduced Hard reward was given for partial credit. */
  partial: boolean;
  items: GrantedItem[];
  xpLevels: number;
  title?: string;
  subtitle?: string;
  /** Updated stats to persist (always returned, also when denied). */
  stats: PlayerStats;
}

export interface RewardRequest {
  tier: TierName;
  /** 0..1. For "test" pass 1 when the exam was passed, 0 otherwise. */
  score: number;
  /** Question (or exam) hash for dedupe. */
  hash: string;
  /** Epoch ms. */
  now: number;
}

export function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function defaultStats(): PlayerStats {
  return { day: "", rewardsToday: 0, lastRewardAt: 0, hashes: [], streak: 0, bestStreak: 0, correct: 0, answered: 0, testsTaken: 0, testsPassed: 0 };
}

/** Tolerant parser for the JSON stored in a player's dynamic property. */
export function parseStats(raw: unknown): PlayerStats {
  const base = defaultStats();
  if (typeof raw !== "string" || raw === "") return base;
  try {
    const v = JSON.parse(raw) as Partial<PlayerStats>;
    const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : d);
    return {
      day: typeof v.day === "string" ? v.day : "",
      rewardsToday: num(v.rewardsToday, 0),
      lastRewardAt: num(v.lastRewardAt, 0),
      hashes: Array.isArray(v.hashes) ? v.hashes.filter((h): h is string => typeof h === "string").slice(-1000) : [],
      streak: num(v.streak, 0),
      bestStreak: num(v.bestStreak, 0),
      correct: num(v.correct, 0),
      answered: num(v.answered, 0),
      testsTaken: num(v.testsTaken, 0),
      testsPassed: num(v.testsPassed, 0),
    };
  } catch {
    return base;
  }
}

/** Update streak / counters after a graded practice answer. */
export function recordAnswer(stats: PlayerStats, correct: boolean): PlayerStats {
  const streak = correct ? stats.streak + 1 : 0;
  return {
    ...stats,
    answered: stats.answered + 1,
    correct: stats.correct + (correct ? 1 : 0),
    streak,
    bestStreak: Math.max(stats.bestStreak, streak),
  };
}

export function recordTest(stats: PlayerStats, passed: boolean): PlayerStats {
  return { ...stats, testsTaken: stats.testsTaken + 1, testsPassed: stats.testsPassed + (passed ? 1 : 0) };
}

function rollCount(entry: RewardEntry, rng: () => number): number {
  const min = Math.max(1, Math.floor(entry.min ?? 1));
  const max = Math.max(min, Math.floor(entry.max ?? min));
  return min + Math.floor(rng() * (max - min + 1));
}

/** Draw `rolls` distinct entries by weight. */
export function pickEntries(entries: RewardEntry[], rolls: number, rng: () => number): RewardEntry[] {
  const pool = entries.filter((e) => (e.weight ?? 1) > 0);
  const picked: RewardEntry[] = [];
  while (picked.length < rolls && pool.length > 0) {
    const total = pool.reduce((sum, e) => sum + (e.weight ?? 1), 0);
    let ticket = rng() * total;
    let index = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      ticket -= (pool[i] as RewardEntry).weight ?? 1;
      if (ticket < 0) {
        index = i;
        break;
      }
    }
    picked.push(pool.splice(index, 1)[0] as RewardEntry);
  }
  return picked;
}

/**
 * Decide whether an answer earns a reward and which one.
 * Checks, in order: correctness, duplicate question, daily cap, cooldown.
 * The question hash is remembered on every graded answer, so a question that
 * was answered wrongly cannot be farmed later either.
 */
export function decideReward(input: PlayerStats, request: RewardRequest, config: RewardConfig, rng: () => number = Math.random): RewardDecision {
  const today = dayKey(request.now);
  let stats: PlayerStats = input.day === today ? { ...input } : { ...input, day: today, rewardsToday: 0 };
  const seen = stats.hashes.includes(request.hash);
  if (!seen && request.hash) {
    stats = { ...stats, hashes: [...stats.hashes, request.hash].slice(-Math.max(1, config.rememberedQuestions)) };
  }
  const deny = (reason: DenyReason, waitSeconds?: number): RewardDecision => ({
    granted: false,
    reason,
    waitSeconds,
    partial: false,
    items: [],
    xpLevels: 0,
    stats,
  });

  const full = request.score >= 0.999;
  const partial = !full && request.tier === "hard" && request.score >= config.partialCreditMinScore;
  if (!full && !partial) return deny("incorrect");
  if (seen) return deny("duplicate");
  if (stats.rewardsToday >= config.dailyRewardCap) return deny("daily_cap");
  const elapsed = (request.now - stats.lastRewardAt) / 1000;
  if (stats.lastRewardAt > 0 && elapsed >= 0 && elapsed < config.cooldownSeconds) {
    return deny("cooldown", Math.ceil(config.cooldownSeconds - elapsed));
  }

  const tier = config.tiers[request.tier];
  const factor = partial ? 0.5 : 1;
  const rolls = Math.max(1, Math.floor(tier.rolls * factor));
  const entries = [...(partial ? [] : (tier.guaranteed ?? [])), ...pickEntries(tier.items, rolls, rng)];
  const items: GrantedItem[] = entries.map((entry) => ({
    item: entry.item,
    count: Math.max(1, Math.floor(rollCount(entry, rng) * factor)),
    ...(entry.enchantments ? { enchantments: entry.enchantments } : {}),
  }));
  stats = { ...stats, rewardsToday: stats.rewardsToday + 1, lastRewardAt: request.now };
  return {
    granted: true,
    partial,
    items,
    xpLevels: Math.floor(tier.xpLevels * factor),
    title: partial ? undefined : tier.title,
    subtitle: partial ? undefined : tier.subtitle,
    stats,
  };
}

export function prettyItem(id: string): string {
  return id.replace(/^minecraft:/, "").replace(/_/g, " ");
}

/** "bread, iron nugget, coal, apple + 1 XP level" */
export function previewTier(tier: RewardTier): string {
  const names = [...(tier.guaranteed ?? []), ...tier.items].map((e) => prettyItem(e.item) + (e.enchantments ? " (enchanted)" : ""));
  const unique = [...new Set(names)];
  return `${unique.join(", ")} + ${tier.xpLevels} XP level${tier.xpLevels === 1 ? "" : "s"}`;
}

export function describeItems(items: GrantedItem[]): string {
  return items.map((i) => `${i.count}x ${prettyItem(i.item)}${i.enchantments ? " (enchanted)" : ""}`).join(", ");
}
