/**
 * VIP for the arcade, read from an index this repo publishes itself.
 *
 * ## Why not call the Community API
 *
 * The obvious implementation — `GET /community/farms/{id}` with `x-api-key` —
 * does not work from the arcade, for two reasons measured against the live host:
 *
 * 1. **CORS.** `api.sunflower-land.com` echoes `Access-Control-Allow-Origin`
 *    only for `sunflower-land.com` and `www.sunflower-land.com`. The arcade is
 *    served from `nightshade-arcade.economies.sunflower-land.com`, so the
 *    preflight passes (the server does allow the `x-api-key` header) and the
 *    actual GET comes back with **no** `Access-Control-Allow-Origin` at all. The
 *    browser then discards a response the server sent perfectly happily. The
 *    request is not failing — the *reading* of it is.
 * 2. **The key is a credential.** It was wired in as `VITE_SUNFLOWER_COMMUNITY_API_KEY`,
 *    which Vite inlines into the shipped bundle, so it was readable by anyone
 *    who opened devtools.
 *
 * ## What happens instead
 *
 * `.github/workflows/vip-index.yml` runs `scripts/build-vip-index.mjs` daily
 * with the key held as a repository secret. It reads the Community API's nightly
 * farm dump and publishes `vip-index.json` to the `vip-data` branch. This file
 * fetches that over `raw.githubusercontent.com`, which answers
 * `Access-Control-Allow-Origin: *`, so no preflight, no credential, and nothing
 * to allow-list.
 *
 * The file looks like:
 *
 * ```json
 * { "source": "2026-09-27/active.jsonl.gz", "generatedAt": 1790570000000,
 *   "count": 17020,
 *   "entries": [[121500, "someplayer", 32501520000000], ...] }
 * ```
 *
 * ## Freshness
 *
 * The dump lands nightly, so the index is up to ~24 hours old — but the stored
 * value is `vip.expiresAt`, an **absolute timestamp**, not a boolean. A farm
 * already VIP therefore stays correctly VIP right up to its real expiry; only a
 * farm that became VIP since the dump waits for the next one. Blacklisted
 * accounts are dropped when the index is built.
 *
 * ## What this does and does not buy
 *
 * It keeps the credential off the client and makes the answer one *we* publish
 * rather than anything the player supplies, and the identity check below still
 * ties the entry to the farm the JWT was issued for.
 *
 * It is **not** a security boundary. Anyone willing to edit their own browser
 * can edit this too — the index is public by design (it is served from a public
 * repo with no credential), and a signature would not help because the key to
 * verify it ships in the same bundle they would be editing. The thing that would
 * close the economy down is a **server-side VIP requirement** on the per-cabinet
 * mints; see the note on `RAVEN_COIN_MINT_ACTION` in `features/arcade/lib/ravenCoin.ts`.
 * Treat this as a rewards signal, which is all the arcade uses it for.
 *
 * ## Ordering
 *
 * The session stays primary. This only runs when no local source can answer, so
 * it never overrides a `farm.vip.expiresAt` the session does provide.
 */

import { useEffect, useState } from "react";
import { useMinigameSession } from "./sessionProvider";
import { hasLocalVipSource, resolveVipAccess } from "./vip";

/**
 * Where the published index lives.
 *
 * Override with `VITE_VIP_INDEX_URL` when the index is served from somewhere
 * else (a fork, or a mirror on the arcade's own host).
 */
export const DEFAULT_VIP_INDEX_URL =
  "https://raw.githubusercontent.com/ispankzombiez/economy-template/vip-data/vip-index.json";

/**
 * The resolved index URL.
 *
 * A blank or missing override falls back to the default rather than disabling
 * the source — an unset variable must not quietly silence VIP for everyone. To
 * opt out, pass `indexUrl: ""` to {@link loadVipIndex} directly.
 */
export function vipIndexUrl(): string {
  const override = import.meta.env.VITE_VIP_INDEX_URL;
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  return DEFAULT_VIP_INDEX_URL;
}

/** One farm in the published index: `[account id, username, vip expiresAt]`. */
export type VipIndexEntry = [number, string, number];

/** The part of the index this file cares about. */
export type VipIndex = {
  source: string;
  generatedAt: number;
  entries: Map<number, { username: string; expiresAt: number }>;
};

