import { usePortalContext } from "./portal";

/**
 * Stand-in for `lib/utils/hooks/useVipAccess` (absent from this template).
 *
 * The originals read VIP off the main SFL game state; this fork has no VIP
 * source anywhere in `src/lib`, and the arcade has no VIP flag of its own. So
 * `game` is deliberately ignored and the answer comes from the portal
 * context — see `withArcadeProps`, which marks a **session-less** boot
 * (offline / local test, no `?jwt=`) as VIP so reward runs are rationed
 * per cabinet instead of across the whole arcade. A real session is treated
 * as non-VIP: that can only ever *reduce* rewards, never inflate the economy.
 *
 * VIP controls reward runs only (`isRewardRunAvailable`, `getPokerMode`).
 */
export function useVipAccess(_options?: {
  game?: unknown;
  type?: string;
}): boolean {
  return usePortalContext().isVip;
}
