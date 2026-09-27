/**
 * Who may use the arcade's developer tools (the Play Ticket mint).
 *
 * ## Where the name comes from
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
 * The name is in the **session** instead: `GET /data?type=session` projects the
 * SFL farm down to `{ balance, bumpkin, username, faction }`, and
 * `playerData.resolvedProfile.username` is resolved from that chain
 * (`sessionFarm.username` above the JWT-derived fallbacks). That matters
 * because the session is server-derived from SFL game info, so the name in the
 * UI is not something the player typed.
 *
 * ## The honest limitation
 *
 * **This gate is cosmetic.** The published action it guards
 * (`Dev-Mint-Play-Ticket`) is readable and callable by every player, because
 * every `actions` entry in the economy is — there is no per-account action
 * scope in the rule engine. A modified client simply dispatches the action
 * without rendering the modal, and no client-side check can stop that.
 *
 * The arcade owner has decided to keep that mint **uncapped** so the dev
 * account can mint as many Play Tickets as it needs. The accepted consequence
 * is that the ticket economy is not protected while the action is published, so
 * **delete it from the economy before launch.**
 */

/** Sunflower Land usernames allowed to open the dev tools. */
const ARCADE_DEVELOPER_NAMES = ["ispank"] as const;

/**
 * Is this the arcade developer's account?
 *
 * Matching is case-insensitive and whitespace-trimmed because SFL usernames are
 * displayed with whatever case the player chose — the live account is `iSPANK`.
 */
export function isArcadeDeveloperName(name: unknown): boolean {
  if (typeof name !== "string") return false;
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  return ARCADE_DEVELOPER_NAMES.some((dev) => dev === normalized);
}

/**
 * The arcade's dev-tools answer for a booted session.
 *
 * @param username `playerData.resolvedProfile.username` — the server-derived
 *                 farm name. `undefined` when there is no session, which
 *                 resolves to "not the developer" so a local boot never renders
 *                 a mint button.
 */
export function resolveDevAccess(username: unknown): boolean {
  return isArcadeDeveloperName(username);
}
