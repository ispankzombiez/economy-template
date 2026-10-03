import type { GameState, MinigameName } from "../adapters/gameTypes";
import { getTodayKey, isRewardRunAvailableForMinigame } from "../poker/session";

/**
 * Sunflower Brawler — the balance half of the cabinet.
 *
 * The rules are a beat 'em up's: one player, a scrolling street, five waves,
 * and the only thing that ends a run is running out of lives or clearing the
 * last wave. There is no round clock and no best-of-three — a run is a single
 * continuous walk from screen one to screen five.
 *
 * ## Difficulty is one knob set, applied to a crowd
 *
 * Where the fighting game's difficulty tuned *one* opponent, these seven
 * numbers tune every enemy on the screen at once. `reactionMs` is still the
 * real lever (a shorter tick is more opportunities, not smarter play), but two
 * fields exist purely because the opposition is now plural:
 *
 * * `maxAttackers` caps how many enemies may be **mid-swing** simultaneously.
 *   It is what stops a wave from being four hits at once, and it is the single
 *   most effective difficulty control the genre has.
 * * `spacingChance` is the counterpart to `aggression` — the chance an enemy
 *   that is in range chooses to *reposition* instead. There is no jump to dodge
 *   with any more, so pressure that never relents would just be damage.
 */

/** RavenCoins paid for a won reward run. */
export const SUNFLOWER_BRAWLER_RAVEN_COIN_REWARD = 1;

export type SunflowerBrawlerMode = "reward" | "practice";

export type SunflowerBrawlerDifficultyName =
  | "easy"
  | "medium"
  | "hard"
  | "expert";

export type SunflowerBrawlerDifficulty = {
  name: SunflowerBrawlerDifficultyName;
  label: string;
  /** Relative chance of being today's reward-run difficulty. */
  weight: number;
  /**
   * Milliseconds between an enemy's decisions.
   *
   * This is the difficulty's real lever. An enemy reads the whole board every
   * tick, so a short tick is not "smarter" — it simply has far more
   * opportunities to notice that you are winded and step into you.
   */
  reactionMs: number;
  /** Chance, per decision, that an in-range enemy commits to a swing. */
  aggression: number;
  /** Chance, per committed swing, of throwing the heavy rather than the jab. */
  heavyChance: number;
  /** Chance, per decision, of repositioning instead of committing. */
  spacingChance: number;
  /** Walk-speed multiplier. Stacks with the enemy's own speed. */
  speed: number;
  /** Health multiplier for every enemy in the run. */
  hpMultiplier: number;
  /**
   * How many enemies may be mid-swing at the same instant.
   *
   * The wave is still dangerous with one — it is the *others* closing in while
   * you deal with it that do the work — but this is the number that decides
   * whether a mistake costs one hit or three.
   */
  maxAttackers: number;
};

const difficulty = (
  name: SunflowerBrawlerDifficultyName,
  label: string,
  weight: number,
  reactionMs: number,
  aggression: number,
  heavyChance: number,
  spacingChance: number,
  speed: number,
  hpMultiplier: number,
  maxAttackers: number,
): SunflowerBrawlerDifficulty => ({
  name,
  label,
  weight,
  reactionMs,
  aggression,
  heavyChance,
  spacingChance,
  speed,
  hpMultiplier,
  maxAttackers,
});

export const SUNFLOWER_BRAWLER_DIFFICULTIES: SunflowerBrawlerDifficulty[] = [
  difficulty("easy", "Easy", 3, 430, 0.42, 0.15, 0.35, 0.86, 0.9, 1),
  difficulty("medium", "Medium", 3, 310, 0.58, 0.28, 0.25, 0.96, 1, 2),
  difficulty("hard", "Hard", 2, 220, 0.7, 0.4, 0.18, 1.05, 1.08, 2),
  difficulty("expert", "Expert", 1, 150, 0.84, 0.52, 0.12, 1.12, 1.16, 3),
];

export const getSunflowerBrawlerDifficultyFromSeed = (
  seed: number,
): SunflowerBrawlerDifficulty => {
  const totalWeight = SUNFLOWER_BRAWLER_DIFFICULTIES.reduce(
    (sum, difficulty) => sum + difficulty.weight,
    0,
  );

  const normalizedSeed =
    ((Math.trunc(seed) % totalWeight) + totalWeight) % totalWeight;

  let threshold = 0;
  for (const difficulty of SUNFLOWER_BRAWLER_DIFFICULTIES) {
    threshold += difficulty.weight;
    if (normalizedSeed < threshold) return difficulty;
  }

  return SUNFLOWER_BRAWLER_DIFFICULTIES[
    SUNFLOWER_BRAWLER_DIFFICULTIES.length - 1
  ];
};

/**
 * Today's reward-run difficulty, seeded from the UTC day key so every player
 * faces the same wave tuning on the same day and it cannot be re-rolled by
 * refreshing.
 */
export const getSunflowerBrawlerDifficulty = (
  now: Date | number = Date.now(),
): SunflowerBrawlerDifficulty => {
  const todayKey = getTodayKey(now);

  const seed = todayKey.split("").reduce((accumulator, character) => {
    return Math.imul(accumulator, 31) + character.charCodeAt(0);
  }, 7);

  return getSunflowerBrawlerDifficultyFromSeed(seed >>> 0);
};

export const isSunflowerBrawlerRewardRunAvailable = ({
  game,
  isVip,
  now = Date.now(),
}: {
  game: GameState;
  isVip: boolean;
  now?: Date | number;
}): boolean => {
  return isRewardRunAvailableForMinigame({
    game,
    minigame: "sunflower-brawler" as MinigameName,
    isVip,
    now,
  });
};
