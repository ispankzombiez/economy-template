import type {
  MinigameSessionEconomyMeta,
  MinigameSessionResponse,
} from "lib/portal/types";

/**
 * Raven Coin wiring for the arcade.
 *
 * ## Why this file exists
 *
 * The live economy keys the arcade currency as **`"0"`** (`mainCurrencyToken`),
 * not `"RavenCoin"` — the two sides of the arcade never agreed on a name:
 *
 *   - **Live** (`GET /data?type=session`): `items["0"].name = "Raven Coin"`,
 *     `mainCurrencyToken: "0"`, mint action id `Mint-Raven-Coin`.
 *   - **Offline sample** (`nightshade-arcade-editor-sample.json`): token key
 *     `RavenCoin`, no `mainCurrencyToken`.
 *
 * Anything that reads `playerEconomy.balances.RavenCoin` therefore sees
 * `undefined` on a hosted build even after a perfectly successful mint. Every
 * balance lookup and every mint must go through the resolvers below so both
 * configurations work unchanged.
 */

/**
 * The economy action that credits one Raven Coin.
 *
 * Published in the editor as `{ type: "custom", showInShop: false, mint: { <coin>: { amount: 1 } } }`
 * — `showInShop` keeps it out of the shop list, and the fixed amount matches
 * every game's `*_RAVEN_COIN_REWARD` (all ten are `1`).
 *
 * The id is looked up rather than hard-coded so a fork that renames the action
 * in the editor does not need a code change: {@link resolveRavenCoinMintAction}
 * falls back to any unpublished `custom` action that mints the coin.
 *
 * This one carries `dailyCap: 1`, so it is the **free** daily reward run: the
 * server refuses a second mint on it for the day (verified live —
 * `400 Daily cap exceeded for 0 on action Mint-Raven-Coin`).
 *
 * ## The per-cabinet actions are not gated on VIP — a known, accepted trade-off
 *
 * A non-VIP player is meant to get one free run a day from *this* action, while a
 * VIP player gets one per cabinet from the ten `Mint-Raven-Coin-<Machine>`
 * actions. Each of those also carries `dailyCap: 1`, so the server's view is just
 * "eleven actions, one coin each per day" — **it has no notion of VIP at all.**
 *
 * Every one of those ids is a plain string in the public bundle, so anyone can
 * post `Mint-Raven-Coin-Poker` directly and be credited a coin without ever
 * holding a VIP flag. The realistic ceiling is therefore **ten free coins a day
 * instead of one**, for someone willing to call the endpoint with a public
 * string. This is a property of splitting the allowance across actions, not of
 * how VIP is detected: it is equally true whether VIP is read from the session,
 * from the Community API, or not at all.
 *
 * **Nothing client-side can close it.** The arcade is a static bundle, so the
 * player owns the runtime and any check they can read is a check they can skip —
 * including the farm-identity cross-check in `lib/portal/communityVip.ts`, which
 * only guarantees *our* read is of the right farm. Closing the gap needs a
 * server-side VIP requirement on the per-cabinet mints, the same way
 * `require` on a Dev Key item is enforced — see {@link DEV_PLAY_TICKET_MINT_ACTION}
 * for the other accepted exposure of the same kind.
 *
 * The owner's decision is to keep the per-cabinet mints and harden what can be
 * hardened, accepting the rest.
 */
export const RAVEN_COIN_MINT_ACTION = "Mint-Raven-Coin";

/**
 * Opens a **Play-Ticket-funded** reward run.
 *
 * Published as an *atomic* swap - one request burns the ticket and mints the
 * voucher, so the two can never drift apart:
 *
 * ```json
 * { "type": "custom", "showInShop": false,
 *   "burn": { <playTicket>: { "amount": 1 } },
 *   "mint": { <rewardAttempt>: { "amount": 1 } } }
 * ```
 *
 * ## Why this is one action and not two
 *
 * The first cut burned the ticket on one action and minted the coin on
 * another. The server cannot see that ordering, so anyone could call the
 * payout on its own - verified live: the ticket-funded mint returned 200 and
 * credited a Raven Coin with **zero** tickets burned, repeatable forever.
 *
 * Splitting the pair through a voucher closes it. A coin can now only be
 * minted by destroying a voucher, and a voucher can only be obtained by
 * destroying a Play Ticket, so the whole chain is checked server-side. The
 * free allowance (a `dailyCap` on the other mints) is then the only coin a
 * cheater can reach without paying for it.
 */
