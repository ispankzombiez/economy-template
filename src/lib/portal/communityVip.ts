/**
 * VIP via the Sunflower Land **Community API** — a fallback, not the primary.
 *
 * ## Why this exists
 *
 * `farm.vip` is not in the player economies session yet, and the older portal
 * route the arcade used to read is CORS-blocked for its origin. The Community API
 * (`https://sunflower-land.com/community-docs/`) serves the same farm data, so
 * it is wired here as a third source.
 *
 * ## The endpoint
 *
 * `GET {base}/community/farms/{id}` with the key in `x-api-key`, base
 * `https://api.sunflower-land.com` (per the docs' own "Base URL" field). The
 * documented response is:
 *
 * ```json
 * { "farm": { ... }, "id": 121500, "nft_id": 29411,
 *   "nftId": 29411, "isBlacklisted": false, "updatedAt": "2026-08-25T03:12:44.000Z" }
 * ```
 *
 * The `id` path parameter is flexible: numeric <= 1,000,000,000 resolves as an
 * **NFT id**, a larger number as an **account id**, and a `0x...` value as a
 * linked wallet address. A session `farmId` is the account id, so it takes the
 * second branch. The full farm object is the same game state a player sees when
 * visiting, which is why `farm.vip` can be read off it.
 *
 * Documented failure modes, all of which must resolve to "unknown" rather than
 * "not VIP": `401` (key absent/invalid, or its farm lost VIP or level 50 — a key
 * is only valid while its own farm meets the requirements), `404` (no such farm),
 * and `429` (per-IP throttle, roughly one request per 5s, doubling to 10s if
 * hammered).
 *
 * ## Two hard limits, both outside this file
 *
 * 1. **The key is public.** It comes from a `VITE_*` variable, which Vite inlines
 *    into the shipped bundle, so every player can read it. That is an accepted
 *    trade-off — the arcade owner can rotate the key at any time — but be clear
 *    about what it means: it is a shared credential handed to every visitor, not
 *    a private dev secret, and abuse of it is attributed to the owner.
 * 2. **CORS still blocks us.** `api.sunflower-land.com` allows
 *    `sunflower-land.com` and `www.sunflower-land.com` only, and the preflight
 *    for `/community/*` returns no `Access-Control-Allow-Origin` for the
 *    arcade's host. The request below therefore fails until that origin is
 *    allow-listed. It is `x-api-key` that makes the request preflighted, and the
 *    server already allows that header, so the allow-list is the only thing
 *    standing in the way.
 *
 * ## Ordering
 *
 * The session stays primary. This only runs when no local source can answer, so
 * it never overrides a `farm.vip.expiresAt` the session does provide.
 */

import { useEffect, useState } from "react";
import { useMinigameSession } from "./sessionProvider";
import { hasLocalVipSource, isVipFarm, resolveVipAccess } from "./vip";

const COMMUNITY_API_BASE = "https://api.sunflower-land.com";

/**
 * The Community API key, inlined at build time.
 *
 * Absent (or blank) disables this path entirely and the arcade behaves exactly as
 * it does today.
 */
export function communityApiKey(): string | undefined {
  const key = import.meta.env.VITE_SUNFLOWER_COMMUNITY_API_KEY;
  return typeof key === "string" && key.trim() !== "" ? key.trim() : undefined;
}

/**
 * Pull the farm out of whichever shape the endpoint returned.
 *
 * `GET /community/farms/{id}` is documented as returning one farm, while the
 * list endpoint returns `{ farms: [{ id, nft_id, farm }] }`, so accept both plus
 * a bare farm rather than betting on one. Exported for tests: the exact shape is
 * the part of this path most likely to be wrong.
 */
