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
  return getTetrisDifficultyFromSeed(getTetrisDaySeed(now));
};

/**
 * The bag seed for a run opened on a given day.
 *
 * The *same number* that picks the difficulty, exposed as its own function
 * because the piece bag is generated from it too — the run has to be a single
 * reproducible thing, not a difficulty that is reproducible and a bag that is
 * not.
 *
 * It is the day's hash rather than a fresh random number because the worker
 * cannot be told it: it re-derives the day from the UTC clock, accepts only
 * today's or yesterday's difficulty name, and rebuilds the bag from the same
 * hash. A client-chosen seed could not be checked, so every honest run would be
 * refused — the coin would cost a ticket and never pay.
 *
 * A run that straddles UTC midnight keeps this number, which is exactly why it
 * is baked into the runtime rather than re-derived per step: the park
 * round-trips through D1 between chunk requests, and re-reading the clock on
 * resume would deal a new bag into a game that was already half-played.
 */
export const getTetrisDaySeed = (now: Date | number = Date.now()): number => {
  const todayKey = getTodayKey(now);

  return (
    todayKey
      .split("")
      .reduce((accumulator, character) => {
        return Math.imul(accumulator, 31) + character.charCodeAt(0);
      }, 131) >>> 0
  );
};

/**
 * A bag seed for a *practice* run.
 *
 * Practice pays nothing and is never verified, so nothing needs to be able to
 * check this number — it is drawn locally rather than issued, which is what lets
 * a practice run start instantly instead of waiting on a round trip it does not
 * need. From `crypto` rather than `Math.random`, so it is drawn the same way on
 * every browser and not from a source the engines were kept clear of.
 */
export const getTetrisPracticeSeed = (): number => {
  const drawn = globalThis.crypto?.getRandomValues?.(new Uint32Array(1));
  return drawn ? drawn[0] : (Date.now() >>> 0) ^ 0x9e3779b9;
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
