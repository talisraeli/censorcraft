import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decideReward,
  defaultStats,
  describeItems,
  parseStats,
  pickEntries,
  PlayerStats,
  previewTier,
  recordAnswer,
  recordTest,
  RewardConfig,
} from "../src/rewardsLogic";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, "../config/rewards.json"), "utf8")) as RewardConfig;

/** Deterministic pseudo-random generator. */
function rng(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);
const fresh = (): PlayerStats => defaultStats();

describe("default rewards.json", () => {
  it("defines all four tiers with sane values", () => {
    for (const tier of ["easy", "medium", "hard", "test"] as const) {
      const t = config.tiers[tier];
      expect(t.items.length).toBeGreaterThan(0);
      expect(t.rolls).toBeGreaterThan(0);
      for (const entry of [...t.items, ...(t.guaranteed ?? [])]) {
        expect(entry.item).toMatch(/^minecraft:[a-z_]+$/);
        expect(entry.max ?? entry.min ?? 1).toBeGreaterThanOrEqual(entry.min ?? 1);
      }
    }
    expect(config.tiers.easy.xpLevels).toBeLessThan(config.tiers.medium.xpLevels);
    expect(config.tiers.medium.xpLevels).toBeLessThan(config.tiers.hard.xpLevels);
    expect(config.tiers.hard.xpLevels).toBeLessThan(config.tiers.test.xpLevels);
    expect(config.tiers.test.title).toBeTruthy();
  });

  it("previews a tier as readable text", () => {
    expect(previewTier(config.tiers.easy)).toBe("bread, iron nugget, coal, apple + 1 XP level");
    expect(previewTier(config.tiers.test)).toMatch(/diamond, golden apple, iron pickaxe \(enchanted\).* \+ 20 XP levels/);
  });
});

describe("reward selection", () => {
  it("grants items from the right tier within the configured ranges", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const d = decideReward(fresh(), { tier: "medium", score: 1, hash: `h${seed}`, now: T0 }, config, rng(seed));
      expect(d.granted).toBe(true);
      expect(d.xpLevels).toBe(config.tiers.medium.xpLevels);
      expect(d.items.length).toBe(config.tiers.medium.rolls);
      expect(new Set(d.items.map((i) => i.item)).size).toBe(d.items.length); // distinct entries
      for (const item of d.items) {
        const entry = config.tiers.medium.items.find((e) => e.item === item.item);
        expect(entry).toBeDefined();
        expect(item.count).toBeGreaterThanOrEqual(entry!.min ?? 1);
        expect(item.count).toBeLessThanOrEqual(entry!.max ?? entry!.min ?? 1);
      }
    }
  });

  it("respects weights", () => {
    const counts: Record<string, number> = {};
    const r = rng(7);
    for (let i = 0; i < 4000; i++) {
      const [entry] = pickEntries(config.tiers.easy.items, 1, r);
      counts[entry!.item] = (counts[entry!.item] ?? 0) + 1;
    }
    // bread has weight 3, apple weight 1.
    expect(counts["minecraft:bread"]! / counts["minecraft:apple"]!).toBeGreaterThan(2);
    expect(counts["minecraft:bread"]! / counts["minecraft:apple"]!).toBeLessThan(4.5);
  });

  it("never draws more entries than exist", () => {
    expect(pickEntries(config.tiers.easy.items, 99, rng()).length).toBe(config.tiers.easy.items.length);
  });

  it("gives the test tier its guaranteed items, enchanted gear and title", () => {
    const d = decideReward(fresh(), { tier: "test", score: 1, hash: "test:abc", now: T0 }, config, rng(3));
    expect(d.granted).toBe(true);
    expect(d.items.map((i) => i.item)).toEqual(expect.arrayContaining(["minecraft:diamond", "minecraft:golden_apple"]));
    expect(d.items.length).toBe(3);
    expect(d.title).toBe("Exam passed!");
    expect(d.xpLevels).toBe(20);
    expect(describeItems(d.items)).toMatch(/\dx diamond/);
  });

  it("gives a reduced reward for partial credit on Hard only", () => {
    const partial = decideReward(fresh(), { tier: "hard", score: 0.6, hash: "p1", now: T0 }, config, rng(2));
    expect(partial.granted).toBe(true);
    expect(partial.partial).toBe(true);
    expect(partial.xpLevels).toBe(Math.floor(config.tiers.hard.xpLevels / 2));
    expect(partial.items.length).toBe(1);

    expect(decideReward(fresh(), { tier: "hard", score: 0.3, hash: "p2", now: T0 }, config).reason).toBe("incorrect");
    expect(decideReward(fresh(), { tier: "medium", score: 0.9, hash: "p3", now: T0 }, config).reason).toBe("incorrect");
    expect(decideReward(fresh(), { tier: "easy", score: 0, hash: "p4", now: T0 }, config).granted).toBe(false);
  });
});

