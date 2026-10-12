/**
 * The Uno action log: every choice the *player* made, in order.
 *
 * ## Why actions instead of ticks
 *
 * Uno is turn-based — nothing moves except when someone plays or draws — so
 * the whole causal history of a game is the ordered list of the player's
 * choices. That is the Solitaire/Go Fish pattern (see `solitaireLog.js` and
 * `goFishLog.js` for the full argument): a turn-based game's proof is its move
 * list, not a tick trace, and a complete game replays in microseconds. No
 * chunking, no parking, no continuation — the entire log is validated and
 * replayed inside the one request the claim arrives in.
 *
 * ## What is *not* logged: the three bots
 *
 * A four-player game might look like it needs four logs. It does not. Bots
 * 1–3 have no choices of their own to record: their play is a pure function of
 * the state (`botChooseCard` in the engine's `engine.ts` reads only the hand,
 * the discard top and the active colour), and the only randomness they touch —
 * the colour they pick when dropping a Wild — draws from the same seeded
 * generator stream the deck was shuffled from. So the worker rebuilds the deal
 * from the seed, re-applies the player's choices, and *re-simulates* the bots
 * in between, exactly as the client did. Recording bot moves would only be
 * re-recording what the rules already determine, and a recorded bot move the
 * rules disagree with would be a hole rather than a proof.
 *
 * ## The byte encoding
 *
 * One action per entry, variable width:
 *
 *   `0x00`                     — draw a card (voluntarily, or to take a
 *                                pending +2/+4 penalty; the engine decides
 *                                which from the state it replays into).
 *   `0x01 + index`             — play the card at `index` in the player's
 *                                hand. `index` is a position in the engine's
 *                                hand order, never the sorted display order
 *                                and never a card id: the hand is what the
 *                                state holds, and it is the only thing both
 *                                sides can agree on without shipping ids.
 *   `0x80 | index`, then a
 *   colour byte `0x03`         — play the Wild at `index`, naming the colour
 *                                it turns the game to.
 *
 * A hand can never exceed the deck's 108 cards, so `index` is always below
 * 128 and the split at 0x80 is safe with room to spare. The wild form is used
 * *exactly* when a colour is present: the engine refuses a Wild played without
 * one and a colour named on a non-Wild, so there is one byte sequence per
 * game and no canonical-form ambiguity for a forger to sit in.
 *
 * ## Ceilings
 *
 * `MAX_UNO_ACTIONS = 600` player actions. A real game lands between a dozen
 * and a few dozen; 600 is an order of magnitude of headroom. It bounds what a
 * hostile client can make the worker chew in one request: every player action
 * is followed by at most three bot turns (four seats, one of them the
 * player's), each O(hand), so the worst case is still a few tens of
 * thousands of elementary operations — well inside the 10 ms Workers Free
 * budget.
 *
 * Base64 for transport, exactly like the other logs — one implementation
 * serves browser, Worker and the Node test harness.
 */

/** Colours as byte values. Matches the engine's `NON_WILD_COLORS` order. */
export const UNO_COLOR_COUNT = 4;

/**
 * Hard ceiling on log length, in player actions.
 *
 * See the note above: it caps the worker's work per request, and a log past
 * it could not be encoded, hence not verified, hence not paid.
 */
export const MAX_UNO_ACTIONS = 600;

/** The largest hand index that fits the encoding (a hand holds ≤108 cards). */
export const MAX_UNO_HAND_INDEX = 126;

/**
 * Encode a game's player actions into bytes.
 *
 * @param {{ kind: "draw" } | { kind: "play", index: number, color?: number }}[] actions
 * @returns {Uint8Array}
 * @throws {Error} on an index over the encoding's reach, a colour outside
 *   0–3, or a play missing the fields its form requires.
 */
export function encodeUnoActionLog(actions) {
  if (actions.length > MAX_UNO_ACTIONS) {
    throw new Error(
      `Action count ${actions.length} exceeds ceiling ${MAX_UNO_ACTIONS}`,
    );
  }

  // Worst case is three bytes per action (wild play + colour).
  const bytes = new Uint8Array(actions.length * 3);
  let offset = 0;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];

    if (action.kind === "draw") {
      bytes[offset++] = 0x00;
      continue;
    }

    if (action.kind !== "play") {
      throw new Error(`Action ${i}: unknown kind ${String(action.kind)}`);
    }

    const { index, color } = action;
    if (!Number.isInteger(index) || index < 0 || index > MAX_UNO_HAND_INDEX) {
      throw new Error(`Action ${i}: hand index out of range: ${index}`);
    }

    if (color === undefined) {
      bytes[offset++] = 0x01 + index;
      continue;
    }

    if (!Number.isInteger(color) || color < 0 || color >= UNO_COLOR_COUNT) {
      throw new Error(`Action ${i}: colour out of range: ${color}`);
    }

    bytes[offset++] = 0x80 | index;
    bytes[offset++] = color;
  }

  return bytes.subarray(0, offset);
}

/**
 * Decode a log back into player actions.
 *
 * Throws on anything malformed — a wild play with its colour byte missing, a
 * colour over 3, a log past the ceiling — and on anything the client's encoder
 * could not have written. A malformed log is refused *before* replay: it is
 * protocol garbage, not a game that failed to match, and scoring it as a
 * mismatch would poison the verdict table with noise.
 *
 * @param {Uint8Array} bytes
 * @returns {{ kind: "draw" } | { kind: "play", index: number, color?: number }}[]
 */
export function decodeUnoActionLog(bytes) {
  if (bytes.length > MAX_UNO_ACTIONS * 3) {
    throw new Error(
      `Uno action log is ${bytes.length} bytes, over the ceiling for ${MAX_UNO_ACTIONS} actions.`,
    );
  }

  const actions = [];
  let i = 0;

  while (i < bytes.length) {
    const byte = bytes[i++];

    if (byte === 0x00) {
      actions.push({ kind: "draw" });
      continue;
    }

    if (byte < 0x80) {
      actions.push({ kind: "play", index: byte - 0x01 });
      continue;
    }

    // Wild play: the colour byte is mandatory, and it must be the last byte
    // of this action.
    const color = bytes[i++];
    if (color === undefined || color >= UNO_COLOR_COUNT) {
      throw new Error(
        `Action ${actions.length}: wild play is missing a valid colour byte.`,
      );
    }
    actions.push({ kind: "play", index: byte & 0x7f, color });
  }

  if (actions.length > MAX_UNO_ACTIONS) {
    throw new Error(
      `Action count ${actions.length} exceeds ceiling ${MAX_UNO_ACTIONS}`,
    );
  }

  return actions;
}

/**
 * Base64-encode an action log for transport in the claim.
 *
 * Same chunked construction as the other codecs — see `encodeGoFishLog` for
 * why the spread is avoided.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encodeUnoLog(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Reverse `encodeUnoLog`. Throws on malformed input rather than returning a
 * short log.
 *
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function decodeUnoLog(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
