/**
 * The Blackjack action log: every bet and player action in a session.
 *
 * A compact binary format, base64 for transport:
 *
 *   [difficulty:u8] [handCount:u8] ( [betIdx:u8] [actionCount:u8] [action:u8]* )*
 *
 * - difficulty: 0=easy, 1=medium, 2=hard, 3=expert (validated by worker)
 * - handCount: number of hands played (1–8)
 * - betIdx: index in [5,10,25,50,100] (0–4)
 * - actionCount: number of player actions in this hand (1–30)
 * - action: 0=HIT, 1=STAND, 2=DOUBLE
 */

export const BLACKJACK_DIFFICULTY_NAMES: readonly ["easy", "medium", "hard", "expert"];
export const BLACKJACK_BET_AMOUNTS: readonly [5, 10, 25, 50, 100];
export const BLACKJACK_ACTION: { readonly HIT: 0; readonly STAND: 1; readonly DOUBLE: 2 };
export const MAX_BLACKJACK_ACTIONS: 200;
export const MAX_BLACKJACK_HANDS: 8;

export interface BlackjackHandLog {
  betIdx: number;
  actions: number[];
}

export interface BlackjackDecodedLog {
  difficultyIdx: number;
  hands: BlackjackHandLog[];
}

export function encodeBlackjackActionLog(
  difficultyIdx: number,
  hands: BlackjackHandLog[]
): Uint8Array;

export function decodeBlackjackActionLog(bytes: Uint8Array): BlackjackDecodedLog;

export function encodeBlackjackLog(bytes: Uint8Array): string;

export function decodeBlackjackLog(base64: string): Uint8Array;