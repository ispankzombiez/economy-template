/**
 * Types for `goFishLog.js`.
 *
 * The file itself is a plain ES module (no TypeScript) so the Cloudflare
 * Worker can import it natively while Vite resolves it for the client — one
 * implementation shared by both ends, which is a correctness requirement for
 * anti-cheat: a codec that read ranks differently on the two sides would
 * refuse every honest game.
 */

/** Ranks, as byte values. Matches the engine's `RANK_ORDER` (2–A). */
export declare const GO_FISH_RANK_COUNT: 13;

/** Hard ceiling on log length, in asks. */
export declare const MAX_GO_FISH_ACTIONS: 512;

/** Encode a game's asks into bytes — one byte per ask, the rank's index. */
export declare function encodeGoFishActionLog(ranks: number[]): Uint8Array;

/** Decode a log back into rank indices. Throws on anything malformed. */
export declare function decodeGoFishActionLog(bytes: number[]): number[];

/** Base64-encode an action log for transport in the claim. */
export declare function encodeGoFishLog(bytes: Uint8Array): string;

/** Reverse `encodeGoFishLog`. Throws on malformed input. */
export declare function decodeGoFishLog(base64: string): Uint8Array;