/**
 * Parse a published index, or return `undefined` if it is not one.
 *
 * Deliberately strict about shape and lenient about content: a truncated or
 * hand-edited file must never look like "nobody is VIP", because the caller
 * turns `undefined` into "could not tell" and `false` into "not VIP". An empty
 * `entries` array *is* a valid answer, so it is accepted as such.
 */
export function parseVipIndex(body: unknown): VipIndex | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.entries)) return undefined;

  const entries = new Map<number, { username: string; expiresAt: number }>();
  for (const raw of record.entries) {
    if (!Array.isArray(raw)) return undefined;
    const [id, username, expiresAt] = raw as [unknown, unknown, unknown];
    if (typeof id !== "number" || !Number.isFinite(id)) return undefined;
    if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return undefined;
    entries.set(id, {
      username: typeof username === "string" ? username : "",
      expiresAt,
    });
  }

  return {
    source: typeof record.source === "string" ? record.source : "",
    generatedAt:
      typeof record.generatedAt === "number" ? record.generatedAt : Number.NaN,
    entries,
  };
}

/**
 * Is this entry about the farm we are paying?
 *
 * The index is keyed by account id, which is exactly what the portal JWT already
 * authenticated, so the lookup itself is the strong half of the check. The
 * username is the second, independent source: it comes from the dump rather than
 * from the player, and agreeing means a misrouted or mis-keyed entry has to
 * satisfy two separately-sourced values at once.
 *
 * Fails closed: an entry with no username, or a session with a username the
 * entry does not share, is "could not tell" rather than "yes". A session with no
 * username at all cannot be checked against, and — as before — is not treated as
 * a mismatch, because the id lookup already identified the farm.
 */
export function isVerifiedVipEntry({
  entry,
  expectedUsername,
}: {
  entry: { username: string };
  expectedUsername?: string;
}): boolean {
  if (expectedUsername === undefined) return true;

  const username = entry.username;
  if (typeof username !== "string" || username.trim() === "") return false;
  // Case-insensitive and trimmed: two sources describing the same farm should
  // agree even if one normalises casing. Being stricter would only cost a real
  // VIP their status over a cosmetic difference, while a genuinely different
  // player still fails to match.
  return username.trim().toLowerCase() === expectedUsername.trim().toLowerCase();
}

/**
 * Answer from an index body without touching the network.
 *
 * `undefined` means "could not tell": unparseable file, or an entry that failed
 * the identity check. `false` means the index is well-formed and simply does not
 * list this farm among its active VIPs — a real answer, not a failure.
 */
export function answerFromIndex({
  body,
  farmId,
  expectedUsername,
  now = Date.now(),
}: {
  body: unknown;
  farmId: number;
  expectedUsername?: string;
  now?: number;
}): boolean | undefined {
  const index = parseVipIndex(body);
  if (!index) return undefined;
  if (!Number.isFinite(farmId) || farmId <= 0) return undefined;

  const entry = index.entries.get(farmId);
  if (!entry) return false;
  if (!isVerifiedVipEntry({ entry, expectedUsername })) return undefined;

  return entry.expiresAt > now;
}

/** One in-flight or settled index per page load, so re-renders never re-request. */
let indexPromise: Promise<VipIndex | undefined> | undefined;

/**
 * Fetch and parse the published index, at most once per page load.
 *
 * A failed load is *not* cached: the next cabinet mount is allowed to try again,
 * so a blip during boot does not pin the player to "unknown" for the session.
 */
export function loadVipIndex({
  indexUrl = vipIndexUrl(),
}: { indexUrl?: string } = {}): Promise<VipIndex | undefined> {
  if (!indexUrl) return Promise.resolve(undefined);

  if (!indexPromise) {
    indexPromise = (async () => {
      try {
        // No custom headers, so this is a simple request: no preflight.
        const response = await fetch(indexUrl, { headers: { accept: "application/json" } });
        if (!response.ok) return undefined;
        return parseVipIndex(await response.json());
      } catch {
        // Network failure or malformed body: unknown, not "no".
        return undefined;
      }
    })();

    void indexPromise.then((index) => {
      if (!index) indexPromise = undefined;
    });
  }

  return indexPromise;
}

/** Per-farm answers, so one index read serves every component on the page. */
const farmCache = new Map<string, Promise<boolean | undefined>>();

/**
 * Is this farm VIP, according to the published index?
 *
 * `undefined` means "could not tell" — no index, a failed fetch, an unparseable
 * file, or an entry that failed the identity check. Callers must treat that as
 * unknown rather than as "no".
 */
