/**
 * Blackjack session helpers — scoring, difficulty, reward availability.
 */
import { GameState } from "../adapters/gameTypes";
import { Card, CardRank } from "../poker/types";
import { HandValue } from "./types";
import {
  getTodayKey,
  isRewardRunAvailableForMinigame,
} from "../poker/session";

// ─── Constants ───────────────────────────────────────────────────────────────

export const BLACKJACK_STARTING_CHIPS = 100;
export const BLACKJACK_RAVEN_COIN_REWARD = 1;

export type BlackjackMode = "reward" | "practice";

export type BlackjackDifficultyName = "easy" | "medium" | "hard" | "expert";

export type BlackjackDifficulty = {
  name: BlackjackDifficultyName;
  label: string;
  /** Chip target the player must reach to win the session */
  targetChips: number;
  /** Max hands allowed in a session */
  maxHands: number;
  weight: number;
};

export const BLACKJACK_DIFFICULTIES: BlackjackDifficulty[] = [
  { name: "easy", label: "Easy", targetChips: 200, maxHands: 8, weight: 2 },
  {
    name: "medium",
    label: "Medium",
    targetChips: 400,
    maxHands: 8,
    weight: 3,
  },
  { name: "hard", label: "Hard", targetChips: 600, maxHands: 8, weight: 3 },
  {
    name: "expert",
    label: "Expert",
    targetChips: 800,
    maxHands: 8,
    weight: 2,
  },
];

// ─── Daily difficulty ─────────────────────────────────────────────────────────

export const getBlackjackDifficultyFromSeed = (
  seed: number,
): BlackjackDifficulty => {
  const totalWeight = BLACKJACK_DIFFICULTIES.reduce(
    (total, d) => total + d.weight,
    0,
  );
  const normalizedSeed =
    ((Math.trunc(seed) % totalWeight) + totalWeight) % totalWeight;

  let threshold = 0;

  for (const difficulty of BLACKJACK_DIFFICULTIES) {
    threshold += difficulty.weight;
    if (normalizedSeed < threshold) return difficulty;
  }

  return BLACKJACK_DIFFICULTIES[BLACKJACK_DIFFICULTIES.length - 1];
};

export const getBlackjackDifficulty = (
  now: Date | number = Date.now(),
): BlackjackDifficulty => {
  const todayKey = getTodayKey(now);
  const seed = todayKey.split("").reduce((acc, ch) => {
    return Math.imul(acc, 31) + ch.charCodeAt(0);
  }, 13); // different seed base to poker (7) so difficulty is independent

  return getBlackjackDifficultyFromSeed(seed >>> 0);
};

// ─── Reward availability ──────────────────────────────────────────────────────

export const isBlackjackRewardRunAvailable = ({
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
    minigame: "blackjack",
    isVip,
    now,
  });
};

// ─── Hand scoring ─────────────────────────────────────────────────────────────

const RANK_VALUES: Record<CardRank, number> = {
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 10,
  Q: 10,
  K: 10,
  A: 11, // treated as 11; we reduce to 1 when busting
};

export const calculateHandValue = (hand: Card[]): HandValue => {
  let total = 0;
  let aces = 0;

  for (const card of hand) {
    const value = RANK_VALUES[card.rank];
    total += value;
    if (card.rank === "A") aces++;
  }

  // Reduce aces from 11→1 as needed to avoid bust
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  const isBlackjack = hand.length === 2 && total === 21;

  return {
    hard: hand.reduce(
      (sum, c) => sum + (c.rank === "A" ? 1 : RANK_VALUES[c.rank]),
      0,
    ),
    soft: total,
    isBust: total > 21,
    isBlackjack,
  };
};

// Re-export getTodayKey for convenience
export { getTodayKey };
