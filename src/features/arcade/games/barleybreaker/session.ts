import { GameState } from "../adapters/gameTypes";
import { getTodayKey, isRewardRunAvailableForMinigame } from "../poker/session";

export const BARLEY_BREAKER_RAVEN_COIN_REWARD = 1;

export type BarleyBreakerMode = "reward" | "practice";
export type BarleyBreakerDifficultyName = "easy" | "medium" | "hard";
export type PowerUpType =
  | "wide-paddle"
  | "slow-ball"
  | "extra-life"
  | "multiball";

export type BarleyBreakerDifficulty = {
  name: BarleyBreakerDifficultyName;
  label: string;
  targetScore: number;
  startingLives: number;
  baseBallSpeed: number;
  strongBrickChance: number;
  powerUpChance: number;
  weight: number;
};

export const BARLEY_BREAKER_DIFFICULTIES: BarleyBreakerDifficulty[] = [
  {
    name: "easy",
    label: "Easy",
    targetScore: 2600,
    startingLives: 4,
    baseBallSpeed: 280,
    strongBrickChance: 0.1,
    powerUpChance: 0.22,
    weight: 3,
  },
  {
    name: "medium",
    label: "Medium",
    targetScore: 5200,
    startingLives: 3,
    baseBallSpeed: 330,
    strongBrickChance: 0.2,
    powerUpChance: 0.16,
    weight: 3,
  },
  {
    name: "hard",
    label: "Hard",
    targetScore: 7800,
    startingLives: 2,
    baseBallSpeed: 390,
    strongBrickChance: 0.3,
    powerUpChance: 0.1,
    weight: 2,
  },
];

export const getBarleyBreakerDifficultyFromSeed = (
  seed: number,
): BarleyBreakerDifficulty => {
  const totalWeight = BARLEY_BREAKER_DIFFICULTIES.reduce(
    (sum, difficulty) => sum + difficulty.weight,
    0,
  );

  const normalizedSeed =
    ((Math.trunc(seed) % totalWeight) + totalWeight) % totalWeight;

  let threshold = 0;

  for (const difficulty of BARLEY_BREAKER_DIFFICULTIES) {
    threshold += difficulty.weight;

    if (normalizedSeed < threshold) {
      return difficulty;
    }
  }

  return BARLEY_BREAKER_DIFFICULTIES[BARLEY_BREAKER_DIFFICULTIES.length - 1];
};

export const getBarleyBreakerDifficulty = (
  now: Date | number = Date.now(),
): BarleyBreakerDifficulty => {
  const todayKey = getTodayKey(now);

  const seed = todayKey.split("").reduce((accumulator, character) => {
    return Math.imul(accumulator, 31) + character.charCodeAt(0);
  }, 167);

  return getBarleyBreakerDifficultyFromSeed(seed >>> 0);
};

export const isBarleyBreakerRewardRunAvailable = ({
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
    minigame: "barley-breaker" as any,
    isVip,
    now,
  });
};