export function fetchFarmVip({
  farmId,
  expectedUsername,
  indexUrl = vipIndexUrl(),
}: {
  farmId: number;
  expectedUsername?: string;
  indexUrl?: string;
}): Promise<boolean | undefined> {
  if (!Number.isFinite(farmId) || farmId <= 0) return Promise.resolve(undefined);

  const key = `${indexUrl}|${farmId}|${expectedUsername ?? ""}`;
  const existing = farmCache.get(key);
  if (existing) return existing;

  const pending = loadVipIndex({ indexUrl }).then((index) => {
    if (!index) {
      // Nothing was learned, so do not remember the answer.
      farmCache.delete(key);
      return undefined;
    }
    const entry = index.entries.get(farmId);
    if (!entry) return false;
    if (!isVerifiedVipEntry({ entry, expectedUsername })) {
      farmCache.delete(key);
      return undefined;
    }
    return entry.expiresAt > Date.now();
  });

  farmCache.set(key, pending);
  return pending;
}

/** Test seam: forget the index and every per-farm answer. */
export function clearVipIndexCache(): void {
  indexPromise = undefined;
  farmCache.clear();
}

/**
 * VIP, and whether that answer has settled.
 *
 * One hook owns the lookup so `isVip` and `resolved` can never disagree — they
 * previously lived in two hooks, and the second one derived "settled" from
 * whether a lookup was *possible* rather than whether it had *finished*, which
 * left `resolved` false forever and any caller waiting on it waiting forever.
 *
 * `resolved` is `true` once the answer can no longer change: no session, a
 * session that answers locally, no usable farm id, or the lookup has returned —
 * including when it returned "could not tell". It is never left hanging on a
 * source that will not answer, so waiting on it is always safe.
 *
 * Two components calling this share one request: {@link loadVipIndex} memoises
 * the file, so the second caller gets the first one's result.
 */
function useVipState(): { isVip: boolean; resolved: boolean } {
  const { jwt, farm, farmId, playerData } = useMinigameSession();
  const portalProfile = playerData?.portalProfile;

  const localVip = resolveVipAccess({
    hasSession: !!jwt,
    sessionFarm: farm,
    portalProfile,
  });
  const answeredLocally = hasLocalVipSource({
    sessionFarm: farm,
    portalProfile,
  });

  const expectedUsername =
    typeof farm?.username === "string" ? farm.username : undefined;
  // Only ask when the session cannot answer for itself: it is the primary
  // source, and a lookup fired before the farm arrives would be memoised against
  // a question the session was about to answer itself.
  const willQuery =
    !!jwt && !!farm && !answeredLocally && Number.isFinite(farmId) && farmId > 0;

  const [answer, setAnswer] = useState<boolean | undefined>(undefined);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!willQuery) {
      setSettled(true);
      return;
    }
    setSettled(false);
    setAnswer(undefined);

    let cancelled = false;
    void fetchFarmVip({ farmId, expectedUsername }).then((value) => {
      if (cancelled) return;
      setAnswer(value);
      setSettled(true);
    });

    return () => {
      cancelled = true;
    };
  }, [willQuery, farmId, expectedUsername]);

  // Never let a fallback answer override a local one.
  const isVip = answeredLocally ? localVip : (answer ?? localVip);
  return { isVip, resolved: !willQuery || settled };
}

/**
 * The arcade's VIP answer, session first and the published index as a fallback.
 *
 * The first render always reports whatever the local sources say — which is
 * `false` until either the session projection carries `vip` or the index
 * answers. The index is a network read, so treat a `false` immediately after
 * boot as "not known yet" rather than "not VIP". That only ever affects which
 * mint a win dispatches, never whether a win counts.
 */
export function useVipAccess(): boolean {
  return useVipState().isVip;
}

/**
 * Has the VIP answer settled yet?
 *
 * `false` only while the index lookup is genuinely in flight. Callers that
 * **mint something as a consequence of the answer** must wait for this, because
 * acting on the pre-resolution `false` bakes in the wrong choice: the free-run
 * grant picks an arcade-wide token over per-cabinet ones from `isVip`, so
 * granting before VIP resolves hands a VIP the non-VIP allowance and locks it in
 * for the day.
 */
export function useVipResolved(): boolean {
  return useVipState().resolved;
}
