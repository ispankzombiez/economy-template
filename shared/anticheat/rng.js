/**
 * Deterministic PRNG — the seed of the whole anti-cheat.
 *
 * ## Why this exists
 *
 * A run can only be certified after the fact if the server can reproduce the
 * randomness the client used. Bare `Math.random()` is not reproducible and not
 * seedable, so every random decision in a verified game (enemy AI rolls, drops,
 * shuffles, spawn picks) must flow through one of these, seeded from a value the
 * **server** controls. Then a client cannot precompute a winning input log,
 * because it does not know the seed until the run has already begun.
 *
 * ## Why mulberry32
 *
 * It is a 32-bit integer generator with a period of 2^32, trivially portable,
 * and identical in integer arithmetic on every JS engine — no floating-point
 * drift, no BigInt, no `Math.sin` fudge factors whose last bits differ between
 * platforms. Determinism here is a correctness requirement, not a nicety, so the
 * arithmetic stays in exact 32-bit integer space (`| 0`, `>>> 0`).
 *
 * This is a plain ES module with no TypeScript and no imports so that the
 * Cloudflare Worker can import it natively while the Vite client picks it up
 * too — one implementation, shared by both, so the client and the server cannot
 * silently disagree about what "random" means. The types live in `rng.d.ts`.
 */

/**
 * Advance a generator **state object** in place and return the next float.
 *
 * The generator's whole state is the single integer `state.a`. Exposing it as a
 * plain `{ a }` object rather than hiding it in a closure is deliberate: a
 * closure cannot be serialized, and a verifier that pauses a run at a chunk
 * boundary and resumes it in a later request has to park that state in D1 and
 * read it back. `{ a: 12345 }` round-trips through `JSON.stringify` and
 * `JSON.parse` untouched and resumes the exact stream — a closed-over `a` would
 * silently come back `undefined` and start producing a different run.
 *
 * Mutating in place rather than returning `{ a, value }` keeps the hot path
 * allocation-free: this is called a handful of times per simulated tick, and a
 * fresh object per call would put avoidable GC pressure on the same CPU budget
 * the whole verification has to fit inside.
 *
 * The arithmetic is identical to the original closure version of `mulberry32`,
 * so switching to it does not change any sequence — see the note on
 * `mulberry32` below.
 *
 * @param {{ a: number }} state  Generator state, mutated in place.
 * @returns {number} Float in [0, 1).
 */
export function advanceRng(state) {
  state.a = (state.a + 0x6d2b79f5) | 0;
  let t = state.a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Fresh generator state for a seed.
 *
 * @param {number} seed  A 32-bit integer. Any number is coerced into uint32.
 * @returns {{ a: number }}
 */
export function makeRngState(seed) {
  // Coerce into an unsigned 32-bit integer so a negative or fractional seed
  // still lands in the same space the arithmetic below assumes.
  return { a: seed >>> 0 };
}

/**
 * Create a seeded generator. Returns a function yielding floats in [0, 1).
 *
 * Implemented over `advanceRng` so there is exactly one copy of the step
 * arithmetic in this package — the closure form and the serializable form must
 * not be able to drift apart, because the client advances one and the server
 * replays the other. The sequence produced is unchanged from the previous
 * standalone implementation.
 *
 * @param {number} seed  A 32-bit integer. Any number is coerced into uint32.
 * @returns {() => number}
 */
export function mulberry32(seed) {
  const state = makeRngState(seed);
  return function next() {
    return advanceRng(state);
  };
}

/**
 * A seeded generator bundled with the helpers a game actually reaches for.
 *
 * Keeping `int` / `pick` / `chance` next to the raw float means a game never
 * hand-rolls `Math.floor(rng() * n)` — the one place a subtle off-by-one in the
 * scaling would make the client and the server disagree about a whole run.
 *
 * @param {number} seed
 */
export function makeRng(seed) {
  const next = mulberry32(seed);
  return {
    /** Float in [0, 1). */
    next,
    /** Integer in [min, max], inclusive. */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** One element of `arr`. Returns undefined for an empty array. */
    pick(arr) {
      if (arr.length === 0) return undefined;
      return arr[Math.floor(next() * arr.length)];
    },
    /** True with probability `p`. */
    chance(p) {
      return next() < p;
    },
  };
}
