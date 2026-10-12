/**
 * The Poker action log: every bet and street choice in a session.
 *
 * A compact binary format, base64 for transport:
 *
 *   [difficulty:u8] [handCount:u8] ( [betIdx:u8] [actionCount:u8] [action:u8]* )*
 *
 * - difficulty: 0=easy, 1=medium, 2=hard, 3=expert (validated by worker)
 * - handCount: number of hands played (1–5)
 * - betIdx: index in [1,5,10,25,50,100] (0–5)
 * - actionCount: player street choices in this hand (1–2)
 * - action: 0=FOLD, 1=CHECK, 2=BET
 *
 * See `pokerLog.js` for the full argument (why the house's play is replayed
 * rather than logged, and why the structure is rigid).
 */

export const POKER_DIFFICULTY_NAMES: readonly ["easy", "medium", "hard", "expert"];
export const POKER_BET_AMOUNTS: readonly [1, 5, 10, 25, 50, 100];
export const POKER_ACTION: { readonly FOLD: 0; readonly CHECK: 1; readonly BET: 2 };
export const MAX_POKER_ACTIONS: 10;
export const MAX_POKER_HANDS: 5;

export interface PokerHandLog {
  betIdx: number;
  actions: number[];
}

export interface PokerDecodedLog {
  difficultyIdx: number;
  hands: PokerHandLog[];
}

export function encodePokerActionLog(
  difficultyIdx: number,
  hands: PokerHandLog[]
): Uint8Array;

export function decodePokerActionLog(bytes: Uint8Array): PokerDecodedLog;

export function encodePokerLog(bytes: Uint8Array): string;

export function decodePokerLog(base64: string): Uint8Array;
