/**
 * The Go Fish action log: every rank the player asked for, in order.
 *
 * ## Why actions instead of ticks
 *
 * Go Fish is turn-based — nothing in the game moves except when the player
 * asks for a rank — so the whole causal history of a run is the ordered list
 * of asks. That is the Solitaire pattern (see `solitaireLog.js` for the full
 * argument): a turn-based game's proof is its move list, not a tick trace,
 * and a complete game replays in microseconds. No chunking, no parking, no
 * continuation — the entire log is validated and replayed inside the one
 * request the claim arrives in.
 *
 * ## One byte per ask
 *
 * A Go Fish action is exactly one thing: "ask for rank X". Thirteen ranks fit
 * in a single byte with room to spare, so the whole codec is the trivial one —
 * and deliberately stays trivial rather than adopting Solitaire's
 * two-nibble-per-move packing, which exists there because a move names a
 * *source* and a *target*. An ask names nothing else.
 *
 * The rank is stored as its index in the engine's `RANK_ORDER` (2–A as 0–12),
 * never as a character or a name: a byte over 12 is malformed and refused on
 * decode, before any replay. The player can only ask for a rank they hold —
 * the engine enforces that on both sides (see `askForRank` in the game's
 * `engine.ts`), so the log carries what was asked, and the engine decides
 * whether the ask was even legal from the state it replays into.
 *
 * ## Transport
 *
 * Base64, exactly like the other two logs (`encodeInputLog`,
 * `encodeSolitaireLog`): `btoa`/`atob` exist in the browser, in Cloudflare
 * Workers and in Node ≥16, so one implementation serves every host the log
 * travels between. Bytes are never JSON-transported directly — a JSON array
 * of numbers would be four times the payload for no gain.
 *
 * Plain ES module with no imports, like the rest of this package — the Vite
 * client, the Cloudflare Worker and `scripts/goFishReplayTest.mjs` all load
 * the same file.
 */

/** Ranks, as byte values. Matches the engine's `RANK_ORDER` (2–A). */
export const GO_FISH_RANK_COUNT = 13;

/**
 * Hard ceiling on log length, in asks.
 *
 * Every ask either moves cards off an opponent (finite: 52 in the deck) or
 * draws from the stock (38 cards after the deal). Real games land between a
 * dozen and a few dozen asks; 512 is an order of magnitude of headroom over
 * any plausible honest game while bounding what a hostile client can make the
 * worker chew in one request — each ask is O(52), so the worst case here is
 * still well under a millisecond.
 */
export const MAX_GO_FISH_ACTIONS = 512;

/**
 * Encode a game's asks into bytes — one byte per ask, the rank's index.
 *
 * @param {number[]} ranks  Rank indices in play order, each 0–12.
 * @returns {Uint8Array} One byte per ask.
 * @throws {Error} on any rank outside 0–12.
 */
export function encodeGoFishActionLog(ranks) {
  const bytes = new Uint8Array(ranks.length);
  for (let i = 0; i < ranks.length; i++) {
    const rank = ranks[i];
    if (!Number.isInteger(rank) || rank < 0 || rank >= GO_FISH_RANK_COUNT) {
      throw new Error(`Action ${i}: rank index out of range: ${rank}`);
    }
    bytes[i] = rank;
  }
  return bytes;
}

/**
 * Decode a log back into rank indices.
 *
 * Throws on anything malformed — a byte over 12, or a log longer than
 * `MAX_GO_FISH_ACTIONS` — and on anything that cannot be a game the client's
 * encoder produced. A malformed log is refused *before* replay: a log the
 * encoder could not have written is protocol garbage, not a game that failed
 * to match, and scoring it as a mismatch would poison the verdict table with
 * noise.
 *
 * @param {Uint8Array} bytes
 * @returns {number[]} Rank indices, in play order.
 */
export function decodeGoFishActionLog(bytes) {
  if (bytes.length > MAX_GO_FISH_ACTIONS) {
    throw new Error(
      `Go Fish action log exceeds ${MAX_GO_FISH_ACTIONS} actions.`,
    );
  }

  const ranks = [];
  for (let i = 0; i < bytes.length; i++) {
    const rank = bytes[i];
    if (rank >= GO_FISH_RANK_COUNT) {
      throw new Error(`Action ${i}: rank index ${rank} out of range.`);
    }
    ranks.push(rank);
  }
  return ranks;
}

/**
 * Base64-encode an action log for transport in the claim.
 *
 * Same chunked construction as `encodeInputLog` — see the note there for why
 * the spread is avoided.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encodeGoFishLog(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Reverse `encodeGoFishLog`. Throws on malformed input rather than returning
 * a short log.
 *
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function decodeGoFishLog(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
