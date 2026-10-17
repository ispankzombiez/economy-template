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
 * The day's seed — the number that picks the difficulty.
 *
 * One hash per UTC day, so both ends read the target off the calendar and
 * there is nothing to negotiate. The bag used to be dealt from this hash too;
 * it now comes from the seed the server issues for a run at burn time and
 * stores in `active_runs` (`TetrisGame.tsx` opens the runtime with it, and
 * the worker reads it back the same way). A seed chosen inside the claim
 * could be chosen to fit, so the claim carries none: difficulty from the
 * day, bag from the ledger.
 *
 * A run that straddles UTC midnight keeps the difficulty it opened on, which
 * is exactly why that difficulty is baked into the runtime rather than
 * re-derived per step: the park round-trips through D1 between chunk
 * requests, and re-reading the clock on resume would drop a half-played game
 * into a different target.
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
