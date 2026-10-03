import type { GameState, MinigameName } from "../adapters/gameTypes";
import { getTodayKey, isRewardRunAvailableForMinigame } from "../poker/session";

/**
 * Raven Bubbles — the balance half of the cabinet.
 *
 * The rules are deliberately the original game's: one screen, keep shooting,
 * and the only thing that ends a run is the cluster reaching the line. Clearing
 * a screen deals a fresh one and the run carries on, so a run is a chain of
 * screens.
 *
 * ## The daily goal is a score
 *
 * A run is **won on points**, not on a screen counter. Screens are how the game
 * is *framed*; the number the player chases is a score, set outright per
 * difficulty rather than derived.
 *
 * An earlier version derived the target as `screens x 50 x 10`, on the reasoning
 * that clearing a screen the ordinary way lands on exactly that. It does — but a
 * **drop pays double**, and drops are free bubbles: cut one cluster out and
 * everything it was holding up falls. A bot firing purely random angles reached
 * 500 of Easy's 500 having cleared not one screen, so a target built from the
 * pop value alone was not a screen's worth of work. The targets are now set
 * outright. Read against {@link BUBBLES_PER_SCREEN} x {@link POINTS_PER_POP} —
 * what one screen is worth if every bubble in it is popped — the targets are
 * three, six, fifteen and thirty screens of ordinary work.
 *
 * A drop-heavy player is still rewarded: they can reach a target ahead of the
 * screen count, they just have to do three screens' worth of it rather than one.
 *
 * ## The screen size lives here, not in the cabinet
 *
 * The deal's row and column counts are declared in this file and imported by the
 * cabinet, so the grid has one home. The cabinet has no screens of its own to
 * count: a screen is simply a fresh deal, and the player is never shown a tally.
 *
 * ## Each screen is its own stage
 *
 * The ceiling returns to the top on every refill, so a run is a chain of
 * self-contained screens rather than one long slide toward the line. That reset
 * is what makes the long runs survivable at all — the ceiling only ever
 * descends, so without it a tenth screen would be dealt underneath the anchor
 * and fall apart on arrival.
 */

export const RAVEN_BUBBLES_RAVEN_COIN_REWARD = 1;

/** Columns dealt across a screen. Imported by the cabinet. */
export const COLS = 10;

/** Rows dealt into a new screen. Imported by the cabinet. */
export const INITIAL_ROWS = 5;

/** Every bubble dealt into a screen. */
export const BUBBLES_PER_SCREEN = COLS * INITIAL_ROWS;

/** A bubble matched out of the cluster. */
export const POINTS_PER_POP = 10;

/** A bubble orphaned and dropped. Double, so collapsing the board pays. */
export const POINTS_PER_DROP = 20;

export type RavenBubblesMode = "reward" | "practice";
export type RavenBubblesDifficultyName = "easy" | "medium" | "hard" | "expert";

export type RavenBubblesDifficulty = {
  name: RavenBubblesDifficultyName;
  label: string;
  /**
   * Points needed to win. Set outright, not derived: a target built from the
   * pop value alone turned out to be reachable without clearing a screen.
   */
  targetScore: number;
  /** Relative chance of being today's reward-run difficulty. */
  weight: number;
};

const difficulty = (
  name: RavenBubblesDifficultyName,
  label: string,
  targetScore: number,
  weight: number,
): RavenBubblesDifficulty => ({ name, label, targetScore, weight });

export const RAVEN_BUBBLES_DIFFICULTIES: RavenBubblesDifficulty[] = [
  difficulty("easy", "Easy", 1500, 3),
  difficulty("medium", "Medium", 3000, 3),
  difficulty("hard", "Hard", 7500, 2),
  difficulty("expert", "Expert", 15000, 1),
];

export const getRavenBubblesDifficultyFromSeed = (
  seed: number,
): RavenBubblesDifficulty => {
  const totalWeight = RAVEN_BUBBLES_DIFFICULTIES.reduce(
    (sum, difficulty) => sum + difficulty.weight,
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
 * gets the same target on the same day and it cannot be re-rolled by refreshing.
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
