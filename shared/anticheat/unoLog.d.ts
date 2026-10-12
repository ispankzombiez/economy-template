/**
 * The Uno action log: every choice the *player* made, in order.
 *
 * Byte encoding, base64 for transport:
 *
 *   `0x00`                — draw a card
 *   `0x01 + index`        — play the card at `index` in the player's hand
 *   `0x80 | index`, then  — play the Wild at `index`, naming the colour it
 *   a colour byte `0x03`    turns the game to
 *
 * The three bots are re-simulated from the seed by both sides, never logged.
 */

export const UNO_COLOR_COUNT: 4;
export const MAX_UNO_ACTIONS: 600;
export const MAX_UNO_HAND_INDEX: 126;

export interface UnoDrawAction {
  kind: "draw";
}

export interface UnoPlayAction {
  kind: "play";
  /** Position in the engine's hand order (not the sorted display order). */
  index: number;
  /** Colour byte 0–3. Present exactly when the card played is a Wild. */
  color?: number;
}

export type UnoAction = UnoDrawAction | UnoPlayAction;

export function encodeUnoActionLog(actions: UnoAction[]): Uint8Array;

export function decodeUnoActionLog(bytes: Uint8Array): UnoAction[];

export function encodeUnoLog(bytes: Uint8Array): string;

export function decodeUnoLog(base64: string): Uint8Array;