describe("anti-abuse", () => {
  it("applies the per-player cooldown", () => {
    const first = decideReward(fresh(), { tier: "easy", score: 1, hash: "a", now: T0 }, config, rng());
    expect(first.granted).toBe(true);
    const tooSoon = decideReward(first.stats, { tier: "easy", score: 1, hash: "b", now: T0 + 5000 }, config, rng());
    expect(tooSoon.granted).toBe(false);
    expect(tooSoon.reason).toBe("cooldown");
    expect(tooSoon.waitSeconds).toBe(config.cooldownSeconds - 5);
    const later = decideReward(tooSoon.stats, { tier: "easy", score: 1, hash: "c", now: T0 + config.cooldownSeconds * 1000 }, config, rng());
    expect(later.granted).toBe(true);
  });

  it("never rewards the same question twice, even after a wrong first try", () => {
    const first = decideReward(fresh(), { tier: "easy", score: 1, hash: "same", now: T0 }, config, rng());
    const again = decideReward(first.stats, { tier: "easy", score: 1, hash: "same", now: T0 + 3600_000 }, config, rng());
    expect(again.reason).toBe("duplicate");

    const wrong = decideReward(fresh(), { tier: "easy", score: 0, hash: "q9", now: T0 }, config, rng());
    expect(wrong.reason).toBe("incorrect");
    const retry = decideReward(wrong.stats, { tier: "easy", score: 1, hash: "q9", now: T0 + 3600_000 }, config, rng());
    expect(retry.reason).toBe("duplicate");
  });

  it("enforces the daily cap and resets it the next day", () => {
    let stats = fresh();
    const step = (config.cooldownSeconds + 1) * 1000;
    for (let i = 0; i < config.dailyRewardCap; i++) {
      const d = decideReward(stats, { tier: "easy", score: 1, hash: `d${i}`, now: T0 + i * step }, config, rng(i + 1));
      expect(d.granted).toBe(true);
      stats = d.stats;
    }
    const capped = decideReward(stats, { tier: "easy", score: 1, hash: "over", now: T0 + config.dailyRewardCap * step }, config, rng());
    expect(capped.reason).toBe("daily_cap");
    const tomorrow = decideReward(capped.stats, { tier: "easy", score: 1, hash: "new-day", now: T0 + 24 * 3600_000 }, config, rng());
    expect(tomorrow.granted).toBe(true);
    expect(tomorrow.stats.rewardsToday).toBe(1);
  });

  it("keeps only the configured number of remembered questions", () => {
    let stats = fresh();
    const small = { ...config, rememberedQuestions: 3, cooldownSeconds: 0, dailyRewardCap: 1000 };
    for (let i = 0; i < 6; i++) stats = decideReward(stats, { tier: "easy", score: 1, hash: `h${i}`, now: T0 + i }, small, rng()).stats;
    expect(stats.hashes).toEqual(["h3", "h4", "h5"]);
  });
});

describe("player stats", () => {
  it("tracks streak, best streak and counts", () => {
    let s = fresh();
    s = recordAnswer(s, true);
    s = recordAnswer(s, true);
    s = recordAnswer(s, false);
    s = recordAnswer(s, true);
    expect(s).toMatchObject({ answered: 4, correct: 3, streak: 1, bestStreak: 2 });
    s = recordTest(recordTest(s, true), false);
    expect(s).toMatchObject({ testsTaken: 2, testsPassed: 1 });
  });

  it("round-trips through JSON and tolerates corrupt data", () => {
    const s = recordAnswer(decideReward(fresh(), { tier: "easy", score: 1, hash: "x", now: T0 }, config, rng()).stats, true);
    expect(parseStats(JSON.stringify(s))).toEqual(s);
    expect(parseStats(undefined)).toEqual(defaultStats());
    expect(parseStats("{not json")).toEqual(defaultStats());
    expect(parseStats('{"streak": -5, "hashes": "nope", "correct": "many"}')).toEqual(defaultStats());
  });
});
