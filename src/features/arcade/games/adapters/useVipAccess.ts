import { usePortalContext } from "./portal";

/**
 * Stand-in for `lib/utils/hooks/useVipAccess` (absent from this template).
 *
 * The originals read VIP off the main SFL game state. This fork reads it from
 * the portal player profile instead — `farm.vip.expiresAt` or the lifetime
 * banner, see `lib/portal/vip.ts` — and the provider passes the result in. `game`
 * is still ignored: the answer comes from the portal context.
 *
 * `withArcadeProps` marks a **session-less** boot (offline / local test, no
 * `?jwt=`) as VIP so reward runs are rationed per cabinet instead of across the
 * whole arcade, and a live session whose profile failed to load degrades to
 * non-VIP: that direction can only ever *reduce* rewards.
 *
 * VIP controls reward runs only (`isRewardRunAvailable`, `getPokerMode`).
 */
export function useVipAccess(_options?: {
  game?: unknown;
  type?: string;
}): boolean {
  return usePortalContext().isVip;
}
