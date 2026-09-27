/**
 * Uno Types
 *
 * Classic Uno uses its own card set distinct from a poker deck.
 * Colours are mapped to the four Sunflower Land crop suits so we can
 * reuse the existing suitImages display helpers.
 */

// The four Uno colours + Wild (which has no colour)
export type UnoColor = "Kale" | "Barley" | "Wheat" | "Radish" | "Wild";

// Number cards: 0-9; Action cards: Skip, Reverse, DrawTwo; Wild cards: Wild, WildDrawFour
export type UnoFace =
  | "0"
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "Skip"
  | "Reverse"
  | "DrawTwo"
  | "Wild"
  | "WildDrawFour";

export interface UnoCard {
  color: UnoColor;
  face: UnoFace;
  /** Unique id so React keys stay stable across shuffles */
  id: string;
}

export type UnoWinner = "player" | "bot1" | "bot2" | "bot3";

export interface UnoGameState {
  deck: UnoCard[];
  discard: UnoCard[];
  hands: [UnoCard[], UnoCard[], UnoCard[], UnoCard[]]; // [player, bot1, bot2, bot3]
  currentPlayer: number; // 0 = human, 1-3 = bots
  direction: 1 | -1; // 1 = clockwise, -1 = counter-clockwise
  currentColor: UnoColor; // active colour (may differ from top of discard when wild)
  winner: UnoWinner | null;
  gameOver: boolean;
  log: string[];
  pendingDrawCount: number; // stacked DrawTwo / WildDrawFour penalty
}