export const TICKET_RUN_START_ACTION = "Start-Ticket-Run";

/**
 * Pays out a **Play-Ticket-funded** reward run.
 *
 * The mirror image of {@link TICKET_RUN_START_ACTION}: burns the voucher the
 * run was opened with and mints the Raven Coin, atomically.
 *
 * ```json
 * { "type": "custom", "showInShop": false,
 *   "burn": { <rewardAttempt>: { "amount": 1 } },
 *   "mint": { <coin>: { "amount": 1 } } }
 * ```
 *
 * Deliberately **uncapped**: rule 3 is "one Play Ticket buys one attempt, for
 * as long as the player keeps buying tickets with FLOWER", so the ceiling is
 * the player's wallet rather than a daily limit. The cost is enforced by the
 * burn.
 */
export const REWARD_ATTEMPT_CLAIM_ACTION = "Claim-Raven-Coin";

/** Name pattern of the voucher item a paid run is opened with. */
export const REWARD_ATTEMPT_ITEM_NAME = /^reward[\s_-]*attempts?$/i;

/**
 * Burns a voucher without paying out - a run that was lost, abandoned or
 * interrupted.
 *
 * A voucher is only meant to exist while the player is actually mid-run, so it
 * is voided when the cabinet closes, and any straggler is swept on the next
 * boot. Nothing is minted, so this can only ever destroy the player's own claim
 * - there is no way to turn a void into currency.
 *
 * The burn is **ranged** so a whole leftover stack goes in one request (a
 * `custom` action keeps its range through publishing, unlike a shop rule).
 */
export const REWARD_ATTEMPT_VOID_ACTION = "Void-Reward-Attempt";

