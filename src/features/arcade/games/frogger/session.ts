import { GameState } from "../adapters/gameTypes";
import { getTodayKey, isRewardRunAvailableForMinigame } from "../poker/session";

export const FROGGER_RAVEN_COIN_REWARD = 1;

export type FroggerMode = "reward" | "practice";
export type FroggerDifficultyName = "easy" | "medium" | "hard";

export type FroggerDifficulty = {
  name: FroggerDifficultyName;
  label: string;
  targetScore: number;
  startingLives: number;
  laneSpeedMultiplier: number;
  hazardDensity: number;
  weight: number;
};

export const FROGGER_DIFFICULTIES: FroggerDifficulty[] = [
  {
    name: "easy",
    label: "Easy",
    targetScore: 800,
    startingLives: 3,
    laneSpeedMultiplier: 1.0,
    hazardDensity: 0.45,
    weight: 3,
  },
  {
    name: "medium",
    label: "Medium",
    targetScore: 1600,
    startingLives: 3,
    laneSpeedMultiplier: 1.3,
    hazardDensity: 0.6,
    weight: 3,
  },
  {
    name: "hard",
    label: "Hard",
    targetScore: 2800,
    startingLives: 3,
    laneSpeedMultiplier: 1.7,
    hazardDensity: 0.75,
    weight: 2,
  },
];

export const getFroggerDifficultyFromSeed = (
  seed: number,
): FroggerDifficulty => {
  const totalWeight = FROGGER_DIFFICULTIES.reduce(
    (sum, difficulty) => sum + difficulty.weight,
    0,
  );

  const normalizedSeed =
    ((Math.trunc(seed) % totalWeight) + totalWeight) % totalWeight;

  let threshold = 0;

  for (const difficulty of FROGGER_DIFFICULTIES) {
    threshold += difficulty.weight;

    if (normalizedSeed < threshold) {
      return difficulty;
    }
  }

  return FROGGER_DIFFICULTIES[FROGGER_DIFFICULTIES.length - 1];
};

export const getFroggerDifficulty = (
  now: Date | number = Date.now(),
): FroggerDifficulty => {
  const todayKey = getTodayKey(now);

  const seed = todayKey.split("").reduce((accumulator, character) => {
    return Math.imul(accumulator, 31) + character.charCodeAt(0);
  }, 239);

  return getFroggerDifficultyFromSeed(seed >>> 0);
};

export const isFroggerRewardRunAvailable = ({
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
    minigame: "frogger" as any,
    isVip,
    now,
  });
};
