import { GameState } from "../adapters/gameTypes";
import { MinigameName } from "../adapters/gameTypes";
import {
  getTodayKey,
  isRewardRunAvailableForMinigame,
} from "../poker/session";

export const TETRIS_RAVEN_COIN_REWARD = 1;

export type TetrisMode = "reward" | "practice";
export type TetrisDifficultyName = "easy" | "medium" | "hard";

export type TetrisDifficulty = {
  name: TetrisDifficultyName;
  label: string;
  targetScore: number;
  startLevel: number;
  weight: number;
};

export const TETRIS_DIFFICULTIES: TetrisDifficulty[] = [
  {
    name: "easy",
    label: "Easy",
    targetScore: 12000,
    startLevel: 1,
    weight: 3,
  },
  {
    name: "medium",
    label: "Medium",
    targetScore: 35000,
    startLevel: 3,
    weight: 3,
  },
  {
    name: "hard",
    label: "Hard",
    targetScore: 80000,
    startLevel: 5,
    weight: 2,
  },
];

export const getTetrisDifficultyFromSeed = (seed: number): TetrisDifficulty => {
  const totalWeight = TETRIS_DIFFICULTIES.reduce(
    (sum, difficulty) => sum + difficulty.weight,
    0,
  );

  const normalizedSeed =
    ((Math.trunc(seed) % totalWeight) + totalWeight) % totalWeight;

  let threshold = 0;

  for (const difficulty of TETRIS_DIFFICULTIES) {
    threshold += difficulty.weight;

    if (normalizedSeed < threshold) {
      return difficulty;
    }
  }

  return TETRIS_DIFFICULTIES[TETRIS_DIFFICULTIES.length - 1];
};

export const getTetrisDifficulty = (
  now: Date | number = Date.now(),
): TetrisDifficulty => {
  const todayKey = getTodayKey(now);

  const seed = todayKey.split("").reduce((accumulator, character) => {
    return Math.imul(accumulator, 31) + character.charCodeAt(0);
  }, 131);

  return getTetrisDifficultyFromSeed(seed >>> 0);
};

export const isTetrisRewardRunAvailable = ({
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
    minigame: "tetris" as MinigameName,
    isVip,
    now,
  });
};
