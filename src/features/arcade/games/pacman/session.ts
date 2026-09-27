import { GameState } from "../adapters/gameTypes";
import { getTodayKey, isRewardRunAvailableForMinigame } from "../poker/session";

// ── Reward ────────────────────────────────────────────────────────────────────
export const PAC_MAN_RAVEN_COIN_REWARD = 1;

// ── Scoring constants (classic Pac-Man values) ───────────────────────────────
export const PELLET_POINTS = 10;
export const POWER_PELLET_POINTS = 50;
/** Ghost-eating bonus sequence per power-up window: 200, 400, 800, 1600 */
export const GHOST_EAT_BONUS = [200, 400, 800, 1600] as const;

// ── Maze layout constants ─────────────────────────────────────────────────────
/** Total small pellets in the standard maze */
export const TOTAL_MAZE_PELLETS = 240;
/** Total power pellets (kale) in the standard maze */
export const TOTAL_POWER_PELLETS = 4;

/** Points from clearing all pellets once (no ghost eating) */
const FULL_CLEAR_PELLET_SCORE =
  TOTAL_MAZE_PELLETS * PELLET_POINTS +
  TOTAL_POWER_PELLETS * POWER_PELLET_POINTS;

// ── Difficulty types ──────────────────────────────────────────────────────────
export type PacManMode = "reward" | "practice";
export type PacManDifficultyName = "easy" | "medium" | "hard";

export type PacManDifficulty = {
  name: PacManDifficultyName;
  label: string;
  /**
   * Score threshold to win.
   * Easy  = 1 full clear + 25% of a second clear (collecting goblins counts too).
   * Medium = 2 full clears.
   * Hard   = 3 full clears.
   */
  targetScore: number;
  /** Ghost base speed multiplier (1.0 = normal) */
  ghostSpeedMultiplier: number;
  /**
   * How long the frightened (power-up) state lasts in milliseconds.
   * Classic ~6-7 seconds on normal difficulty.
   */
  frightenedDurationMs: number;
  /** Weighted probability for daily selection */
  weight: number;
};

export const PAC_MAN_DIFFICULTIES: PacManDifficulty[] = [
  {
    name: "easy",
    label: "Easy",
    // One full clear + 25%
    targetScore: Math.round(FULL_CLEAR_PELLET_SCORE * 1.25),
    ghostSpeedMultiplier: 0.75,
    frightenedDurationMs: 8000,
    weight: 3,
  },
  {
    name: "medium",
    label: "Medium",
    // Two full clears
    targetScore: FULL_CLEAR_PELLET_SCORE * 2,
    ghostSpeedMultiplier: 1.0,
    frightenedDurationMs: 6500,
    weight: 3,
  },
  {
    name: "hard",
    label: "Hard",
    // Three full clears
    targetScore: FULL_CLEAR_PELLET_SCORE * 3,
    ghostSpeedMultiplier: 1.3,
    frightenedDurationMs: 5000,
    weight: 2,
  },
];

// ── Daily difficulty selection ────────────────────────────────────────────────
export const getPacManDifficultyFromSeed = (seed: number): PacManDifficulty => {
  const totalWeight = PAC_MAN_DIFFICULTIES.reduce(
    (sum, d) => sum + d.weight,
    0,
  );
  const normalizedSeed =
    ((Math.trunc(seed) % totalWeight) + totalWeight) % totalWeight;

  let threshold = 0;
  for (const difficulty of PAC_MAN_DIFFICULTIES) {
    threshold += difficulty.weight;
    if (normalizedSeed < threshold) return difficulty;
  }

  return PAC_MAN_DIFFICULTIES[PAC_MAN_DIFFICULTIES.length - 1];
};

export const getPacManDifficulty = (
  now: Date | number = Date.now(),
): PacManDifficulty => {
  const todayKey = getTodayKey(now);
  const seed = todayKey.split("").reduce((acc, ch) => {
    return Math.imul(acc, 31) + ch.charCodeAt(0);
  }, 113);

  return getPacManDifficultyFromSeed(seed >>> 0);
};

// ── Reward availability ───────────────────────────────────────────────────────
export const isPacManRewardRunAvailable = ({
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
    minigame: "pac-man" as any,
    isVip,
    now,
  });
};
