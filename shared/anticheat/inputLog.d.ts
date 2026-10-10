/**
 * Types for `inputLog.js`.
 *
 * `inputLog.js` is a plain ES module (no TypeScript) for the same reason the
 * rest of this package is: the Cloudflare Worker imports it natively while Vite
 * resolves it for the client, and `scripts/replayHarness.mjs` runs it directly
 * under Node. One implementation, three consumers — see `rng.d.ts` for why a
 * shared copy is a correctness requirement rather than an optimisation.
 */

/** The shape an input object must have to be logged or replayed. */
export type LoggableInput = {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  /** Milliseconds of attack buffer left. Only `> 0` is ever read. */
  attackBuf: number;
  /** Milliseconds of magic buffer left. Only `> 0` is ever read. */
  magicBuf: number;
};

/** Bit positions within a logged tick. */
export declare const INPUT_BITS: {
  readonly LEFT: 1;
  readonly RIGHT: 2;
  readonly UP: 4;
  readonly DOWN: 8;
  readonly ATTACK: 16;
  readonly MAGIC: 32;
};

/**
 * Pack one tick's input into a byte in [0, 63].
 *
 * Sample **before** `stepMatch`: the step drains the buffers, so reading after
 * records the press as already spent.
 */
export declare function inputMask(input: LoggableInput): number;

/** Unpack a byte back onto an input. Inverse of `inputMask`. Mutates in place. */
export declare function applyMask<T extends LoggableInput>(
  input: T,
  mask: number,
  bufferMs: number,
): T;

/** Base64-encode a log for transport. */
export declare function encodeInputLog(bytes: Uint8Array): string;

/** Reverse `encodeInputLog`. Throws on malformed input. */
export declare function decodeInputLog(base64: string): Uint8Array;
