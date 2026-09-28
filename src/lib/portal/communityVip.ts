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
 * Is this response about the farm we asked for?
 *
 * The `id` path parameter is overloaded: a number up to 1,000,000,000 resolves as
 * an **NFT id** and anything larger as an **account id**. A session `farmId` is an
 * account id, so the right branch is taken in practice — but if that ever changed,
 * the API would answer with a valid, entirely unrelated farm rather than an
 * error. Since this value gates coin rewards, a mismatched `id` is treated as
 * "unknown" instead of being read as another player's VIP.
 *
 * The check is skipped when the envelope omits `id`, since absence is not
 * evidence of a mismatch.
 */
function isResponseFor(body: unknown, farmId: number): boolean {
  if (typeof body !== "object" || body === null) return false;
  const id = (body as Record<string, unknown>).id;
  if (typeof id !== "number") return true;
  return id === farmId;
}

/** One in-flight or settled lookup per farm, so re-renders never re-request. */
const cache = new Map<number, Promise<boolean | undefined>>();

/**
 * Is this farm VIP, according to the Community API?
 *
 * `undefined` means "could not tell" — no key, throttled (429), unauthorised
 * (401), an unexpected shape, or blocked by CORS. Callers must treat that as
 * unknown rather than as "no".
 */
export function fetchCommunityVip({
  farmId,
  apiKey,
}: {
  farmId: number;
  apiKey?: string;
}): Promise<boolean | undefined> {
  const key = apiKey ?? communityApiKey();
  if (!key || !Number.isFinite(farmId) || farmId <= 0) {
    return Promise.resolve(undefined);
  }

  const cached = cache.get(farmId);
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
      if (!isResponseFor(body, farmId)) return undefined;
      const farm = pickFarm(body);
      return farm ? isVipFarm(farm) : undefined;
    } catch {
      // Network failure, including the CORS block: unknown, not "no".
      return undefined;
    }
  })();

  cache.set(farmId, pending);
  return pending;
}

/** Test seam: forget memoised lookups. */
export function resetCommunityVipCache(): void {
  cache.clear();
}

/**
 * The arcade's VIP answer, session first and Community API as a fallback.
 *
 * The first render always reports whatever the local sources say — which is
 * `false` until either the session projection carries `vip` or this fallback
 * answers. A Community API lookup can flip it to `true` a moment later, so treat
 * a `false` immediately after boot as "not known yet" rather than "not VIP". That
 * only ever affects which mint a win dispatches, never whether a win counts.
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
    void fetchCommunityVip({ farmId, apiKey: key }).then((answer) => {
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
