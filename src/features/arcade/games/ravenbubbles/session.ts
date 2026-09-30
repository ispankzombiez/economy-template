import type { GameState, MinigameName } from "../adapters/gameTypes";
import { getTodayKey, isRewardRunAvailableForMinigame } from "../poker/session";

/**
 * Raven Bubbles — the balance half of the cabinet.
 *
 * The rules are deliberately the original game's: one screen, keep shooting,
 * and the only thing that ends a run is the cluster reaching the line. Clearing
 * a screen deals a fresh one and the run carries on, so the **whole** of a
 * difficulty is how many screens have to be cleared in a single life.
 *
 * Each screen is a self-contained stage: the ceiling returns to the top on every
 * refill, so a run is a chain of stages rather than one long slide toward the
 * line. That reset is what makes the higher counts possible at all — the ceiling
 * only ever descends, so without it a tenth screen would be dealt underneath the
 * anchor and fall apart on arrival.
 */

export const RAVEN_BUBBLES_RAVEN_COIN_REWARD = 1;

export type RavenBubblesMode = "reward" | "practice";
export type RavenBubblesDifficultyName = "easy" | "medium" | "hard" | "expert";

export type RavenBubblesDifficulty = {
  name: RavenBubblesDifficultyName;
  label: string;
  /**
   * Screens to clear in one run. This is the entire win condition, and the only
   * thing a difficulty changes.
   */
  boards: number;
  /** Relative chance of being today's reward-run difficulty. */
  weight: number;
};

export const RAVEN_BUBBLES_DIFFICULTIES: RavenBubblesDifficulty[] = [
  { name: "easy", label: "Easy", boards: 1, weight: 3 },
  { name: "medium", label: "Medium", boards: 2, weight: 3 },
  { name: "hard", label: "Hard", boards: 4, weight: 2 },
  { name: "expert", label: "Expert", boards: 10, weight: 1 },
];

export const getRavenBubblesDifficultyFromSeed = (
  seed: number,
): RavenBubblesDifficulty => {
  const totalWeight = RAVEN_BUBBLES_DIFFICULTIES.reduce(
    (total, difficulty) => total + difficulty.weight,
    0,
  );

  const normalizedSeed =
    ((Math.trunc(seed) % totalWeight) + totalWeight) % totalWeight;

  let threshold = 0;
  for (const difficulty of RAVEN_BUBBLES_DIFFICULTIES) {
    threshold += difficulty.weight;
    if (normalizedSeed < threshold) return difficulty;
  }

  return RAVEN_BUBBLES_DIFFICULTIES[RAVEN_BUBBLES_DIFFICULTIES.length - 1];
};

/**
 * Today's reward-run difficulty, seeded from the UTC day key so every player
 * gets the same board on the same day and it cannot be re-rolled by refreshing.
 */
export const getRavenBubblesDifficulty = (
  now: Date | number = Date.now(),
): RavenBubblesDifficulty => {
  const todayKey = getTodayKey(now);

  const seed = todayKey.split("").reduce((accumulator, character) => {
    return Math.imul(accumulator, 31) + character.charCodeAt(0);
  }, 7);

  return getRavenBubblesDifficultyFromSeed(seed >>> 0);
};

export const isRavenBubblesRewardRunAvailable = ({
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
    minigame: "raven-bubbles" as MinigameName,
    isVip,
    now,
  });
};
