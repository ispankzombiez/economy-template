/**
 * Sunflower Land VIP, read from the player economies session.
 *
 * ## Where the data comes from
 *
 * **The session is the source.** `GET {economiesApi}/data?type=session` projects
 * the player's SFL farm, and the arcade already depends on it for everything it
 * shows: `farm.username` is the name under the bumpkin and `farm.balance` is the
 * FLOWER in the HUD. VIP is one more field on that same object —
 * `farm.vip.expiresAt` — and the only field the arcade treats as VIP.
 *
 * That endpoint serves `Access-Control-Allow-Origin: *`, so unlike the older
 * portal route it is readable from the hosted arcade with no allow-listing.
 *
 * ## The portal profile is legacy
 *
 * This used to read `GET {apiUrl}/portal/{portalId}/player`, the antiquated
 * portal system. That request is **CORS-blocked for the arcade's own origin** —
 * the allow-list on `api.sunflower-land.com` answers only `sunflower-land.com`
 * and `www.sunflower-land.com` — so it fails with `net::ERR_FAILED` and
 * `portalProfile` is always `undefined` in a hosted build. It is kept below only
 * as a fallback for an environment that can still reach it, and can be deleted
 * once the session projection carries `vip`.
 *
 * ## What counts as VIP
 *
 * Only `farm.vip.expiresAt`, and only while it is in the future:
 *
 *   - a millisecond timestamp in the future → the player has VIP;
 *   - a timestamp in the past, or no `vip` / no `expiresAt` at all → no VIP.
 *
 * A paid subscription sets it to the end of the period; a lifetime VIP is
 * effectively never (`32501520000000`, i.e. the year 2999).
 *
 * This is deliberately *only* that field. `farm.inventory["Lifetime Farmer
 * Banner"]` is a tempting second signal — the farm carries both — but a lifetime
 * banner is an inventory reward, not a subscription, and the arcade's rules are
 * written in terms of VIP being active. Neither signal is in the portal JWT.
 *
 * ## Fail-safe
 *
 * A missing or malformed record resolves to **non-VIP**, which is also what a
 * player with no session gets. That direction only ever *reduces* rewards (one
 * arcade-wide free run instead of one per cabinet), so an outage here can never
 * inflate the economy.
 *
 * Note this is a rewards multiplier, not a security boundary: a player who
 * forges their own session payload can claim VIP for themselves, and the worst
 * case is the per-cabinet allowance rather than the arcade-wide one.
 */

type VipRecord = {
  expiresAt?: unknown;
};

type FarmRecord = {
  vip?: VipRecord | unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * `farm.vip.expiresAt` as a millisecond timestamp, or `undefined` when the farm
 * has no VIP record or no usable date.
 *
 * SFL sends a number; a value that arrived as a numeric string is accepted so a
 * future serializer change cannot silently revoke everybody's VIP.
 */
function readVipExpiry(vip: unknown): number | undefined {
  const record = asRecord(vip);
  if (!record) return undefined;

  const raw = record.expiresAt;
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : Number.NaN;

  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Does this farm have VIP?
 *
 * True only while `farm.vip.expiresAt` is in the future.
 *
 * @param farm  `portalProfile.farm` — the raw `/portal/:id/player` payload.
 * @param now   Injectable for tests; defaults to the current time.
 */
export function isVipFarm(
  farm: unknown,
  { now = Date.now() }: { now?: number } = {},
): boolean {
  const record = asRecord(farm) as FarmRecord | undefined;
  if (!record) return false;

  const expiresAt = readVipExpiry(record.vip);
  return expiresAt !== undefined && expiresAt > now;
}

/**
 * Does this farm carry a usable VIP record at all?
 *
 * Separates "we asked and the answer was no" from "this source cannot answer",
 * which is what lets {@link resolveVipAccess} prefer the session and fall back to
 * the legacy portal profile only when the session has nothing to say.
 */
function hasVipRecord(farm: unknown): boolean {
  return readVipExpiry(asRecord(farm)?.vip) !== undefined;
}

/**
 * The arcade's VIP answer for a booted session.
 *
 * Prefers the **session** (`farm` from `/data?type=session`) - the system the
 * arcade is migrating to, and the only one readable from its own origin. The
 * portal profile is consulted solely as a legacy fallback, and only when the
 * session carries no VIP record, so an environment that can still reach the old
 * route keeps working without letting it override the current system.
 *
 * @param hasSession    `false` for an offline / local boot with no `?jwt=`, which
 *                      the arcade has always treated as VIP so a dev session can
 *                      exercise the per-cabinet reward path.
 * @param sessionFarm   `farm` from the economies session.
 * @param portalProfile `playerData.portalProfile`, the legacy route. `undefined`
 *                      in a hosted build, where the request is CORS-blocked.
 * @param now           Injectable for tests; defaults to the current time.
 */
export function resolveVipAccess({
  hasSession,
  sessionFarm,
  portalProfile,
  now,
}: {
  hasSession: boolean;
  sessionFarm?: unknown;
  portalProfile?: unknown;
  now?: number;
}): boolean {
  if (!hasSession) return true;

  const options = { now };
  if (hasVipRecord(sessionFarm)) {
    return isVipFarm(sessionFarm, options);
  }
  return isVipFarm(asRecord(portalProfile)?.farm, options);
}