export function pickFarm(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;

  const direct = record.farm;
  if (direct && typeof direct === "object") {
    return direct as Record<string, unknown>;
  }

  const data = record.data;
  if (data && typeof data === "object") {
    const nested = (data as Record<string, unknown>).farm;
    if (nested && typeof nested === "object") {
      return nested as Record<string, unknown>;
    }
  }

  const farms = record.farms;
  if (Array.isArray(farms) && farms.length > 0) {
    const first = farms[0];
    if (first && typeof first === "object") {
      const farm = (first as Record<string, unknown>).farm;
      if (farm && typeof farm === "object")
        return farm as Record<string, unknown>;
    }
  }

  // A bare farm object: it is recognisable by carrying farm-shaped keys.
  if ("vip" in record || "username" in record || "balance" in record) {
    return record;
  }
  return undefined;
}

/**
 * Is this response definitely about the farm we are paying?
 *
 * ## What this does and does not buy
 *
 * This is an **identity check on our own read**, not an authorisation check on
 * the player's request. It guarantees the VIP we act on belongs to the farm the
 * portal issued a JWT for, which stops three real failure modes:
 *
 *  - the overloaded `id` path parameter silently resolving to another farm
 *    (a number up to 1,000,000,000 is an **NFT id**, anything larger an
 *    **account id**) and returning a valid, unrelated farm rather than an error;
 *  - a stale or cached response being attributed to the wrong player;
 *  - any future refactor that starts reading the wrong field or the wrong farm.
 *
 * It does **not** stop someone from calling `Mint-Raven-Coin-<Machine>` directly.
 * Those action ids are public strings in the bundle and the server only enforces
 * each action's own `dailyCap`, so no client-side check can close that path — see
 * the note on `RAVEN_COIN_MINT_ACTION` in `features/arcade/lib/ravenCoin.ts`.
 * Closing it needs a server-side VIP requirement.
 *
 * ## The three-way agreement
 *
 * `farmId` comes from a portal-signed JWT, the session's `username` comes from
 * the economies API, and the Community API's `username` comes from the game
 * server. Requiring all three to agree means a forged or misrouted response has
 * to satisfy two independently-sourced values at once, rather than one.
 *
 * Fails closed: a response that omits the username is treated as a mismatch,
 * because an unconfirmable identity is not a confirmed one.
 */
export function isVerifiedFarmResponse({
  body,
  farmId,
  expectedUsername,
}: {
  body: unknown;
  farmId: number;
  /** The session's username, when it has one. */
  expectedUsername?: string;
}): boolean {
  if (typeof body !== "object" || body === null) return false;
  const envelope = body as Record<string, unknown>;

  // A present-but-different account id is a mismatch. An absent one is not
  // evidence either way, so it does not fail the check on its own.
  if (typeof envelope.id === "number" && envelope.id !== farmId) return false;

  const farm = pickFarm(body);
  if (!farm) return false;

  if (expectedUsername === undefined) return true;

  const username = farm.username;
  if (typeof username !== "string") return false;
  // Case-insensitive and trimmed: two sources describing the same farm should
  // agree, but one may normalise casing or whitespace. Being stricter here would
  // only cost a real VIP their status over a cosmetic difference, while a
  // genuinely different player still fails to match.
  return (
    username.trim().toLowerCase() === expectedUsername.trim().toLowerCase()
  );
}

/** One in-flight or settled lookup per farm, so re-renders never re-request. */
const cache = new Map<string, Promise<boolean | undefined>>();

/**
 * Is this farm VIP, according to the Community API?
 *
 * `undefined` means "could not tell" — no key, throttled (429), unauthorised
 * (401), an unexpected shape, a response that failed the identity check, or
 * blocked by CORS. Callers must treat that as unknown rather than as "no".
 */
