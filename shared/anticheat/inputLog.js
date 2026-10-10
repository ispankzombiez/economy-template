/**
 * The per-tick input log: what a player *did*, as opposed to what happened.
 *
 * ## Why this exists
 *
 * Checkpoints certify that a run's outcome was *reachable* — fifteen moments at
 * which the claimed state is not impossible. That is a real check and a real
 * limit: a plausible-looking log still passes it. Full replay closes the gap,
 * because a server that re-simulates the exact inputs does not ask "could this
 * have happened" but "did it".
 *
 * To replay, both ends must agree on one encoding. If the client packs bits in
 * one order and the worker unpacks them in another, every replay diverges and
 * the match rate measures the disagreement rather than the play. That failure
 * would be indistinguishable from cheating, which is why this lives in
 * `shared/` rather than being written twice: a second copy is a second opinion,
 * and anti-cheat cannot afford to have two.
 *
 * ## Why one byte per tick
 *
 * Six bits suffice — four directions plus two buffer flags — and a full byte
 * costs about 8 KB more than bit-packing over a three-minute run. Not worth it:
 * a shift-and-mask routine whose off-by-one silently desyncs every replay is a
 * far more expensive bug than 8 KB of request body.
 *
 * ## Why a bit, not the buffer value
 *
 * `attackBuf` and `magicBuf` are millisecond counters, and the log records only
 * whether each is non-zero. That is lossless rather than lossy: the engine's
 * `drain` tests `> 0` and then zeroes, `advanceTimers` only decrements, and no
 * other code reads the number. Two runs whose buffers are both live therefore
 * drain on exactly the same tick.
 *
 * Plain ES module with no imports, like the rest of this package — the Vite
 * client, the Cloudflare Worker and `scripts/replayHarness.mjs` all load the
 * same file.
 */

/** Bit positions. Named so a decoder never has to remember which is which. */
export const INPUT_BITS = {
  LEFT: 1,
  RIGHT: 2,
  UP: 4,
  DOWN: 8,
  ATTACK: 16,
  MAGIC: 32,
};

/**
 * Pack one tick's input into a byte.
 *
 * **Must be sampled before `stepMatch`**, not after: the step drains the attack
 * and magic buffers, so sampling afterwards records the press as already spent
 * and the replay would never see it.
 *
 * @param {{ left: boolean, right: boolean, up: boolean, down: boolean,
 *           attackBuf: number, magicBuf: number }} input
 * @returns {number} Byte in [0, 63].
 */
export function inputMask(input) {
  return (
    (input.left ? INPUT_BITS.LEFT : 0) |
    (input.right ? INPUT_BITS.RIGHT : 0) |
    (input.up ? INPUT_BITS.UP : 0) |
    (input.down ? INPUT_BITS.DOWN : 0) |
    (input.attackBuf > 0 ? INPUT_BITS.ATTACK : 0) |
    (input.magicBuf > 0 ? INPUT_BITS.MAGIC : 0)
  );
}

/**
 * Unpack a byte back onto an input object — the inverse of `inputMask`.
 *
 * `bufferMs` is the value the game writes on keydown (`INPUT_BUFFER_MS`). The
 * exact figure does not affect behaviour, since only "is it non-zero" is ever
 * read, but passing the real one keeps a replay faithful even if that ever
 * stops being true.
 *
 * Mutates `input` in place and returns it, so it can be used inline.
 *
 * @param {{ left: boolean, right: boolean, up: boolean, down: boolean,
 *           attackBuf: number, magicBuf: number }} input
 * @param {number} mask  A byte previously produced by `inputMask`.
 * @param {number} bufferMs  Milliseconds to restore a live buffer to.
 * @returns {typeof input}
 */
export function applyMask(input, mask, bufferMs) {
  input.left = (mask & INPUT_BITS.LEFT) !== 0;
  input.right = (mask & INPUT_BITS.RIGHT) !== 0;
  input.up = (mask & INPUT_BITS.UP) !== 0;
  input.down = (mask & INPUT_BITS.DOWN) !== 0;
  input.attackBuf = (mask & INPUT_BITS.ATTACK) !== 0 ? bufferMs : 0;
  input.magicBuf = (mask & INPUT_BITS.MAGIC) !== 0 ? bufferMs : 0;
  return input;
}

/**
 * Base64-encode a log for transport in the claim.
 *
 * Built in 32 KB chunks rather than one `String.fromCharCode(...bytes)`: the
 * spread over a several-thousand-byte array exhausts the call stack, and a run
 * long enough to be worth certifying is exactly the run long enough to blow it.
 *
 * `btoa` exists in the browser, in Cloudflare Workers and in Node ≥16, so the
 * same function can produce the log here and the worker can reverse it with
 * `atob`.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function encodeInputLog(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Reverse `encodeInputLog`. Throws on malformed input rather than returning a
 * short log — a replay over a truncated trace is not a weaker check, it is a
 * wrong one.
 *
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function decodeInputLog(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
