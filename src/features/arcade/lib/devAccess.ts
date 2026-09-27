/**
 * Who may use the arcade's developer tools (the Play Ticket mint).
 *
 * ## The gate is a server-enforced item, not a client check
 *
 * The mint is carried out by the economies API when it accepts
 * `POST /action` — our app only asks. So anything decided in the browser is a
 * suggestion the caller can ignore, and that is exactly what the earlier
 * name/farm-id check was: a JWT payload is base64, not signed from the client's
 * point of view, so anyone could edit `farmId` in their own token and see the
 * panel.
 *
 * The gate is now a **Dev Key in the player's balances**, enforced by the rule
 * engine's `require`:
 *
 * ```json
 * "Dev-Mint-Play-Ticket": {
 *   "type": "custom",
 *   "showInShop": false,
 *   "require": { "4": { "amount": 1 } },
 *   "mint": { "2": { "min": 1, "max": 10000 } }
 * }
 * ```
 *
 * `require` is evaluated server-side against the caller's own balances, so a
 * player without a key is refused before any mint happens — they cannot mint
 * their way to a key, because the key is not mintable.
 *
 * ## How the key was made unobtainable
 *
 * The arcade owner can add an item to the portal and then remove the rule that
 * mints it. That sequence is what makes this safe, and the order matters:
 *
 *  1. publish the `Dev Key` item and a one-off `Grant-Dev-Key` mint;
 *  2. claim the key once, so the owner holds exactly one;
 *  3. **in the same save**, add `require` to `Dev-Mint-Play-Ticket` *and* delete
 *     `Grant-Dev-Key`.
 *
 * Steps 2 and 3 are deliberately adjacent. Between them the key is worth
 * nothing, because no rule requires it yet — so the window in which a key could
 * be grabbed by anyone else closes at the same instant the key starts to
 * matter. Verified: `Grant-Dev-Key` now answers
 * `400 Unknown action "Grant-Dev-Key"`, so the key can never be minted again.
 *
 * The key is `tradeable: false`, and the mint does not burn it, so the owner
 * keeps it indefinitely and mints as often as they like.
 *
 * ## The recorded owner
 *
 * Read off the live portal JWT and session, for diagnosis ("is this the dev
 * account?") rather than for access control:
 *
 * | What | Value | Where it comes from |
 * | --- | --- | --- |
 * | Farm id | `1128976301583508` | JWT claim `farmId` (a **number**) |
 * | Username | `iSPANK` | session `farm.username` |
 * | Auth address | `google:115172530787410313653` | JWT claim `address` |
 *
 * Note the JWT's `address` is the Google auth subject, **not** the SFL farm id,
 * so `farmId` is the player identifier. The JWT carries no username at all, so
 * the name has to come from the session.
 */

import type { MinigameSessionEconomyMeta } from "lib/portal/types";

type EconomyItems = Record<string, { name?: string } | undefined>;

/**
 * Name pattern of the developer key item.
 *
 * Resolved by name rather than hard-coded, because a hosted economy keys items
 * numerically (`"0"`, `"1"`, …) and those keys are the editor's to assign.
 */
export const DEV_KEY_ITEM_NAME = /^dev[\s_-]*keys?$/i;

/**
 * Fallback token key for the Dev Key on the live Nightshade-Arcade economy.
 *
 * Only reached when the session carries no item metadata — in which case a dev
 * who already holds the key is the one case where guessing helps.
 */
const DEV_KEY_TOKEN_KEY = "4";

/** The `playerEconomy.balances` key of the Dev Key, if it can be resolved. */
export function resolveDevKeyTokenKey({
  economyMeta,
  items,
  balances,
}: {
  economyMeta?: Pick<MinigameSessionEconomyMeta, "items">;
  items?: EconomyItems;
  balances?: Record<string, number>;
} = {}): string | undefined {
  const merged: EconomyItems = { ...items, ...economyMeta?.items };
  for (const [key, item] of Object.entries(merged)) {
    const name = item?.name;
    if (typeof name === "string" && DEV_KEY_ITEM_NAME.test(name.trim())) {
      return key;
    }
  }

  // A key already sitting in a balance identifies itself.
  if (balances) {
    for (const key of Object.keys(balances)) {
      if (DEV_KEY_ITEM_NAME.test(key)) return key;
    }
  }

  return DEV_KEY_TOKEN_KEY;
}

/** Does the player hold at least one Dev Key? */
export function hasDevKey({
  balances,
  tokenKey,
}: {
  balances?: Record<string, number>;
  tokenKey: string | undefined;
}): boolean {
  if (!tokenKey) return false;
  const held = balances?.[tokenKey];
  return typeof held === "number" && Number.isFinite(held) && held >= 1;
}

/**
 * The arcade's dev-tools answer for a booted session.
 *
 * True only for a player the server has accepted a `require` for, i.e. one
 * holding a Dev Key. Safe to render on, and the one signal in the client that
 * mirrors a server-enforced rule rather than merely guessing at the player.
 */
export function resolveDevAccess({
  economyMeta,
  items,
  balances,
}: {
  economyMeta?: Pick<MinigameSessionEconomyMeta, "items">;
  items?: EconomyItems;
  balances?: Record<string, number>;
}): boolean {
  return hasDevKey({
    balances,
    tokenKey: resolveDevKeyTokenKey({ economyMeta, items, balances }),
  });
}

/**
 * The recorded owner, for diagnostics only — this is not what grants access.
 *
 * See the note at the top of this file: the access decision is the Dev Key.
 */
export const ARCADE_DEVELOPER = {
  farmId: 1128976301583508,
  username: "iSPANK",
} as const;
