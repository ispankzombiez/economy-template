import type { ComponentType } from "react";
import type { RewardWinMeta } from "./games/adapters/portal";

/** x/y coordinate pair used by spawn helpers */
export type Coordinates = { x: number; y: number };

/** Props passed to every local arcade game component */
export interface ArcadeGameProps {
  onBack: () => void;
  /**
   * A cabinet paid out.
   *
   * `meta.fundedBy` says which published mint to dispatch (the day's free
   * allowance or the uncapped ticket-funded one) and `meta.machine` which
   * cabinet produced it, so a VIP free run can mint that cabinet's own action.
   */
  onWin: (tokens: number, meta?: RewardWinMeta) => void;
  tokenReward: number;
}

/**
 * Implementation backing strategy.
 * - "local"      → fully playable React game; owns its own back button via onBack prop
 * - "scaffolded" → non-broken placeholder; owns its own back button via onBack prop
 * - "portal"     → reserved for future hosted-portal integration
 *
 * ("demo" existed while template example apps were registered; removed when
 * they were pruned from the arcade registry.)
 */
export type ArcadeBackingType = "local" | "portal" | "scaffolded";

/**
 * Progression status used by the hub.
 * - available: fully playable
 * - coming-soon: not yet implemented (no component rendered)
 * - scaffolded: non-broken placeholder exists with clear status message
 */
export type ArcadeGameStatus = "available" | "coming-soon" | "scaffolded";

/** Central arcade game descriptor used by the registry and the hub */
export interface ArcadeGameEntry {
  id: string;
  name: string;
  description: string;
  tokenReward: number;
  /** Hub display status */
  status: ArcadeGameStatus;
  /** Implementation strategy */
  backingType: ArcadeBackingType;
  /**
   * For local/scaffolded games: the React component to render when the game is launched.
   * Must accept ArcadeGameProps.
   */
  component?: ComponentType<ArcadeGameProps>;
  /**
   * For portal-backed games: the minigame id as registered in the
   * Sunflower-Land minigames registry (src/features/game/types/minigames.ts).
   * Source location was not verified during initial research handoff.
   */
  portalId?: string;
  /** Developer note about implementation status or source uncertainty */
  devNote?: string;
}