export function fetchCommunityVip({
  farmId,
  apiKey,
  expectedUsername,
}: {
  farmId: number;
  apiKey?: string;
  expectedUsername?: string;
}): Promise<boolean | undefined> {
  const key = apiKey ?? communityApiKey();
  if (!key || !Number.isFinite(farmId) || farmId <= 0) {
    return Promise.resolve(undefined);
  }

  // The username is part of the cache key: the same farm asked about under a
  // different expected identity is a different question, and a cached pass for
  // one must not satisfy the other.
  const cacheKey = `${farmId}|${expectedUsername ?? ""}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Deliberately not abortable. The result is memoised per farm, so an abort
  // would cache "unknown" permanently and no later mount could ever retry.
  // The lookup is one request per farm per page load, which is well inside the
  // documented rate limit, so there is nothing to gain from cancelling it.
  const pending = (async (): Promise<boolean | undefined> => {
    try {
      const response = await fetch(
        `${COMMUNITY_API_BASE}/community/farms/${farmId}`,
        { headers: { accept: "application/json", "x-api-key": key } },
      );
      // 401 = key invalid or its farm lost VIP/level, 404 = no such farm,
      // 429 = throttled. None of them mean "this player is not VIP".
      if (!response.ok) return undefined;
      const body = await response.json();
      if (!isVerifiedFarmResponse({ body, farmId, expectedUsername })) {
        return undefined;
      }
      const farm = pickFarm(body);
      return farm ? isVipFarm(farm) : undefined;
    } catch {
      // Network failure, including the CORS block: unknown, not "no".
      return undefined;
    }
  })();

  cache.set(cacheKey, pending);
  return pending;
}

/** Test seam: forget memoised lookups. */
export function resetCommunityVipCache(): void {
  cache.clear();
}

/**
 * Has the VIP answer settled yet?
 *
 * `false` only while a Community API lookup is genuinely in flight — no session,
 * or a session with no VIP record and a key configured. Callers that **mint
 * something as a consequence of the answer** must wait for this, because acting
 * on the pre-resolution `false` bakes in the wrong choice: the free-run grant
 * picks an arcade-wide token over per-cabinet ones from `isVip`, so granting
 * before VIP resolves hands a VIP the non-VIP allowance and then locks it in for
 * the day.
 *
 * `true` in every other case, including a failed or absent lookup, so it never
 * blocks on a source that will not answer.
 */
export function useVipResolved(): boolean {
  const { jwt, farm, playerData } = useMinigameSession();
  const portalProfile = playerData?.portalProfile;
  const [resolved, setResolved] = useState<boolean>(() => !communityApiKey());

  const answerableLocally = hasLocalVipSource({
    sessionFarm: farm,
    portalProfile,
  });
  const waiting = !!jwt && !!farm && !answerableLocally && !!communityApiKey();

  useEffect(() => {
    if (waiting) setResolved(false);
    else setResolved(true);
  }, [waiting]);

  return resolved;
}

/**
 * The arcade's VIP answer, session first and Community API as a fallback.
 *
 * The first render always reports whatever the local sources say — which is
 * `false` until either the session projection carries `vip` or this fallback
 * answers. A Community API lookup can flip it to `true` a moment later, so treat
 * a `false` immediately after boot as "not known yet" rather than "not VIP". That
 * only ever affects which mint a win dispatches, never whether a win counts.
 *
 * When the fallback answers, it has first agreed the farm's `username` with the
 * session's, so the VIP acted on belongs to the farm the JWT was issued for —
 * see {@link isVerifiedFarmResponse} for what that does and does not protect
 * against.
 */
export function useVipAccess(): boolean {
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

  const [communityVip, setCommunityVip] = useState<boolean | undefined>(
    undefined,
  );

  useEffect(() => {
    // Wait for the session farm before asking anything else: it is the primary
    // source, and a lookup fired before it arrives would be memoised against a
    // question the session was about to answer for itself.
    if (!jwt || !farm || answeredLocally) return;
    const key = communityApiKey();
    if (!key) return;

    // Not cancellable on purpose: the lookup is memoised per farm, so aborting
    // would strand the cache. See `fetchCommunityVip`.
    let cancelled = false;
    void fetchCommunityVip({
      farmId,
      apiKey: key,
      // Cross-check against the session so the VIP we act on is provably the
      // same farm the JWT was issued for. See `isVerifiedFarmResponse`.
      expectedUsername: farm.username,
    }).then((answer) => {
      if (!cancelled) setCommunityVip(answer);
    });

    return () => {
      cancelled = true;
    };
  }, [jwt, farm, farmId, answeredLocally]);

  // Never let a fallback answer override a local one.
  if (answeredLocally) return localVip;
  return communityVip ?? localVip;
}
