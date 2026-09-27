/**
 * Sunflower Land VIP, read from the portal player profile.
 *
 * ## Where the data comes from
 *
 * `GET {apiUrl}/portal/{portalId}/player` (see `getPortalPlayerProfile`) returns
 * the player's **whole farm**, and the only field the arcade treats as VIP is
 * `farm.vip.expiresAt`:
 *
 *   - a millisecond timestamp in the **future** → the player has VIP;
 *   - a timestamp in the past, or no `vip` / no `expiresAt` at all → no VIP.
 *
 * A paid subscription sets it to the end of the period; a lifetime VIP is
 * effectively never (`32501520000000`, i.e. the year 2999).
 *
 * This is deliberately *only* that field. `farm.inventory["Lifetime Farmer
 * Banner"]` is a tempting second signal — the farm carries both — but a lifetime
 * banner is an inventory reward, not a subscription, and the arcade's rules are
 * written in terms of VIP being active. Neither signal is in the portal JWT, and
 * neither is in the economies session (`/data?type=session` projects `farm` down
 * to `{ balance, bumpkin, username, faction }` and has no `vip` at all).
 *
 * ## Fail-safe
 *
 * A missing or malformed profile resolves to **non-VIP**, which is also what a
 * player with no session gets. That direction only ever *reduces* rewards (one
 * arcade-wide free run instead of one per cabinet), so an outage here can never
 * inflate the economy.
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
 * The arcade's VIP answer for a booted session.
 *
 * @param hasSession `false` for an offline / local boot with no `?jwt=`, which
 *                   the arcade has always treated as VIP so a dev session can
 *                   exercise the per-cabinet reward path.
 * @param profile    `playerData.portalProfile` — `undefined` when the profile
 *                   request failed (CORS, offline, 4xx). Degrades to non-VIP.
 */
export function resolveVipAccess(
  hasSession: boolean,
  profile: unknown,
  options: { now?: number } = {},
): boolean {
  if (!hasSession) return true;
  return isVipFarm(asRecord(profile)?.farm, options);
}
