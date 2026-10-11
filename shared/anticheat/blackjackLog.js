/**
 * The Blackjack action log: every bet and player action in a session.
 *
 * ## Why this shape
 *
 * Blackjack is a session of hands: the player picks a bet, plays a hand
 * (HIT/STAND/DOUBLE), the dealer resolves deterministically, and the session
 * continues until the chip target is reached or hands/chips run out. The
 * *entire* session outcome is determined by:
 *
 *   1. The seed (shuffles each hand's deck from one generator stream).
 *   2. The daily difficulty (targetChips, maxHands) — derived from the UTC
 *      date, not the seed. The worker re-derives it and refuses claims
 *      naming a difficulty that is neither today's nor yesterday's.
 *   3. The bet chosen for each hand, and the player's actions within it.
 *
 * The dealer's play is pure function of the remaining deck (hit until 17+),
 * so it needs no log entries — it is replayed, not recorded.
 *
 * ## Encoding
 *
 * A compact binary format, base64 for transport:
 *
 *   [difficulty:u8] [handCount:u8] ( [betIdx:u8] [actionCount:u8] [action:u8]* )*
 *
 * - difficulty: 0=easy, 1=medium, 2=hard, 3=expert (validated by worker)
 * - handCount: number of hands played (1–8)
 * - betIdx: index in [5,10,25,50,100] (0–4)
 * - actionCount: number of player actions in this hand (1–30, ceiling below)
 * - action: 0=HIT, 1=STAND, 2=DOUBLE
 *
 * A hand's action sequence always ends with STAND or DOUBLE (or implicitly
 * by bust after a HIT — the replay engine detects bust and ends the hand).
 * DOUBLE consumes one card then auto-stands.
 *
 * ## Ceilings
 *
 * MAX_BLACKJACK_ACTIONS = 200 total player actions across a session.
 * Real sessions are ~20–40 actions; 200 bounds the worker's CPU well under
 * the 10 ms Free-plan budget (each action is O(52) deck ops).
 *
 * The log is base64'd exactly like the other codecs — one implementation
 * serves browser, Worker, and Node test harness.
 */

export const BLACKJACK_DIFFICULTY_NAMES = ["easy", "medium", "hard", "expert"];
export const BLACKJACK_BET_AMOUNTS = [5, 10, 25, 50, 100];
export const BLACKJACK_ACTION = { HIT: 0, STAND: 1, DOUBLE: 2 };

export const MAX_BLACKJACK_ACTIONS = 200;
export const MAX_BLACKJACK_HANDS = 8;

export function encodeBlackjackActionLog(difficultyIdx, hands) {
  // hands: { betIdx: number, actions: number[] }[]
  const totalActions = hands.reduce((sum, h) => sum + h.actions.length, 0);
  if (totalActions > MAX_BLACKJACK_ACTIONS) {
    throw new Error(`Action count ${totalActions} exceeds ceiling ${MAX_BLACKJACK_ACTIONS}`);
  }
  if (hands.length > MAX_BLACKJACK_HANDS) {
    throw new Error(`Hand count ${hands.length} exceeds ceiling ${MAX_BLACKJACK_HANDS}`);
  }

  // Calculate byte length: 1 (diff) + 1 (handCount) + sum(1 + 1 + actions.length) per hand
  let byteLength = 2;
  for (const hand of hands) {
    byteLength += 2 + hand.actions.length;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  bytes[offset++] = difficultyIdx;
  bytes[offset++] = hands.length;

  for (const hand of hands) {
    if (!Number.isInteger(hand.betIdx) || hand.betIdx < 0 || hand.betIdx > 4) {
      throw new Error(`Invalid bet index: ${hand.betIdx}`);
    }
    // Allow empty action sequences (e.g., immediate blackjack on deal)
    if (!hand.actions) {
      throw new Error(`Hand ${hands.indexOf(hand)} missing action sequence`);
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

export function decodeBlackjackActionLog(bytes) {
  if (bytes.length < 2) {
    throw new Error("Log too short: missing difficulty and hand count");
  }
  if (bytes.length > 2 + MAX_BLACKJACK_HANDS * (2 + 30)) {
    // Rough ceiling check before full parse
    throw new Error("Log exceeds maximum plausible size");
  }

  const difficultyIdx = bytes[0];
  if (difficultyIdx > 3) {
    throw new Error(`Invalid difficulty index: ${difficultyIdx}`);
  }

  const handCount = bytes[1];
  if (handCount === 0 || handCount > MAX_BLACKJACK_HANDS) {
    throw new Error(`Invalid hand count: ${handCount}`);
  }

  let offset = 2;
  const hands = [];

  for (let h = 0; h < handCount; h++) {
    if (offset + 2 > bytes.length) {
      throw new Error(`Truncated log at hand ${h}`);
    }
    const betIdx = bytes[offset++];
    if (betIdx > 4) {
      throw new Error(`Invalid bet index ${betIdx} at hand ${h}`);
    }
    const actionCount = bytes[offset++];
    if (actionCount > 30) {
      throw new Error(`Invalid action count ${actionCount} at hand ${h}`);
    }
    if (offset + actionCount > bytes.length) {
      throw new Error(`Truncated log: hand ${h} claims ${actionCount} actions but only ${bytes.length - offset} bytes remain`);
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
  if (totalActions > MAX_BLACKJACK_ACTIONS) {
    throw new Error(`Total actions ${totalActions} exceeds ceiling ${MAX_BLACKJACK_ACTIONS}`);
  }

  return { difficultyIdx, hands };
}

export function encodeBlackjackLog(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function decodeBlackjackLog(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}