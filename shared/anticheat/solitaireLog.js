/**
 * The Solitaire action log: what a player *did*, as opposed to what happened.
 *
 * ## Why actions instead of ticks
 *
 * Sunflower Brawler's replay log is one byte per simulated tick — 21,600 of
 * them for a full run — because a real-time game's state is a function of
 * *when* inputs arrived. Solitaire is turn-based: nothing in the game moves
 * except in response to a player action, so the entire causal history of a run
 * is the ordered list of actions taken. Logging ticks here would mean logging
 * thousands of "nothing happened this frame" entries to recover the same
 * information this file carries in two bytes per move.
 *
 * That difference is also why this cabinet needs no chunk streaming. The
 * brawler's log was large enough (≈21 KB base64) and its replay expensive
 * enough (a physics simulation) that the 10 ms Workers-Free budget forced
 * parking and continuation. A complete Solitaire game is a few hundred
 * actions, and replaying one is a few hundred O(pile) state transitions —
 * the whole verification fits in a single request with room to spare.
 *
 * ## Semantic moves, not clicks
 *
 * The log records *resolved* moves ("this card, from here, to there"), not
 * the taps that produced them (select card, then select target). Selection is
 * UI state: it is fully determined by the sources of the moves that followed
 * it, and replaying it would double the log's length to reproduce information
 * the verifier never needs. A failed tap logs nothing — the client only appends
 * an action when the engine returned a new state, so the log contains exactly
 * the moves that changed the game, and the verifier's own "did this change
 * anything?" check becomes a tamper signal rather than a routine no-op.
 *
 * ## Two bytes per action, fixed
 *
 * | byte 0                | byte 1                          |
 * |-----------------------|---------------------------------|
 * | opcode (4) + source (4)| arguments, per opcode           |
 *
 * `source` is `0` for the waste, `pileIndex + 1` for a tableau pile (so
 * `1…7`), which fits the nibble exactly. Opcode and argument widths are
 * validated on decode: a byte that names an unknown opcode or an
 * out-of-range pile is a malformed log, and a malformed log is refused
 * *before* a single move is replayed — never scored as a mismatch, which
 * would poison the verdict table with protocol noise.
 *
 * ## Undo is an action like any other
 *
 * `UNDO` pops the verifier's history stack, which the verifier pushes onto
 * under the same rule as the client: one entry per action that changed the
 * state. The client's `MAX_UNDOS_PER_GAME` limit is enforced by the worker
 * against the count of `UNDO` actions in the log — undoing is a legitimate
 * part of play, but the allowance is a rule of the game, and a verifier that
 * let a log undo fifty times would be verifying a different game than the one
 * the cabinet deals.
 *
 * Plain ES module with no imports, like the rest of this package — the Vite
 * client, the Cloudflare Worker and `scripts/solitaireReplayTest.mjs` all load
 * the same file.
 */

/** Opcodes. Named so no caller has to remember which number is which. */
export const SOLITAIRE_OPS = {
  DRAW: 0,
  MOVE_TO_TABLEAU: 1,
  MOVE_TO_FOUNDATION: 2,
  AUTO_FOUNDATION: 3,
  SMART: 4,
  UNDO: 5,
};

/**
 * Hard ceiling on log length, in actions.
 *
 * A real win is a few hundred actions — the stock holds 24 cards (8 draws at
 * draw-3 per pass), redeals are capped by the difficulty, and every other
 * action is a move. 4096 is an order of magnitude of headroom over any
 * plausible honest game while bounding what a hostile client can make the
 * worker chew in one request: each action is O(7 piles), so the worst case
 * here is still sub-millisecond.
 */
export const MAX_SOLITAIRE_ACTIONS = 4096;

/** Tableau piles: 0…6, packed in the log as `pileIndex + 1` (1…7). */
const TABLEAU_PILES = 7;
/** Suits, in the order the engine's `SUITS` array lays them out. */
const SUIT_COUNT = 4;
/** Face-up card index within a pile: 0…12 (a pile holds at most 13 up). */
const MAX_CARD_INDEX = 12;

