/**
 * Sunflower Land VIP, read from the player economies session.
 *
 * ## Where the data comes from
 *
 * **The session is the only source.** `GET {economiesApi}/data?type=session`
 * projects the player's SFL farm, and the arcade already depends on it for
 * everything it shows: `farm.username` is the name under the bumpkin and
 * `farm.balance` is the FLOWER in the HUD. VIP is one more field on that same
 * object:
 *
 * ```json
 * "vip": { "isVip": true, "type": "paid", "expiresAt": 1793923200000 }
 * ```
 *
 * That endpoint serves `Access-Control-Allow-Origin: *`, so unlike the older
 * portal route it is readable from the hosted arcade with no allow-listing and
 * no credential. It answers with the **player's own token** as the only
 * credential, and the shape of the response is the server's, not ours.
 *
 * ## Why the session replaced the published index
 *
 * This fork used to answer VIP from `vip-index.json` — a file a nightly GitHub
 * Action built out of the Community API's farm dump, because at the time the
 * session projection shipped no `vip` field at all and `api.sunflower-land.com`
 * is CORS-blocked for the arcade's origin. Now that the session carries the
 * status, the index is gone: it was a day-old snapshot of a value we can be
 * told directly, and it needed a workflow, a secret and a 650 KB daily commit to
 * approximate what one field already says.
 *
 * ## What `isVip` counts
 *
 * The API folds **paid VIP, an active trial, and the Lifetime Farmer Banner**
 * into that one boolean, and says so in its docs, ending with "Use it to gate
 * VIP-only perks in your game". This fork previously derived VIP from
 * `expiresAt` alone, which could express none of the first two and meant the
 * arcade quietly disagreed with the main game about who was VIP. The server's
 * definition wins. `type` is carried through for a caller that ever needs to
 * tell the three apart, but nothing here branches on it.
 *
 * This is what makes the session the *right* source rather than merely a
 * tidier one: the answer is produced by `economies-api` from the farm's own
 * record, rather than published by us from a dump the player cannot influence.
 * A player still owns the browser, but they no longer have to talk their way
 * past a file this repo writes.
 *
 * ## The `expiresAt` fallback
 *
 * `isVip` is consulted when present, and an `expiresAt`-only payload — an
 * `economies-api` not yet rolled forward — still answers, so a lagging API does
 * not silently revoke everybody's VIP. It is a fallback and never an override:
 * a payload saying `isVip: false` is respected even with a future `expiresAt`.
 *
 * ## Stale snapshots
 *
 * `bootstrap.farm` is captured once at boot, so a long-lived tab can hold a
 * session fetched before the player's VIP lapsed. Where `isVip` is `true` and
 * `expiresAt` is present but in the past, the two disagree and the timestamp
 * wins: expiry is the one thing the client can still judge for itself. A
 * lifetime VIP is sent with no `expiresAt` at all, so it is unaffected.
 *
 * ## Fail-safe
 *
 * A missing or malformed record resolves to **non-VIP**, which is also what a
 * player with no session gets. That direction only ever *reduces* rewards (one
 * arcade-wide free run instead of one per cabinet), so an outage here can never
 * inflate the economy.
 *
 * ## Not a security boundary
 *
 * VIP is a rewards multiplier, and the decision still runs in the player's
 * browser: someone who edits the session payload in devtools can claim VIP for
 * themselves, and the worst case is the per-cabinet allowance rather than the
 * arcade-wide one. What closes the economy down is a **server-side VIP
 * requirement** on the per-cabinet mints — see the note on
 * `RAVEN_COIN_MINT_ACTION` in `features/arcade/lib/ravenCoin.ts`. Treat this as
 * the rewards signal it is, which is all the arcade uses it for.
 */

import { useMinigameSession } from "./sessionProvider";

