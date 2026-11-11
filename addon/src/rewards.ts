import { EnchantmentType, ItemStack, Player } from "@minecraft/server";
import rewardsJson from "../config/rewards.json";
import {
  decideReward,
  describeItems,
  GrantedItem,
  parseStats,
  PlayerStats,
  previewTier,
  RewardConfig,
  RewardDecision,
  TierName,
} from "./rewardsLogic";
import { S } from "./strings";

export const rewardConfig = rewardsJson as unknown as RewardConfig;

const STATS_PROPERTY = "censor:stats";

export function loadStats(player: Player): PlayerStats {
  try {
    return parseStats(player.getDynamicProperty(STATS_PROPERTY));
  } catch {
    return parseStats(undefined);
  }
}

export function saveStats(player: Player, stats: PlayerStats): void {
  try {
    player.setDynamicProperty(STATS_PROPERTY, JSON.stringify(stats));
  } catch (e) {
    console.warn(`[CensorCraft] could not save stats: ${String(e)}`);
  }
}

export function tierPreview(tier: TierName): string {
  return previewTier(rewardConfig.tiers[tier]);
}

export function statsSummary(stats: PlayerStats): string {
  return S.statsWithTests(S.statsLine(stats.correct, stats.answered, stats.streak, stats.bestStreak), stats.testsPassed, stats.testsTaken);
}

/** "Rewards left today / cooldown" line for the difficulty menu. */
export function rewardStatus(stats: PlayerStats): string {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const used = stats.day === today ? stats.rewardsToday : 0;
  const cooldown = stats.lastRewardAt > 0 ? Math.ceil(rewardConfig.cooldownSeconds - (now - stats.lastRewardAt) / 1000) : 0;
  return S.statusLine(Math.max(0, rewardConfig.dailyRewardCap - used), Math.max(0, cooldown));
}

function giveItem(player: Player, granted: GrantedItem): void {
  let remaining = granted.count;
  while (remaining > 0) {
    let stack: ItemStack;
    try {
      stack = new ItemStack(granted.item, 1);
    } catch {
      console.warn(`[CensorCraft] rewards.json names an unknown item: ${granted.item}`);
      return;
    }
    const amount = Math.min(remaining, stack.maxAmount);
    stack.amount = amount;
    remaining -= amount;
    if (granted.enchantments) {
      const enchantable = stack.getComponent("minecraft:enchantable");
      for (const [id, level] of Object.entries(granted.enchantments)) {
        try {
          enchantable?.addEnchantment({ type: new EnchantmentType(id), level });
        } catch {
          console.warn(`[CensorCraft] cannot apply enchantment ${id} ${level} to ${granted.item}`);
        }
      }
    }
    const container = player.getComponent("minecraft:inventory")?.container;
    const leftover = container ? container.addItem(stack) : stack;
    // Full inventory: drop the rest at the player's feet rather than losing it.
    if (leftover) player.dimension.spawnItem(leftover, player.location);
  }
}

/**
 * Apply the anti-abuse rules and, when allowed, hand out the reward.
 * Returns the decision (with updated stats already saved) and a line of text
 * describing what happened.
 */
export function rewardPlayer(player: Player, stats: PlayerStats, tier: TierName, score: number, hash: string): { decision: RewardDecision; text: string } {
  const decision = decideReward(stats, { tier, score, hash, now: Date.now() }, rewardConfig);
  saveStats(player, decision.stats);
  if (!decision.granted) {
    const reason = decision.reason ?? "incorrect";
    const text = reason === "cooldown" ? S.rewardDenied.cooldown(decision.waitSeconds ?? 0) : S.rewardDenied[reason];
    return { decision, text };
  }
  for (const item of decision.items) giveItem(player, item);
  if (decision.xpLevels > 0) player.addLevels(decision.xpLevels);
  if (decision.title) {
    try {
      player.onScreenDisplay.setTitle(decision.title, { subtitle: decision.subtitle, fadeInDuration: 10, stayDuration: 70, fadeOutDuration: 20 });
    } catch {
      /* cosmetic */
    }
  }
  return { decision, text: S.rewardGranted(describeItems(decision.items), decision.xpLevels) };
}
