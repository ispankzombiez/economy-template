/**
 * Who may use the arcade's developer tools (the Play Ticket mint).
 *
 * ## The recorded developer identity
 *
 * Read off the live portal JWT and session on 2026-09-27, and recorded here so
 * the gate is reproducible rather than guessed:
 *
 * | What | Value | Where it comes from |
 * | --- | --- | --- |
 * | Farm id | `1128976301583508` | JWT claim `farmId` (a **number**) |
 * | Username | `iSPANK` | session `farm.username` |
 * | Auth address | `google:115172530787410313653` | JWT claim `address` |
 *
 * Note the JWT's `address` is the Google auth subject, **not** the SFL farm id,
 * so `farmId` is the identifier the arcade gates on.
 *
 * ## Where each value is read from
 *
 * The **JWT does not carry a username.** Decoding a real portal token gives
 * only:
 *
 * ```json
 * { "address": "google:...", "userAccess": { "verified": true },
 *   "farmId": 1128976301583508, "portalId": "Nightshade-Arcade",
 *   "iat": 1790515315, "exp": 1793107315 }
 * ```
 *
 * So the two halves of the gate come from two different server-derived sources:
 *
 *  - `tokenClaims.farmId` — read straight out of the JWT the host page hands us,
 *    under that exact key. Deliberately *not* the loose `id`/`fid`/`farm_id`
 *    candidate list that `decodePortalToken` and `resolvedProfile.farmId` use
 *    for display: a gate wants one unambiguous claim, not the first plausible
 *    id-shaped field in some payload.
 *  - `playerData.resolvedProfile.username` — from `farm.username` in
 *    `GET /data?type=session`, which the economies API projects from the SFL
 *    farm. Server-derived, so it is not something the player typed.
 *
 * Both must match. A matching name with a different farm id is a different
 * player who happens to share the handle; a matching farm id with a different
 * name is a renamed account.
 *
 * ## The honest limitation — this is still a UI gate
 *
 * **Every published action is callable by every player** — the rule engine has
 * no per-account action scope, so `Dev-Mint-Play-Ticket` is callable whether or
 * not this gate passes. Nothing in the client can stop that.
 *
 * Requiring the farm id as well as the name does raise the bar, but be clear
 * about what it buys: a JWT payload is base64, not signed from the client's
 * point of view, so anyone can edit `farmId` in their own token and see the
 * panel. **This is obscurity, not authentication.** And because the id is
 * recorded in this file, it is a *published* value — anyone with the repo can
 * read it and put it in their own token. Treat it as a guard against
 * accidentally showing developer tools to ordinary players, and nothing more.
 *
 * The arcade owner has decided to keep the mint uncapped so the dev account can
 * mint as many Play Tickets as it needs, so **delete the action from the economy
 * before launch** — that is the only step that actually protects the ticket
 * economy.
 */

/**
 * Farm id of the arcade developer, from the portal JWT's `farmId` claim.
 *
 * Recorded from a live token. A number, not a string.
 */
const ARCADE_DEVELOPER_FARM_ID = 1128976301583508;

/**
 * Username of the arcade developer, from the session's `farm.username`.
 *
 * Stored lower-cased: SFL displays whatever case the player chose, and the live
 * account reads `iSPANK`.
 */
const ARCADE_DEVELOPER_USERNAME = "ispank";

/**
 * Is this the arcade developer's farm id?
 *
 * Accepts a numeric string as well as a number, so a future serialiser that
 * quotes the claim cannot silently lock the developer out of their own tools.
 * Anything that is not exactly the recorded id is rejected — including a
 * missing claim, a non-finite number, and `0`.
 */
export function isArcadeDeveloperFarmId(value: unknown): boolean {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;

  return Number.isFinite(parsed) && parsed === ARCADE_DEVELOPER_FARM_ID;
}

/**
 * Is this the arcade developer's username?
 *
 * Matching is case-insensitive and whitespace-trimmed because SFL usernames are
 * displayed with whatever case the player chose.
 */
export function isArcadeDeveloperName(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return normalized === ARCADE_DEVELOPER_USERNAME;
}

/**
 * The arcade's dev-tools answer for a booted session: **name AND farm id**.
 *
 * @param username `playerData.resolvedProfile.username` — the server-derived
 *                 farm name. `undefined` without a session, which resolves to
 *                 "not the developer" so a local boot never renders a mint form.
 * @param farmId   `playerData.tokenClaims.farmId` — read from the JWT the host
 *                 page provided.
 */
export function resolveDevAccess({
  username,
  farmId,
}: {
  username: unknown;
  farmId: unknown;
}): boolean {
  return isArcadeDeveloperName(username) && isArcadeDeveloperFarmId(farmId);
}

/** The recorded identity, for diagnostics and tests. */
export const ARCADE_DEVELOPER = {
  farmId: ARCADE_DEVELOPER_FARM_ID,
  username: ARCADE_DEVELOPER_USERNAME,
} as const;