/** How many vouchers the player is holding right now. */
export function countRewardAttempts({
  playerEconomy,
  tokenKey,
}: {
  playerEconomy?: Pick<
    MinigameSessionResponse["playerEconomy"],
    "balances"
  > | null;
  tokenKey: string | undefined;
}): number {
  if (!tokenKey) return 0;
  const value = playerEconomy?.balances?.[tokenKey];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

/** Prefix shared by every per-cabinet payout action. */
export const RAVEN_COIN_MACHINE_MINT_PREFIX = "Mint-Raven-Coin-";

/**
 * The per-cabinet action id for a registry id: `pac-man` →
 * `Mint-Raven-Coin-PacMan`, `barley-breaker` → `Mint-Raven-Coin-BarleyBreaker`.
 *
 * ## Why each cabinet needs its own action
 *
 * VIP get one free run *per machine* per day, and that has to survive a refresh.
 * The only persisted daily counter the API exposes is
 * `playerEconomy.dailyMinted`, keyed `<actionId>|<coinKey>` — so the cabinet has
 * to be part of the **action id**, and every cabinet publishes its own mint with
 * `dailyCap: 1`:
 *
 * | cabinet           | action                            |
 * | ----------------- | --------------------------------- |
 * | `poker`           | `Mint-Raven-Coin-Poker`           |
 * | `blackjack`       | `Mint-Raven-Coin-Blackjack`       |
 * | `gofish`          | `Mint-Raven-Coin-Gofish`          |
 * | `uno`             | `Mint-Raven-Coin-Uno`             |
 * | `solitaire`       | `Mint-Raven-Coin-Solitaire`       |
 * | `goblin-invaders` | `Mint-Raven-Coin-GoblinInvaders`  |
 * | `tetris`          | `Mint-Raven-Coin-Tetris`          |
 * | `barley-breaker`  | `Mint-Raven-Coin-BarleyBreaker`   |
 * | `pac-man`         | `Mint-Raven-Coin-PacMan`          |
 * | `frogger`         | `Mint-Raven-Coin-Frogger`         |
 *
 * **Adding a cabinet:** register it in `GAME_REGISTRY` and publish the matching
 * action in the economy editor. The id is derived from the registry id, so there
 * is no second list to keep in sync in code — and a missing action degrades to
 * the arcade-wide free action instead of blocking the payout.
 */
export function machineMintActionId(machine: string): string {
  const suffix = String(machine)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  return `${RAVEN_COIN_MACHINE_MINT_PREFIX}${suffix}`;
}

/** Prefix shared by every per-cabinet *free run open* action. */
export const FREE_RUN_START_ACTION_PREFIX = "Start-Free-Run-";

/** Prefix shared by every per-cabinet free-run **token grant** action. */
export const FREE_RUN_GRANT_ACTION_PREFIX = "Grant-Free-Run-";

/**
 * ## The free allowance is a token that gets burned, not a number in a ledger
 *
 * Two earlier attempts both read the free allowance out of
 * `playerEconomy.dailyMinted`, and both were fragile: the ledger is keyed
 * `<actionId>|<tokenKey>`, it has to survive a merge with the action response,
 * and it only ever records *mints*. Reading a mint ledger to answer "has this
 * player used today's free run yet?" is asking it a question it cannot answer
 * about a run that was lost.
 *
 * So the entitlement is now an actual **balance**: one `Free Run Token` per
 * cabinet, minted on first visit and burned when a free run starts.
 *
 * | step                | action                        | effect                              |
 * | ------------------- | ----------------------------- | ----------------------------------- |
 * | first visit to a cab | `Grant-Free-Run-<Cabinet>`    | mints 1 token, `cooldownSeconds: 86400` |
 * | free run starts     | `Start-Free-Run-<Cabinet>`    | **burns 1 token**, mints 1 voucher   |
 * | ticket run starts   | `Start-Ticket-Run`            | burns 1 Play Ticket, mints a voucher |
 * | win                 | `Claim-Raven-Coin`            | burns the voucher, mints the coin   |
 * | loss / exit / close | `Void-Reward-Attempt`         | burns the voucher                   |
 *
 * The burn is the whole enforcement. Once a cabinet's token is gone it cannot be
 * re-minted today — the grant's cooldown refuses — so **absence is the signal
 * that the free run is spent**, and the outcome of the run never enters into it.
 * A lost or abandoned run cannot refund the attempt, because the token was
 * already destroyed before the first card was dealt.
 *
 * The gate is therefore `balances[tokenKey] > 0`: a plain balance read from the
 * session, with no key format to get wrong and no ledger to merge.
 *
 * ## Why a cooldown and not `dailyCap`
 *
 * The grant originally carried `dailyCap: 1`, which does not work. `dailyCap` is
 * read from `playerEconomy.dailyMinted`, and on a live session that ledger can be
 * absent or empty — measured on the deployed build, mid-session:
 *
 * ```
 * balances:    { "0": 13, "2": 1520, "3": 1, "4": 1, "15": 1 }
 * dailyMinted: {}
 * ```
 *
 * With an empty ledger the engine computes `used = 0` for every capped mint, so
 * the cap never engages and a re-grant is allowed every time. `cooldownSeconds`
 * is tracked in `rules[actionId].ranAt` instead — a separate persisted field that,
 * unlike `dailyMinted`, is carried forward when an action response omits it — so
 * 24 hours of cooldown holds whether or not the mint ledger is populated.
 *
 * Grants are **lazy** — one request, on first visit to a cabinet, rather than ten
 * at boot. A refused grant is not an error; it just means the token was already
 * spent today.
 *
 * | cabinet           | token item                     | grant / open                    |
 * | ----------------- | ------------------------------ | ------------------------------- |
 * | `poker`           | `Free Run Token - Poker`        | `Grant-…` / `Start-…-Poker`     |
 * | `blackjack`       | `Free Run Token - Blackjack`    | … `Blackjack`                   |
 * | `gofish`          | `Free Run Token - Gofish`       | … `Gofish`                      |
 * | `uno`             | `Free Run Token - Uno`          | … `Uno`                         |
 * | `solitaire`       | `Free Run Token - Solitaire`    | … `Solitaire`                   |
 * | `goblin-invaders` | `Free Run Token - GoblinInvaders` | … `GoblinInvaders`            |
 * | `tetris`          | `Free Run Token - Tetris`       | … `Tetris`                      |
 * | `barley-breaker`  | `Free Run Token - BarleyBreaker` | … `BarleyBreaker`              |
 * | `pac-man`         | `Free Run Token - PacMan`       | … `PacMan`                      |
 * | `frogger`         | `Free Run Token - Frogger`      | … `Frogger`                     |
 * | *(non-VIP)*       | `Free Run Token - Arcade`       | … `Arcade`                      |
 *
 * **Adding a cabinet:** register it in `GAME_REGISTRY`, then publish the token
 * item plus its grant and open actions.
 */
export function freeRunStartActionId(machine: string): string {
  const suffix = String(machine)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  return `${FREE_RUN_START_ACTION_PREFIX}${suffix}`;
}

/** The grant action that mints a cabinet's free-run token. */
export function freeRunGrantActionId(machine: string): string {
  const suffix = String(machine)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

  return `${FREE_RUN_GRANT_ACTION_PREFIX}${suffix}`;
}

/** Cabinet suffix shared by the action ids and the token item names. */
function machineSuffix(machine: string): string {
  return String(machine)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/**
 * The item name carrying a cabinet's free-run token.
 *
 * The economy has no "hidden item" flag, so the name is deliberately plain: it
 * appears in no arcade surface (the HUD renders the coin and Play Tickets by
 * name, and every action sets `showInShop: false`), but the portal-side economy
 * dashboard may still list the item, so it should not read as a collectable.
 */
export function freeRunTokenItemName(machine?: string): string {
  return machine
    ? `Free Run Token - ${machineSuffix(machine)}`
    : "Free Run Token - Arcade";
}

/** Item names that are free-run tokens, for {@link resolveFreeRunTokenKey}. */
const FREE_RUN_TOKEN_NAME = /^free\s*run\s*tokens?\s*-\s*(.+)$/i;

/**
 * The arcade-wide free run a **non-VIP** player gets: one per day, any machine.
 *
 * Published as
 * `{ type: "custom", showInShop: false, burn: { <arcadeToken>: { amount: 1 } }, mint: { <voucher>: { amount: 1 } } }`.
 */
export const FREE_RUN_START_ARCADE_ACTION = "Start-Free-Run-Arcade";

/** The arcade-wide grant, for a non-VIP's single daily token. */
export const FREE_RUN_GRANT_ARCADE_ACTION = "Grant-Free-Run-Arcade";

/**
 * The action that **spends** a free reward run, or `null` if none is published.
 *
 * VIP are rationed per cabinet, so they get the per-cabinet action; a non-VIP is
 * rationed arcade-wide, so they get the shared one. `null` means this economy has
 * not adopted the tokens, and the caller falls back to the older "the payout
 * carries the cap" behaviour rather than blocking the player.
 */
export function resolveFreeRunStartAction({
  actions,
  isVip,
  machine,
}: {
  actions?: Record<string, unknown>;
  isVip: boolean;
  machine?: string;
}): string | null {
  const list = actions ?? {};
  if (isVip && machine) {
    const perMachine = freeRunStartActionId(machine);
    if (perMachine in list) return perMachine;
  }
  if (FREE_RUN_START_ARCADE_ACTION in list) return FREE_RUN_START_ARCADE_ACTION;
  return null;
}

/** The action that grants a free-run token, or `null` if none is published. */
export function resolveFreeRunGrantAction({
  actions,
  isVip,
  machine,
}: {
  actions?: Record<string, unknown>;
  isVip: boolean;
  machine?: string;
}): string | null {
  const list = actions ?? {};
  if (isVip && machine) {
    const perMachine = freeRunGrantActionId(machine);
    if (perMachine in list) return perMachine;
  }
  if (FREE_RUN_GRANT_ARCADE_ACTION in list) return FREE_RUN_GRANT_ARCADE_ACTION;
  return null;
}

/** True once this economy spends free attempts by burning a token. */
export function supportsFreeRunOpens(
  actions?: Record<string, unknown>,
): boolean {
  return resolveFreeRunStartAction({ actions, isVip: false }) !== null;
}

/** The `playerEconomy.balances` key holding a cabinet's free-run token. */
export function resolveFreeRunTokenKey({
  economyMeta,
  items,
  balances,
  isVip,
  machine,
}: {
  economyMeta?: Pick<MinigameSessionEconomyMeta, "items">;
  items?: EconomyItems;
  balances?: Record<string, number>;
  /** Required: a VIP's tokens are per cabinet, a non-VIP's is arcade-wide. */
  isVip: boolean;
  machine?: string;
}): string | undefined {
  const merged: EconomyItems = { ...items, ...economyMeta?.items };
  const wanted = isVip && machine ? machineSuffix(machine) : "arcade";

  for (const [key, item] of Object.entries(merged)) {
    const name = item?.name;
    if (typeof name !== "string") continue;
    const match = FREE_RUN_TOKEN_NAME.exec(name.trim());
    if (match && match[1].trim().toLowerCase() === wanted.toLowerCase()) {
      return key;
    }
  }

  // A balance under a token-shaped key still identifies itself.
  for (const key of Object.keys(balances ?? {})) {
    const match = FREE_RUN_TOKEN_NAME.exec(key.trim());
    if (match && match[1].trim().toLowerCase() === wanted.toLowerCase()) {
      return key;
    }
  }

  return undefined;
}

/** Free-run tokens this player is currently holding for a cabinet. */
export function getFreeRunTokenBalance({
  playerEconomy,
  tokenKey,
}: {
  playerEconomy?: Pick<
    MinigameSessionResponse["playerEconomy"],
    "balances"
  > | null;
  tokenKey: string | undefined;
}): number {
  if (!tokenKey) return 0;
  const value = playerEconomy?.balances?.[tokenKey];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

/**
 * Burns one Play Ticket to open a reward run past the free daily allowance.
 *
 * Published as `{ type: "custom", showInShop: false, burn: { <ticket>: { amount: 1 } } }`
 * — burn-only on purpose: it must never mint tickets (the editor's `purchases`
 * are what grant them).
 */
export const PLAY_TICKET_SPEND_ACTION = "Mint-Play-Ticket";

/**
 * The daily Play Ticket the entryway chests award: one per player per day.
 *
 * Published as a ranged mint with `dailyCap: 1`, so the *server* refuses the
 * second chest of the day. Both entryway chests dispatch this same action, which
 * is what makes the pair a single daily allowance rather than two.
 *
 * This is the free source of Play Tickets. FLOWER purchases remain published on
 * the host page purely as a top-up for a player who has already claimed today.
 */
export const PLAY_TICKET_DAILY_CLAIM_ACTION = "Claim-Play-Ticket";

/**
 * Developer-only Play Ticket mint, driven by the modal in the shop.
 *
 * **Uncapped by the owner's decision.** The arcade owner asked for the dev
 * account to be able to mint as many Play Tickets as they want or need, so this
 * is a ranged mint with no meaningful daily limit: type a number, get that many,
 * press it again for more. The per-call `max` is only a sanity bound on a single
 * request, not a budget.
 *
 * ## What this means, stated plainly
 *
 * **Every published action is callable by every player** — the rule engine has
 * no per-account action scope, so the username gate in `lib/devAccess.ts` only
 * decides who *sees the button*. A cheater can call this directly and every
 * ticket converts to a Raven Coin through the uncapped `Claim-Raven-Coin`, so
 * the ticket economy is **not** protected while this action is published. That
 * is a known, accepted trade-off rather than an oversight.
 *
 * The action should therefore be **deleted from the economy before launch**,
 * leaving the daily chest as the only source of Play Tickets.
 */
export const DEV_PLAY_TICKET_MINT_ACTION = "Dev-Mint-Play-Ticket";

/** The mint rule a published action declares for one token, if any. */
function mintRule(
  action: unknown,
  tokenKey: string,
): Record<string, unknown> | undefined {
  if (!isRecord(action) || !isRecord(action.mint)) return undefined;
  const rule = action.mint[tokenKey];
  return isRecord(rule) ? rule : undefined;
}

/** The bounds a published ranged mint declares for one token. */
export type ActionMintLimits = {
  /** Smallest amount one call may move. */
  min: number;
  /** Largest amount one call may move. */
  max: number;
  /** The day's total, when the rule declares one. */
  dailyCap?: number;
};

/**
 * The `min` / `max` / `dailyCap` a published action declares for one token.
 *
 * Kept as three numbers rather than one "cap" because they answer different
 * questions: `max` bounds a single request, `dailyCap` bounds the day. A ranged
 * mint with no `dailyCap` is effectively unlimited across the day.
 *
 * Returns `undefined` when the action is not published or mints nothing for that
 * token.
 */
export function resolveActionMintLimits({
  actions,
  actionId,
  tokenKey,
}: {
  actions?: Record<string, unknown>;
  actionId: string;
  tokenKey: string;
}): ActionMintLimits | undefined {
  const rule = mintRule(actions?.[actionId], tokenKey);
  if (!isRecord(rule)) return undefined;

  const min = typeof rule.min === "number" && rule.min > 0 ? rule.min : 1;
  const max =
    typeof rule.max === "number" && rule.max >= min ? rule.max : Number.NaN;
  const dailyCap =
    typeof rule.dailyCap === "number" && rule.dailyCap >= 0
      ? rule.dailyCap
      : undefined;

  return { min, max, dailyCap };
}

/** Fallback key used when no session metadata is available (offline sample). */
const RAVEN_COIN_TOKEN_KEY = "RavenCoin";

/** Fallback Play Ticket key used when no session metadata is available. */
const PLAY_TICKET_TOKEN_KEY = "PlayTicket";

type AnyAction = Record<string, unknown>;

/** `items` as returned by the session / offline meta (`{ name, id, ... }`). */
type EconomyItems = Record<string, { name?: string; id?: number } | undefined>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The `playerEconomy.balances` key the arcade currency lives under.
 *
 * Priority:
 *  1. `mainCurrencyToken` from the session — authoritative on hosted builds.
 *  2. The item whose `name` reads as "Raven Coin" / "RavenCoin".
 *  3. `"RavenCoin"` — the offline sample's key.
 *
 * Returns a key even when the player owns none, because callers need to *write*
 * to it as well as read from it.
 */
export function resolveRavenCoinTokenKey({
  economyMeta,
  items,
  balances,
}: {
  economyMeta?: Pick<MinigameSessionEconomyMeta, "mainCurrencyToken" | "items">;
  items?: EconomyItems;
  balances?: Record<string, number>;
} = {}): string {
  const metaToken = economyMeta?.mainCurrencyToken;
  if (metaToken && typeof metaToken === "string") return metaToken;

  const merged: EconomyItems = { ...items, ...economyMeta?.items };
  for (const [key, item] of Object.entries(merged)) {
    const name = item?.name;
    if (typeof name !== "string") continue;
    if (/^raven[\s_-]*coins?$/i.test(name.trim())) return key;
  }

  // A balance under an unknown key still counts: a mint we did not author the
  // name for is still this player's coin.
  if (balances) {
    if (typeof balances[RAVEN_COIN_TOKEN_KEY] === "number") {
      return RAVEN_COIN_TOKEN_KEY;
    }
  }

  return RAVEN_COIN_TOKEN_KEY;
}

/** Coin key implied by a mint rule, without needing the session metadata. */
function mintRuleCoinKey(rule: unknown): string | undefined {
  if (!isRecord(rule)) return undefined;
  const keys = Object.keys(rule);
  return keys.length === 1 ? keys[0] : undefined;
}

/**
 * The action id to dispatch when a cabinet pays out.
 *
 * `variant` picks which of the published mints to use:
 *
 *  - `"free"` (default) — the **arcade-wide** free action (`dailyCap: 1`):
 *    today's one free reward run for a non-VIP player. Preferring the capped
 *    action means an economy that only publishes a single mint still behaves as
 *    the free run.
 *  - `"machine"` — this cabinet's own action, so a VIP player's one free run per
 *    machine is tracked (and capped) per cabinet. Falls back to `"free"` when
 *    the per-cabinet action has not been published yet.
 *  - `"ticket"` — an **uncapped** action, for a run the player paid a Play
 *    Ticket for. Without this split the free daily cap would swallow every
 *    ticket-funded win too.
 *
 * Returns `null` when the published economy has no coin-minting action, which
 * the caller must treat as "server cannot take this win" rather than silently
 * dropping it.
 */
export function resolveRavenCoinMintAction({
  actions,
  coinKey,
  variant = "free",
  machine,
  voucherKey,
}: {
  actions?: Record<string, unknown>;
  coinKey?: string;
  variant?: "free" | "machine" | "ticket";
  /** Registry id of the cabinet, required for `variant: "machine"`. */
  machine?: string;
  /**
   * Set when the run was opened against a voucher. The payout then has to burn
   * that voucher — which is what makes a *free* run cost anything, since the
   * attempt was spent by the open rather than by the payout.
   */
  voucherKey?: string;
}): string | null {
  const list: [string, AnyAction][] = Object.entries(
    (actions ?? {}) as Record<string, AnyAction>,
  );
  if (!list.length) return null;

  // A run opened against a voucher is paid by destroying it, whatever funded
  // it. `Claim-Raven-Coin` is uncapped by design now: the cap lives on the open.
  if (voucherKey && list.some(([id]) => id === REWARD_ATTEMPT_CLAIM_ACTION)) {
    return REWARD_ATTEMPT_CLAIM_ACTION;
  }

  // An explicitly published id always wins, so a fork can rename freely.
  if (variant === "machine" && machine) {
    const perMachine = machineMintActionId(machine);
    if (list.some(([id]) => id === perMachine)) return perMachine;
  }

  const preferred =
    variant === "ticket" ? REWARD_ATTEMPT_CLAIM_ACTION : RAVEN_COIN_MINT_ACTION;
  if (list.some(([id]) => id === preferred)) return preferred;

  const matchesCoin = (rule: unknown) => {
    const key = mintRuleCoinKey(rule);
    if (!key) return false;
    if (coinKey) return key === coinKey;
    return /^raven[\s_-]*coins?$/i.test(key.trim());
  };

  const mintsCoin = ([, action]: [string, AnyAction]) =>
    isRecord(action?.mint) &&
    Object.values(action.mint).some(matchesCoin) &&
    action.type === "custom";

  const isCapped = ([, action]: [string, AnyAction]) => {
    const mint = action.mint;
    if (!isRecord(mint)) return false;
    return Object.entries(mint).some(
      ([key, rule]) =>
        matchesCoin({ [key]: rule }) &&
        isRecord(rule) &&
        typeof rule.dailyCap === "number",
    );
  };

  const candidates = list.filter(mintsCoin);
  const wanted = candidates.filter((entry) =>
    variant === "ticket" ? !isCapped(entry) : isCapped(entry),
  );
  const chosen = wanted[0] ?? candidates[0];
  return chosen ? chosen[0] : null;
}

/**
 * The slot the arcade-wide reward-run tally is written into.
 *
 * `NIGHTSHADE_ARCADE_MINIGAMES` (which `getArcadeAttemptsUsedToday` sums over)
 * lists twelve ids, but only ten have cabinets — `roulette` and `slots` were
 * never wired to a machine. Writing today's total under `roulette` therefore:
 *
 *   - makes the **arcade-wide** sum (the non-VIP gate) equal the number of
 *     rewards actually collected today;
 *   - leaves every real cabinet's **per-machine** count untouched, since a
 *     cabinet only ever reads its own id;
 *   - avoids inventing an id the ported helpers would not recognise.
 */
export const ARCADE_WIDE_ATTEMPT_SLOT = "roulette";

/**
 * Today's reward-run history, ready to drop into `GameState.minigames.games`.
 *
 * The portal store layers the in-session attempts over this, so whatever is
 * returned here is what survives a page refresh — which is the whole point: it
 * is derived from the server's own `dailyMinted` ledger, not from a counter
 * living in the tab.
 *
 * Only **one** slot is ever filled, because the two gates read different keys:
 *
 *  - **non-VIP** is rationed arcade-wide, so the total goes under
 *    {@link ARCADE_WIDE_ATTEMPT_SLOT};
 *  - **VIP** is rationed per cabinet, so it goes under this cabinet's own id.
 *
 * Filling both would make `getArcadeAttemptsUsedToday` sum the two together and
 * lock a VIP out of every cabinet after their first win of the day.
 */
export function buildAttemptHistory({
  isVip,
  minigame,
  attemptsToday,
  today,
}: {
  isVip: boolean;
  minigame: string;
  attemptsToday: number;
  /** UTC day key, e.g. `2026-09-27`. */
  today: string;
}): Record<string, { history: Record<string, { attempts: number }> }> {
  if (!Number.isFinite(attemptsToday) || attemptsToday <= 0) return {};

  const slot = isVip ? minigame : ARCADE_WIDE_ATTEMPT_SLOT;
  return { [slot]: { history: { [today]: { attempts: attemptsToday } } } };
}

/**
 * `amounts` the rule engine needs for a **ranged** rule.
 *
 * The publisher normalises a mint that carries a `dailyCap` into
 * `{ min, max, dailyCap }`, and a ranged rule may only move an amount the
 * caller passes explicitly — otherwise the server answers
 * `400 Missing or invalid mint amount for 0` and nothing is credited. A plain
 * `{ amount }` rule needs no `amounts` at all.
 *
 * Returns `undefined` when the rule is fixed, so callers can spread it into
 * `dispatchAction({ action, amounts })` unconditionally.
 */
export function resolveActionAmounts({
  actions,
  actionId,
  tokenKey,
  amount,
}: {
  actions?: Record<string, unknown>;
  actionId: string | null | undefined;
  tokenKey: string;
  amount: number;
}): Record<string, number> | undefined {
  if (!actionId || !actions) return undefined;
  const definition = actions[actionId];
  if (!isRecord(definition)) return undefined;

  for (const field of ["mint", "burn"] as const) {
    const rules = definition[field];
    if (!isRecord(rules)) continue;
    const rule = rules[tokenKey];
    if (!isRecord(rule)) continue;
    if (typeof rule.amount === "number") continue; // fixed — no amounts needed
    if (typeof rule.min === "number" && typeof rule.max === "number") {
      const clamped = Math.min(
        Math.max(Math.trunc(amount), rule.min),
        rule.max,
      );
      return { [tokenKey]: clamped };
    }
  }

  return undefined;
}

/**
 * Reward runs already collected today, straight from the server's own ledger.
 *
 * `playerEconomy.dailyMinted.minted` is keyed `<actionId>|<coinKey>` and rolls
 * over on the UTC day, so it is the only *persisted* daily counter the API
 * exposes — the session has no `minigames` field for attempt history.
 *
 * This is what makes the arcade's "1 free reward run per day" stick across a
 * refresh: it is not the client counting attempts, it is the server counting
 * coins it has already minted.
 */
export function getRavenCoinsMintedToday({
  playerEconomy,
  actionId,
  coinKey,
}: {
  playerEconomy?: MinigameSessionResponse["playerEconomy"];
  actionId: string | null;
  coinKey: string;
}): number {
  const minted = playerEconomy?.dailyMinted?.minted;
  if (!minted || !actionId) return 0;

  const exact = minted[`${actionId}|${coinKey}`];
  if (typeof exact === "number" && Number.isFinite(exact)) {
    return Math.max(0, Math.trunc(exact));
  }

  // Looser keyings ("actionId" alone, or a bare coin key) still describe today's
  // mints for *this* action. Scoped deliberately: the ticket-funded payout
  // (`Mint-Raven-Coin-Ticket|<coin>`) must never be counted as a used free run,
  // so a prefix/suffix match would over-count and lock out tomorrow's free run.
  for (const [key, value] of Object.entries(minted)) {
    if (!Number.isFinite(value)) continue;
    if (key === actionId || key === coinKey) {
      return Math.max(0, Math.trunc(value as number));
    }
  }

  return 0;
}

/**
 * The `playerEconomy.balances` key the Play Ticket lives under.
 *
 * Same problem as the coin: live keys it `"2"` (`items["2"].name = "Play
 * Ticket"`), while an offline sample may use `PlayTicket`. Name match first,
 * then a balance that is actually there.
 */
export function resolvePlayTicketTokenKey({
  economyMeta,
  items,
  balances,
}: {
  economyMeta?: Pick<MinigameSessionEconomyMeta, "items">;
  items?: EconomyItems;
  balances?: Record<string, number>;
} = {}): string {
  const merged: EconomyItems = { ...items, ...economyMeta?.items };
  for (const [key, item] of Object.entries(merged)) {
    const name = item?.name;
    if (typeof name !== "string") continue;
    if (/^play[\s_-]*tickets?$/i.test(name.trim())) return key;
  }

  if (balances) {
    if (typeof balances[PLAY_TICKET_TOKEN_KEY] === "number") {
      return PLAY_TICKET_TOKEN_KEY;
    }
  }

  return PLAY_TICKET_TOKEN_KEY;
}

/** How many Play Tickets the player is holding right now. */
export function getPlayTicketBalance({
  playerEconomy,
  tokenKey,
}: {
  playerEconomy?: Pick<
    MinigameSessionResponse["playerEconomy"],
    "balances"
  > | null;
  tokenKey: string;
}): number {
  const value = playerEconomy?.balances?.[tokenKey];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

/**
 * The `playerEconomy.balances` key of the voucher a paid run is opened with.
 *
 * Same name-resolution approach as the coin and the ticket, because a hosted
 * economy keys items numerically while the offline sample keys them by name.
 * Returns `undefined` when no voucher item is published, which is what stops a
 * ticket-funded payout from being dispatched.
 */
export function resolveRewardAttemptTokenKey({
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
    if (typeof name !== "string") continue;
    if (REWARD_ATTEMPT_ITEM_NAME.test(name.trim())) return key;
  }

  // A voucher already sitting in a balance identifies itself.
  if (balances) {
    for (const key of Object.keys(balances)) {
      if (REWARD_ATTEMPT_ITEM_NAME.test(key)) return key;
    }
  }

  return undefined;
}