type VipRecord = {
  isVip?: unknown;
  expiresAt?: unknown;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * `vip.isVip` as a boolean, or `undefined` when the record carries no flag.
 *
 * The API sends a real boolean. A value that arrived as a string is accepted
 * for the same reason `expiresAt` is: a future serializer change must not be
 * able to silently revoke everybody's VIP. Anything else — a number, an object,
 * `"yes"` — is read as "no flag" and falls through to the timestamp path rather
 * than being guessed at.
 */
function readVipFlag(vip: unknown): boolean | undefined {
  const record = asRecord(vip);
  if (!record) return undefined;

  const raw = record.isVip;
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

/**
 * `vip.expiresAt` as a millisecond timestamp, or `undefined` when the record
 * has no usable date — which includes a lifetime VIP, where the API omits it.
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
 * This farm's VIP status, or `undefined` when the source cannot answer.
 *
 * `undefined` means "no usable VIP record" — a farm with no `vip` block, or one
 * carrying neither a flag nor a date. That is deliberately distinct from
 * `false`: it is the case where an API that predates the field has said nothing,
 * as opposed to saying no.
 *
 * @param farm `farm` from `/data?type=session`.
 * @param now  Injectable for tests; defaults to the current time.
 */
export function readFarmVipStatus(
  farm: unknown,
  { now = Date.now() }: { now?: number } = {},
): boolean | undefined {
  const record = asRecord(farm);
  if (!record) return undefined;

  const flag = readVipFlag(record.vip);
  const expiresAt = readVipExpiry(record.vip);

  // The flag is the server's own answer and normally wins outright. The one
  // exception is a snapshot that has gone stale under us: `bootstrap.farm` is
  // captured at boot, so `isVip: true` can outlive the subscription it was
  // minted for. A past timestamp beside a true flag is exactly that, and
  // expiry is the one judgement the client can still make correctly.
  if (flag !== undefined) {
    return flag && (expiresAt === undefined || expiresAt > now);
  }

  // No flag: an API that only ever sent `expiresAt`. A lifetime VIP is sent
  // with no date at all, so it reads as unknown rather than as a false negative.
  if (expiresAt === undefined) return undefined;
  return expiresAt > now;
}

/**
 * Does this farm have VIP?
 *
 * True only while the farm reports itself VIP and has not lapsed.
 *
 * @param farm  `farm` from `/data?type=session`.
 * @param now   Injectable for tests; defaults to the current time.
 */
export function isVipFarm(
  farm: unknown,
  { now = Date.now() }: { now?: number } = {},
): boolean {
  return readFarmVipStatus(farm, { now }) ?? false;
}

/**
 * Does this farm carry a usable VIP record at all?
 *
 * Separates "the server answered no" from "this source cannot answer", so a
 * caller can tell a non-VIP from a deployment that has not shipped the field.
 */
export function hasVipRecord(farm: unknown): boolean {
  return readFarmVipStatus(farm) !== undefined;
}

/**
 * The arcade's VIP answer for a booted session.
 *
 * @param hasSession  `false` for an offline / local boot with no `?jwt=`, which
 *                    the arcade has always treated as VIP so a dev session can
 *                    exercise the per-cabinet reward path.
 * @param sessionFarm `farm` from the economies session.
 * @param now         Injectable for tests; defaults to the current time.
 */
export function resolveVipAccess({
  hasSession,
  sessionFarm,
  now,
}: {
  hasSession: boolean;
  sessionFarm?: unknown;
  now?: number;
}): boolean {
  if (!hasSession) return true;
  return readFarmVipStatus(sessionFarm, { now }) ?? false;
}

/**
 * The arcade's VIP answer.
 *
 * A pure derivation of the booted session, so it is settled from the first
 * render: there is no second lookup to wait on, and no `resolved` flag to
 * publish. That gate used to be needed because the published index was a network
 * read, and it had to be honoured — the free-run grant below picks an
 * arcade-wide token over per-cabinet ones from `isVip`, so granting before the
 * answer landed handed a VIP the non-VIP allowance and, because the grant
 * carries a 24h cooldown, locked it in for the day. Nothing here is async, so
 * the question can no longer arise.
 *
 * Note the session's `farm` is fixed for the lifetime of the tab, so a VIP who
 * lapses mid-session keeps their per-cabinet allowance until they reload. The
 * `expiresAt` cross-check in {@link readFarmVipStatus} covers the common case
 * of an expiry that lands mid-session; a lifetime VIP and one whose subscription
 * is renewed elsewhere both wait for the next boot, which is a rewards
 * multiplier and not a security boundary either way.
 */
export function useVipAccess(): boolean {
  const { jwt, farm } = useMinigameSession();
  return resolveVipAccess({ hasSession: !!jwt, sessionFarm: farm });
}