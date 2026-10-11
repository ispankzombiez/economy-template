/**
 * Types for `solitaireLog.js`.
 *
 * `solitaireLog.js` is a plain ES module (no TypeScript) for the same reason
 * the rest of this package is: the Cloudflare Worker imports it natively while
 * Vite resolves it for the client, and `scripts/solitaireReplayTest.mjs` runs
 * it directly under Node. One implementation, three consumers — see
 * `rng.d.ts` for why a shared copy is a correctness requirement rather than an
 * optimisation.
 */

/**
 * Where a move's source card lives. Mirrors the engine's `SelectedCard` exactly,
 * so a decoded action can be handed straight to the engine's move appliers.
 *
 * `cardIndex` is the index *within the face-up run* — clicking the third card
 * of a run moves the run from that card, not from its top — and is meaningful
 * only for tableau sources.
 */
export type SolitaireSource =
  | { source: "waste" }
  | { source: "tableau"; pileIndex: number; cardIndex: number };

/**
 * One logged action, narrowed by its opcode.
 *
 * `DRAW`, `AUTO_FOUNDATION` and `UNDO` carry no source: the stock, the sweep
 * and the history stack are all found from the state alone.
 */
export type SolitaireAction =
  | { op: 0 | 3 | 5 }
  | { op: 4; source: SolitaireSource }
  | { op: 1; source: SolitaireSource; target: number }
  | { op: 2; source: SolitaireSource; suit: number };

/** Opcodes. Named so no caller has to remember which number is which. */
export declare const SOLITAIRE_OPS: {
  readonly DRAW: 0;
  readonly MOVE_TO_TABLEAU: 1;
  readonly MOVE_TO_FOUNDATION: 2;
  readonly AUTO_FOUNDATION: 3;
  readonly SMART: 4;
  readonly UNDO: 5;
};

/** Hard ceiling on log length, in actions. */
export declare const MAX_SOLITAIRE_ACTIONS: number;

/** Encode one action into its two bytes. Throws on unknown op / out-of-range args. */
export declare function encodeAction(action: SolitaireAction): number[];

/** Encode a whole game's actions into two bytes each. */
export declare function encodeActionLog(actions: SolitaireAction[]): Uint8Array;

/**
 * Decode a log back into actions. Throws on anything malformed — unknown
 * opcode, out-of-range pile/suit/cardIndex, wrong length, over the ceiling.
 */
export declare function decodeActionLog(bytes: Uint8Array): SolitaireAction[];

/** Base64-encode an action log for transport in the claim. */
export declare function encodeSolitaireLog(bytes: Uint8Array): string;

/** Reverse `encodeSolitaireLog`. Throws on malformed input. */
export declare function decodeSolitaireLog(base64: string): Uint8Array;