const SRC_WASTE = 0;

const packSource = (source) => {
  if (source.source === "waste") return SRC_WASTE;
  const pileIndex = source.pileIndex;
  if (!Number.isInteger(pileIndex) || pileIndex < 0 || pileIndex >= TABLEAU_PILES) {
    throw new Error(`source pileIndex out of range: ${pileIndex}`);
  }
  return pileIndex + 1;
};

/**
 * The card index a move names — always read off the *source*, never as a
 * sibling field: decode fills it into the tableau source, so an encoder that
 * read a top-level `cardIndex` would silently log every run-move as its pile's
 * top card and the verifier would refuse honest play. The waste holds one
 * playable card, so its index is always 0.
 */
const packCardIndex = (action) => {
  const source = action.source;
  if (source && source.source === "tableau") return source.cardIndex ?? 0;
  return 0;
};

const unpackSource = (lowNibble) =>
  lowNibble === SRC_WASTE
    ? { source: "waste" }
    : { source: "tableau", pileIndex: lowNibble - 1, cardIndex: 0 };

/**
 * Encode one action into its two bytes.
 *
 * `cardIndex` is carried on the tableau *source* (a waste card is always its
 * pile's top) so the verifier knows exactly which card of a face-up run was
 * picked — clicking the third card of a run moves the run *from* that card,
 * and a verifier that assumed the top card would refuse honest play.
 *
 * @param {object} action  See `SOLITAIRE_OPS` for the shape per opcode.
 * @returns {number[]} Two bytes, `[low, high]`.
 */
export function encodeAction(action) {
  const op = action.op;
  if (
    !Number.isInteger(op) ||
    op < SOLITAIRE_OPS.DRAW ||
    op > SOLITAIRE_OPS.UNDO
  ) {
    throw new Error(`Unknown solitaire action op: ${op}`);
  }

  const src = packSource(action.source ?? { source: "waste" });
  const byte0 = (op << 4) | src;

  switch (op) {
    case SOLITAIRE_OPS.MOVE_TO_TABLEAU: {
      const cardIndex = packCardIndex(action);
      const target = action.target;
      if (cardIndex < 0 || cardIndex > MAX_CARD_INDEX) {
        throw new Error(`cardIndex out of range: ${cardIndex}`);
      }
      if (!Number.isInteger(target) || target < 0 || target >= TABLEAU_PILES) {
        throw new Error(`target pile out of range: ${target}`);
      }
      return [byte0, (cardIndex << 3) | target];
    }
    case SOLITAIRE_OPS.MOVE_TO_FOUNDATION: {
      const cardIndex = packCardIndex(action);
      const suit = action.suit;
      if (cardIndex < 0 || cardIndex > MAX_CARD_INDEX) {
        throw new Error(`cardIndex out of range: ${cardIndex}`);
      }
      if (!Number.isInteger(suit) || suit < 0 || suit >= SUIT_COUNT) {
        throw new Error(`suit index out of range: ${suit}`);
      }
      return [byte0, (cardIndex << 2) | suit];
    }
    case SOLITAIRE_OPS.SMART: {
      const cardIndex = packCardIndex(action);
      if (cardIndex < 0 || cardIndex > MAX_CARD_INDEX) {
        throw new Error(`cardIndex out of range: ${cardIndex}`);
      }
      return [byte0, cardIndex];
    }
    case SOLITAIRE_OPS.DRAW:
    case SOLITAIRE_OPS.AUTO_FOUNDATION:
    case SOLITAIRE_OPS.UNDO:
      return [byte0, 0];
    default:
      throw new Error(`Unhandled solitaire action op: ${op}`);
  }
}

/**
 * Encode a whole game's actions.
 *
 * @param {object[]} actions
 * @returns {Uint8Array} Two bytes per action.
 */
