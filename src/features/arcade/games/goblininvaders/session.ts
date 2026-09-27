import { GameState } from "../adapters/gameTypes";
import { getTodayKey, isRewardRunAvailableForMinigame } from "../poker/session";

export const GOBLIN_INVADERS_RAVEN_COIN_REWARD = 1;

export type GoblinInvadersMode = "reward" | "practice";
export type GoblinInvadersDifficultyName = "easy" | "medium" | "hard";

export type GoblinInvadersDifficulty = {
  name: GoblinInvadersDifficultyName;
  label: string;
  targetScore: number;
  maxWaves: number;
  baseEnemySpeed: number;
  baseEnemyFireMs: number;
  weight: number;
};

const EASY_TARGET_SCORE = 1200;
const MEDIUM_TARGET_SCORE = 2400;
const HARD_TARGET_SCORE = 3800;

export const GOBLIN_INVADERS_DIFFICULTIES: GoblinInvadersDifficulty[] = [
  {
    name: "easy",
    label: "Easy",
    targetScore: EASY_TARGET_SCORE,
    maxWaves: 2,
    baseEnemySpeed: 40,
    baseEnemyFireMs: 1500,
    weight: 3,
  },
  {
    name: "medium",
    label: "Medium",
    targetScore: MEDIUM_TARGET_SCORE,
    maxWaves: 3,
    baseEnemySpeed: 56,
    baseEnemyFireMs: 1250,
    weight: 3,
  },
  {
    name: "hard",
    label: "Hard",
    targetScore: HARD_TARGET_SCORE,
    maxWaves: 5,
    baseEnemySpeed: 72,
    baseEnemyFireMs: 1000,
    weight: 2,
  },
];

export const getGoblinInvadersDifficultyFromSeed = (
  seed: number,
): GoblinInvadersDifficulty => {
  const totalWeight = GOBLIN_INVADERS_DIFFICULTIES.reduce(
    (sum, difficulty) => sum + difficulty.weight,
    0,
  );

  const normalizedSeed =
    ((Math.trunc(seed) % totalWeight) + totalWeight) % totalWeight;

  let threshold = 0;

  for (const difficulty of GOBLIN_INVADERS_DIFFICULTIES) {
    threshold += difficulty.weight;

    if (normalizedSeed < threshold) {
      return difficulty;
    }
  }

  return GOBLIN_INVADERS_DIFFICULTIES[GOBLIN_INVADERS_DIFFICULTIES.length - 1];
};

export const getGoblinInvadersDifficulty = (
  now: Date | number = Date.now(),
): GoblinInvadersDifficulty => {
  const todayKey = getTodayKey(now);

  const seed = todayKey.split("").reduce((accumulator, character) => {
    return Math.imul(accumulator, 31) + character.charCodeAt(0);
  }, 97);

  return getGoblinInvadersDifficultyFromSeed(seed >>> 0);
};

export const isGoblinInvadersRewardRunAvailable = ({
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
    minigame: "goblin-invaders" as any,
    isVip,
    now,
  });
};
