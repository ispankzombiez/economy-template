/**
 * Types for `rng.js`.
 *
 * `rng.js` is a plain ES module (no TypeScript) so the Cloudflare Worker can
 * import it natively while Vite resolves it for the client — one implementation
 * shared by both, which is a correctness requirement for anti-cheat: if the two
 * runtimes could disagree about a single random roll, a whole run's replay
 * would diverge. These declarations give the client full types without putting
 * TypeScript syntax in the file the worker imports.
 */

/**
 * The complete state of a seeded generator.
 *
 * A single integer, held as a plain object so it can be written to D1 and read
 * back when a verifier pauses a run at a chunk boundary. Recreating it from the
 * seed with `makeRngState(seed)` resumes the identical stream.
 */
export type RngState = {
  /** Generator counter. Unsigned 32-bit, stored as a `number`. */
  a: number;
};

/**
 * A seeded generator bundled with the helpers a game actually reaches for.
 *
 * Note that this is a plain object with methods — it is **not** callable. An
 * earlier revision of this file described it as `(() => number) & {...}`, which
 * let `rng()` type-check and then throw at runtime; the type now matches what
 * `makeRng` actually returns.
 */
export type Rng = {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** One element of `arr`. Returns undefined for an empty array. */
  pick<T>(arr: readonly T[]): T | undefined;
  /** True with probability `p`. */
  chance(p: number): boolean;
};

/**
 * Advance a generator state in place and return the next float in [0, 1).
 *
 * Mutates `state.a`. Kept allocation-free because this runs several times per
 * simulated tick.
 */
export declare function advanceRng(state: RngState): number;

/** Fresh generator state for a 32-bit seed. */
export declare function makeRngState(seed: number): RngState;

/** Create a seeded generator. Returns a function yielding floats in [0, 1). */
export declare function mulberry32(seed: number): () => number;

/** A seeded generator bundled with the helpers a game actually reaches for. */
export declare function makeRng(seed: number): Rng;