export function encodeActionLog(actions) {
  const bytes = new Uint8Array(actions.length * 2);
  for (let i = 0; i < actions.length; i++) {
    const [low, high] = encodeAction(actions[i]);
    bytes[i * 2] = low;
    bytes[i * 2 + 1] = high;
  }
  return bytes;
}

/**
 * Decode a log back into actions.
 *
 * Throws on anything malformed — unknown opcode, pile or suit outside its
 * range, card index beyond a pile's capacity — and on a log longer than
 * `MAX_SOLITAIRE_ACTIONS` or not a whole number of two-byte actions. A
 * truncated or garbled log must be *refused*, never partially replayed: a
 * replay over half a move list is not a weaker check, it is a wrong one.
 *
 * `cardIndex` is filled into the returned tableau sources so callers can
 * apply the action directly.
 *
 * @param {Uint8Array} bytes
 * @returns {object[]} Actions, each `{ op, source, … }` per opcode.
 */
export function decodeActionLog(bytes) {
  if (bytes.length % 2 !== 0) {
    throw new Error("Solitaire action log length is not a multiple of 2.");
  }
  const count = bytes.length / 2;
  if (count > MAX_SOLITAIRE_ACTIONS) {
    throw new Error(`Solitaire action log exceeds ${MAX_SOLITAIRE_ACTIONS} actions.`);
  }

  const actions = [];
  for (let i = 0; i < count; i++) {
    const byte0 = bytes[i * 2];
    const byte1 = bytes[i * 2 + 1];
    const op = byte0 >> 4;
    const srcNibble = byte0 & 0x0f;

    if (op > SOLITAIRE_OPS.UNDO) {
      throw new Error(`Action ${i}: unknown opcode ${op}.`);
    }
    if (srcNibble > TABLEAU_PILES) {
      throw new Error(`Action ${i}: source nibble ${srcNibble} out of range.`);
    }

    const cardIndex = byte1 >> (op === SOLITAIRE_OPS.MOVE_TO_TABLEAU ? 3 : op === SOLITAIRE_OPS.MOVE_TO_FOUNDATION ? 2 : 0);
    if (cardIndex > MAX_CARD_INDEX) {
      throw new Error(`Action ${i}: cardIndex ${cardIndex} out of range.`);
    }
    const source = unpackSource(srcNibble);
    if (source.source === "tableau") {
      source.cardIndex = cardIndex;
    }

    switch (op) {
      case SOLITAIRE_OPS.MOVE_TO_TABLEAU: {
        const target = byte1 & 0x07;
        if (target >= TABLEAU_PILES) {
          throw new Error(`Action ${i}: target pile ${target} out of range.`);
        }
        actions.push({ op, source, target });
        break;
      }
      case SOLITAIRE_OPS.MOVE_TO_FOUNDATION: {
        const suit = byte1 & 0x03;
        if (suit >= SUIT_COUNT) {
          throw new Error(`Action ${i}: suit ${suit} out of range.`);
        }
        actions.push({ op, source, suit });
        break;
      }
      case SOLITAIRE_OPS.SMART:
        actions.push({ op, source });
        break;
      case SOLITAIRE_OPS.DRAW:
      case SOLITAIRE_OPS.AUTO_FOUNDATION:
      case SOLITAIRE_OPS.UNDO:
        actions.push({ op });
        break;
      default:
        throw new Error(`Action ${i}: unhandled opcode ${op}.`);
    }
  }
  return actions;
}

/**
 * Base64-encode an action log for transport in the claim.
 *
 * Same chunked construction as `encodeInputLog` in `./inputLog.js` — see the
 * note there for why the spread is avoided. `btoa` exists in the browser, in
 * Cloudflare Workers and in Node ≥16, so one function serves all three hosts.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encodeSolitaireLog(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Reverse `encodeSolitaireLog`. Throws on malformed input rather than
 * returning a short log.
 *
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function decodeSolitaireLog(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
