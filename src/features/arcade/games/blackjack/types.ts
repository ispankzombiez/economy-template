/**
 * Blackjack Game Types
 * Classic Blackjack (21) vs Dealer
 */

// Reuse card types from poker
export type { CardSuit, CardRank, Card } from "../poker/types";

// Blackjack hand value result
export interface HandValue {
  hard: number; // total treating all aces as 1
  soft: number; // best total without busting (ace = 11 if safe)
  isBust: boolean;
  isBlackjack: boolean; // natural 21 with exactly 2 cards
}

// Game phases
export type BlackjackStatus =
  | "idle" // entry screen
  | "dealing" // initial cards being dealt
  | "player_turn" // player's actions (hit/stand/double)
  | "dealer_turn" // dealer plays automatically
  | "gameover"; // hand resolved

// Result of a resolved hand
export type BlackjackResult = "player" | "dealer" | "push" | "blackjack";

// Bet amounts available
export const BLACKJACK_BET_AMOUNTS = [5, 10, 25, 50, 100] as const;
export type BlackjackBetAmount = (typeof BLACKJACK_BET_AMOUNTS)[number];

// Full game state
export interface BlackjackGameState {
  status: BlackjackStatus;
  playerHand: import("../poker/types").Card[];
  dealerHand: import("../poker/types").Card[];
  /** Current wager for this hand */
  currentBet: BlackjackBetAmount | number;
  /** Player's chip stack */
  playerChips: number;
  /** Result of the most recent resolved hand */
  lastResult: BlackjackResult | null;
  /** Net chips won/lost on the last hand (positive = win) */
  lastNetChips: number;
  /** Running totals across the session */
  handsPlayed: number;
  totalWinnings: number;
  totalLosses: number;
}
