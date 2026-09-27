/**
 * Poker Game Types - Texas Hold'em vs House
 */

// Card Suits - Custom for Sunflower Land
export type CardSuit = "Kale" | "Barley" | "Wheat" | "Radish";

// Card Ranks
export type CardRank =
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "J"
  | "Q"
  | "K"
  | "A";

// Card representation
export interface Card {
  suit: CardSuit;
  rank: CardRank;
}

// Hand Rankings (Texas Hold'em)
export enum HandRanking {
  HighCard = 0,
  OnePair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
  RoyalFlush = 9,
}

// Evaluated hand
export interface EvaluatedHand {
  ranking: HandRanking;
  rankingName: string;
  cards: Card[];
  kickers: Card[];
}

// Game bet amounts
export const BET_AMOUNTS = [1, 5, 10, 25, 50, 100] as const;
export type BetAmount = (typeof BET_AMOUNTS)[number];

// Game state
export interface PokerGameState {
  status:
    | "idle"
    | "betting"
    | "preflop_betting"
    | "postflop_betting"
    | "postriver_betting"
    | "showdown"
    | "gameover";

  // Players
  playerHand: Card[];
  playerChips: number;
  houseHand: Card[];

  // Community cards
  communityCards: Card[];

  // Betting
  initialBetAmount: number;
  currentBet: number;
  potAmount: number;

  // Cumulative bets across all streets
  totalPlayerBetAcrossGame: number;
  totalHouseBetAcrossGame: number;

  // Bets this round (street)
  playerBetAmount: number;
  houseBetAmount: number;

  // Evaluated hands at end of game
  playerEvalHand: EvaluatedHand | null;
  houseEvalHand: EvaluatedHand | null;
  lastWinner: "player" | "house" | "tie" | null;
  lastWinAmount: number;

  // Game history
  gameNumber: number;
  totalWinnings: number;
  totalLosses: number;
}

// Possible actions
export type PokerAction =
  | { type: "PLACE_BET"; amount: BetAmount }
  | { type: "FOLD" }
  | { type: "CHECK" }
  | { type: "CALL" }
  | { type: "RAISE"; amount: number }
  | { type: "ALL_IN" }
  | { type: "START_GAME" }
  | { type: "PLAY_AGAIN" }
  | { type: "EXIT_GAME" };

// Betting street - 3 betting rounds in simplified game
export type BettingStreet = "preflop" | "postflop" | "postriver";

// Game result
export interface GameResult {
  winner: "player" | "house" | "tie";
  playerHand: EvaluatedHand;
  houseHand: EvaluatedHand;
  winAmount: number;
}
