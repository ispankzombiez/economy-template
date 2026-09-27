import { GameState } from "../adapters/gameTypes";
import { getTodayKey, isRewardRunAvailableForMinigame } from "../poker/session";

export const SOLITAIRE_RAVEN_COIN_REWARD = 1;

export type SolitaireMode = "reward" | "practice";
export type SolitaireDifficultyName = "easy" | "medium" | "hard";

export type SolitaireDifficulty = {
  name: SolitaireDifficultyName;
  label: string;
  drawCount: 1 | 3;
  maxPasses: number;
  weight: number;
};

export const SOLITAIRE_DIFFICULTIES: SolitaireDifficulty[] = [
  { name: "easy", label: "Easy", drawCount: 1, maxPasses: 5, weight: 3 },
  { name: "medium", label: "Medium", drawCount: 1, maxPasses: 3, weight: 3 },
  { name: "hard", label: "Hard", drawCount: 3, maxPasses: 1, weight: 2 },
];

export const getSolitaireDifficultyFromSeed = (
  seed: number,
): SolitaireDifficulty => {
  const totalWeight = SOLITAIRE_DIFFICULTIES.reduce(
    (sum, difficulty) => sum + difficulty.weight,
    0,
  );

  const normalizedSeed =
    ((Math.trunc(seed) % totalWeight) + totalWeight) % totalWeight;

  let threshold = 0;

  for (const difficulty of SOLITAIRE_DIFFICULTIES) {
    threshold += difficulty.weight;

    if (normalizedSeed < threshold) {
      return difficulty;
    }
  }

  return SOLITAIRE_DIFFICULTIES[SOLITAIRE_DIFFICULTIES.length - 1];
};

export const getSolitaireSeed = (now: Date | number = Date.now()) => {
  const todayKey = getTodayKey(now);

  const seed = todayKey.split("").reduce((accumulator, character) => {
    return Math.imul(accumulator, 31) + character.charCodeAt(0);
  }, 29);

  return seed >>> 0;
};

export const getSolitaireDifficulty = (
  now: Date | number = Date.now(),
): SolitaireDifficulty => {
  return getSolitaireDifficultyFromSeed(getSolitaireSeed(now));
};

export const isSolitaireRewardRunAvailable = ({
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
    minigame: "solitaire" as any,
    isVip,
    now,
  });
};
