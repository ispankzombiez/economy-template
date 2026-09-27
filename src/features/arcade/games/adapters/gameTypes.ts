import type { Equipped } from "features/game/types/bumpkin";

/**
 * Stand-in for the full Sunflower Land `features/game/types/game` surface.
 *
 * The original arcade ran inside the main SFL client, so its `session.ts`
 * helpers read `GameState`. Only a handful of fields are actually touched by
 * the ten games — everything below is the exact subset they use, typed
 * loosely enough that real (API) state and the arcade's local state both fit.
 */

/**
 * Minigame id.
 *
 * `string` rather than a literal union: the originals cast ids that are not in
 * the SFL registry (`"barley-breaker" as MinigameName`, `"tetris" as any`, …),
 * so a narrow union would only fight the ported code.
 */
export type MinigameName = string;

/** One day of attempt history for a single minigame. */
export type MinigameHistoryDay = {
  attempts: number;
  highscore?: number;
};

/** A bought "+1 reward attempt". `purchasedAt` is a timestamp or ISO string. */
export type MinigamePurchase = {
  sfl?: number;
  items?: Record<string, number>;
  purchasedAt: number | string;
};

export type Minigame = {
  history?: Record<string, MinigameHistoryDay>;
  highscore?: number;
  purchases?: MinigamePurchase[];
};

export type GameState = {
  /** FLOWER balance — gates the paid "+1 reward attempt" button. */
  balance?: string | number;
  /** Current bumpkin; only `equipped` is read (for the in-game NPC portrait). */
  bumpkin?: { equipped?: Equipped } | null;
  inventory?: Record<string, string | number>;
  minigames: {
    games: Record<MinigameName, Minigame | undefined>;
  };
};

/** Loose bag for the `items` half of `purchase({ sfl, items })`. */
export type InventoryItemName = string;
