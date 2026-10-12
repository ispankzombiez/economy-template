/**
 * The Poker action log: every bet and every street choice in a session.
 *
 * ## Why this shape
 *
 * Poker is a session of Texas Hold'em hands against the house: the player picks
 * a bet, the house matches it, and the player then chooses fold/check/bet on
 * the flop and (if the hand survives) again after the turn and river. The
 * *entire* session outcome is determined by:
 *
 *   1. The seed (shuffles each hand's deck from one generator stream).
 *   2. The daily difficulty (targetChips) — derived from the UTC date, not the
 *      seed. The worker re-derives it and refuses claims naming a difficulty
 *      that is neither today's nor yesterday's.
 *   3. The bet chosen for each hand, and the player's street choices within it.
 *
 * The house's responses are pure function of the deal — `HouseAI.decideBetAction`
 * reads only the house's cards and the board — so they are replayed, not
 * recorded. That is the Blackjack log's bargain exactly (see `blackjackLog.js`),
 * and Poker's session proof is the same document: a bet/action list.
 *
 * ## Encoding
 *
 * A compact binary format, base64 for transport:
 *
 *   [difficulty:u8] [handCount:u8] ( [betIdx:u8] [actionCount:u8] [action:u8]* )*
 *
 * - difficulty: 0=easy, 1=medium, 2=hard, 3=expert (validated by worker)
 * - handCount: number of hands played (1–5)
 * - betIdx: index into POKER_BET_AMOUNTS (0–5)
 * - actionCount: player street choices in this hand (1–2)
 * - action: 0=FOLD, 1=CHECK, 2=BET
 *
 * The structure is rigid on purpose. A hand always has at least its preflop
 * choice, and at most preflop + postflop, because the turn and river trigger no
 * further betting — the hand goes straight to showdown. So `actionCount` of 0
 * or 3+ cannot be produced by the client and is protocol noise rather than a
 * game that failed to match: it is refused at decode, recorded as
 * `matched: null`, kept apart from genuine mismatches so verdict noise cannot
 * drown the signal.
 *
 * Within that structure the *content* is the game: a hand whose first choice is
 * FOLD has no postflop choice (the hand is over), and a hand with a single
 * non-fold choice reached the turn — neither of which a decoder needs to know,
 * because the replay itself detects both. A FOLD followed by more choices is a
 * dead action; a single CHECK that leaves the hand unfinished is a log that ran
 * out mid-hand. The engine reports both, so the codec does not have to
 * second-guess the rules it does not run.
 *
 * ## Ceiling
 *
 * 5 hands × 2 choices = 10 actions max, 22 bytes max. A session this small
 * replays in microseconds, which is why the whole log travels inside the
 * claim's own request (see `pokerReplay.js` for why there are no chunks).
 */

export const POKER_DIFFICULTY_NAMES = ["easy", "medium", "hard", "expert"];
export const POKER_BET_AMOUNTS = [1, 5, 10, 25, 50, 100];
export const POKER_ACTION = { FOLD: 0, CHECK: 1, BET: 2 };

export const MAX_POKER_ACTIONS = 10;
export const MAX_POKER_HANDS = 5;

export function encodePokerActionLog(difficultyIdx, hands) {
  // hands: { betIdx: number, actions: number[] }[]
  const totalActions = hands.reduce((sum, h) => sum + h.actions.length, 0);
  if (totalActions > MAX_POKER_ACTIONS) {
    throw new Error(`Action count ${totalActions} exceeds ceiling ${MAX_POKER_ACTIONS}`);
  }
  if (hands.length > MAX_POKER_HANDS) {
    throw new Error(`Hand count ${hands.length} exceeds ceiling ${MAX_POKER_HANDS}`);
  }

  // 1 (difficulty) + 1 (handCount) + per hand: betIdx, actionCount, actions.
  let byteLength = 2;
  for (const hand of hands) {
    byteLength += 2 + hand.actions.length;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  bytes[offset++] = difficultyIdx;
  bytes[offset++] = hands.length;

  for (let h = 0; h < hands.length; h++) {
    const hand = hands[h];
    if (!Number.isInteger(hand.betIdx) || hand.betIdx < 0 || hand.betIdx > 5) {
      throw new Error(`Invalid bet index: ${hand.betIdx}`);
    }
    if (!hand.actions) {
      throw new Error(`Hand ${h} missing action sequence`);
    }
    // 1 = preflop only (hand ended there), 2 = preflop + postflop. A hand
    // cannot have more street choices, and cannot have none — the player
    // always faces the preflop decision.
    if (hand.actions.length < 1 || hand.actions.length > 2) {
      throw new Error(
        `Hand ${h} has ${hand.actions.length} choices, expected 1 or 2`,
      );
    }
    bytes[offset++] = hand.betIdx;
    bytes[offset++] = hand.actions.length;
    for (const action of hand.actions) {
      if (!Number.isInteger(action) || action < 0 || action > 2) {
        throw new Error(`Invalid action byte: ${action}`);
      }
      bytes[offset++] = action;
    }
  }
  return bytes;
}

export function decodePokerActionLog(bytes) {
  if (bytes.length < 2) {
    throw new Error("Log too short: missing difficulty and hand count");
  }
  if (bytes.length > 2 + MAX_POKER_HANDS * (2 + 2)) {
    // Rough ceiling check before full parse: max 5 hands × (bet + count + 2).
    throw new Error("Log exceeds maximum plausible size");
  }

  const difficultyIdx = bytes[0];
  if (difficultyIdx > 3) {
    throw new Error(`Invalid difficulty index: ${difficultyIdx}`);
  }

  const handCount = bytes[1];
  if (handCount === 0 || handCount > MAX_POKER_HANDS) {
    throw new Error(`Invalid hand count: ${handCount}`);
  }

  let offset = 2;
  const hands = [];

  for (let h = 0; h < handCount; h++) {
    if (offset + 2 > bytes.length) {
      throw new Error(`Truncated log at hand ${h}`);
    }
    const betIdx = bytes[offset++];
    if (betIdx > 5) {
      throw new Error(`Invalid bet index ${betIdx} at hand ${h}`);
    }
    const actionCount = bytes[offset++];
    if (actionCount < 1 || actionCount > 2) {
      throw new Error(
        `Invalid action count ${actionCount} at hand ${h}: a hand carries 1 or 2 choices`,
      );
    }
    if (offset + actionCount > bytes.length) {
      throw new Error(
        `Truncated log: hand ${h} claims ${actionCount} choices but only ${bytes.length - offset} bytes remain`,
      );
    }
    const actions = [];
    for (let a = 0; a < actionCount; a++) {
      const action = bytes[offset++];
      if (action > 2) {
        throw new Error(`Invalid action ${action} at hand ${h}, action ${a}`);
      }
      actions.push(action);
    }
    hands.push({ betIdx, actions });
  }

  if (offset !== bytes.length) {
    throw new Error(`Trailing ${bytes.length - offset} bytes after parsing all hands`);
  }

  const totalActions = hands.reduce((sum, h) => sum + h.actions.length, 0);
  if (totalActions > MAX_POKER_ACTIONS) {
    throw new Error(`Total actions ${totalActions} exceeds ceiling ${MAX_POKER_ACTIONS}`);
  }

  return { difficultyIdx, hands };
}

export function encodePokerLog(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function decodePokerLog(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
