/**
 * Nightshade Arcade — economy write worker + reward request queue
 * =============================================================
 *
 * ## The short version
 *
 * The economy has **Require secret API key** on, so the browser cannot write to it
 * at all — a direct `POST /action` is refused with `401 MISSING_PRIVATE_KEY`.
 * That makes **this worker the only process that can move a balance**, and every
 * rule that used to be enforced only by published action ids is enforced here.
 *
 * `POST /economy/write` is that write path. The section near the bottom of this
 * file explains the one rule that keeps it honest.
 *
 * ## The reward queue
 *
 * Holds the list of rewards the arcade owner owes players, and answers the only
 * question that matters there: *is this request actually for the person asking?*
 *
 * ## How identity works (the important part)
 *
 * The player sends their own portal JWT as `Authorization: Bearer <jwt>`. The
 * worker then asks Sunflower Land two questions *with that player's token*:
 *
 *   1. `GET {main}/portal/{PORTAL_ID}/player` -> which farm is this?
 *   2. `GET {economies}/data?type=session`   -> does this player hold the Dev Key?
 *
 * Both answers come from Sunflower Land, keyed on a token the player cannot forge.
 * The browser is never asked who it is.
 *
 * ## Storage
 *
 * - **KV** (`REWARDS`) — the reward queue and the chest tally. Eventually
 *   consistent, which is acceptable for both: a stale read costs a leaderboard
 *   row, never a payout.
 * - **D1** (`LEDGER`) — what each player has been allowed to mint today. This one
 *   gates money and needs atomicity, so it is SQLite rather than KV: an `INSERT`
 *   against `daily_slots`' primary key *is* the mutual exclusion that stops two
 *   concurrent claims for the same daily allowance from both succeeding.
 *
 * ## Secrets
 *
 * There is exactly one: `ECONOMY_PRIVATE_KEY`, set with
 * `npx wrangler secret put`. It is what makes this worker the privileged writer.
 * See `worker/SETUP.md`.
 *
 * ## The one trap, and why it is closed
 *
 * It is tempting to let the client say "here is the API base URL to use". Do not.
 * An attacker would point this worker at a server they control, get back
 * `{ farm: { id: <victim's farm> } }`, and claim rewards meant for other people.
 *
 * So the base URL comes from this worker's own `API_ENV` variable and nowhere
 * else. It is looked up in a two-entry table. A request can never influence it.
 *
 * ## KV keys, for the reward queue only
 *
 *   req:<id>            -> the full record
 *   farm:<farmId>:<id>  -> just the id, so "what am I owed" is a prefix scan
 *
 * KV is eventually consistent (a write can take up to ~60s to be visible in
 * another location). That is acceptable *here*: a stale read can only produce a
 * "you already claimed this" message, never a double payout. It is not acceptable
 * for the write ledger, which is why that is D1.
 */

// Checkpoint anti-cheat, shared verbatim with the Vite client. This MUST stay
// the identical implementation the browser runs: if the two could disagree about
// a rule, a cheater would exploit whichever one is more lenient. See the header
// of shared/anticheat/verify.js for what "reachable" means here.
import { verifyCheckpoints } from "@nightshade/shared/verify";
// Input-log replay, shared verbatim with the Vite client for the same reason as
// above — and one step further: `replay.js` bundles the client's *engine*, so
// the worker re-simulates a claimed run with the identical `stepMatch` the
// player stepped with. See the header of replay.js for why that is the whole
// anti-cheat.
import {
  CHUNK_TICKS,
  ReplayInputError,
  isReplayComplete,
  replayOutcome,
  resumeReplay,
  startReplay,
  stepReplay,
} from "./replay.js";
import { MAX_RUN_SCORE, MAX_SCORE_BY_WAVE } from "./scoreRules.js";

const PORTAL_ID = "Nightshade-Arcade";

/** Player-economy API. Production host; the JWT decides what it can see. */
const ECONOMIES_API = "https://economies-api.sunflower-land.com";

/**
 * Main game API. Chosen by `API_ENV` on the worker itself — never by a request.
 * See the trap note at the top of this file.
 */
const MAIN_API_BY_ENV = {
  mainnet: "https://api.sunflower-land.com",
  dev: "https://api-dev.sunflower-land.com",
};

/** Matches the Dev Key item by name, the same way the game resolves it. */
const DEV_KEY_ITEM_RE = /^dev[\s_-]*keys?$/i;

/**
 * The farm that may restore its own Dev Key.
 *
 * Read from the verified identity, never from the request: `identify()` has
 * already had Sunflower Land accept the caller's token, so this compares a number
 * the server derived rather than one the caller sent.
 *
 * See {@link bootstrapDevKey} for why this is safe to leave in permanently.
 */
const DEV_KEY_OWNER_FARM_ID = 1128976301583508;

/** The published action that mints a Dev Key. See {@link bootstrapDevKey}. */
const BOOTSTRAP_DEV_KEY_ACTION = "Bootstrap-Dev-Key";

/** Only used when the session carries no item metadata at all. */
const DEV_KEY_FALLBACK_TOKEN_KEY = "4";

const DEFAULT_ORIGINS = [
  "https://nightshade-arcade.economies.sunflower-land.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const CORS_MAX_AGE = "86400";

// ---------------------------------------------------------------------------
// Reward grants and claims (D1 — see migrations/0002_rewards.sql)
// ---------------------------------------------------------------------------

/**
 * The reward buttons an owner may send.
 *
 * A fixed map, not a prefix pattern. `actionId` reaches this worker from two
 * places — the dev's queue form and the player's claim — and in both cases it
 * decides how much value moves. A pattern like `/^Payout-/` would let a future
 * published action slip into the allowlist the moment somebody added it to the
 * editor, so the names are spelled out.
 *
 * The amount is recorded here and read from the *published action* at claim time,
 * never from the request. A tampered client cannot ask for the 100-coin button
 * and receive the 50-coin one, nor invent an amount.
 */
const REWARD_BUTTONS = {
  "Payout-PlayTicket-1": { tokens: 1, label: "1 Play Ticket" },
  "Payout-PlayTicket-3": { tokens: 3, label: "3 Play Tickets" },
  "Payout-RavenCoin-10": { tokens: 10, label: "10 Raven Coins" },
  "Payout-RavenCoin-50": { tokens: 50, label: "50 Raven Coins" },
  "Payout-RavenCoin-100": { tokens: 100, label: "100 Raven Coins" },
  "Payout-BetaKey-1": { betaKey: 1, label: "a Nightshade Arcade Beta Key" },
};

/**
 * Only actions whose id starts with this may ever appear in a request.
 *
 * Two reasons. It keeps the dev menu from accidentally queueing an unrelated
 * action. And it specifically fences off `Dev-Mint-Play-Ticket`, which is an
 * uncapped ranged mint — a request pointing at that would be a payout button
 * with no ceiling on it.
 *
 * Superseded by {@link REWARD_BUTTONS}, which is an allow-list of exact ids. The
 * prefix test could not express "not the mint"; the allow-list can, because
 * anything not named in it is refused.
 *
 * @deprecated kept only so the old prefix constant is not referenced anywhere.
 */
/** @deprecated kept only so the old prefix constant is not referenced anywhere. */
const PAYOUT_PREFIX = "Payout-";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value;
}



function firstString(record, keys) {
  if (!record) return undefined;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  }
  return undefined;
}

function newId() {
  return `r_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

function allowedOrigins(env) {
  const extra = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

/**
 * Response headers for a request from an allow-listed origin, or `null` when the
 * origin is not on the list.
 *
 * A disallowed origin still gets a well-formed 403 — the browser is what
 * enforces the refusal, and there is nothing to leak either way.
 */
function corsHeaders(request, env) {
  const origin = request.headers.get("origin") ?? "";
  const allowList = allowedOrigins(env);
  const allowed = origin !== "" && allowList.has(origin);

  const headers = {
    "access-control-allow-origin": allowed ? origin : "null",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": CORS_MAX_AGE,
    "cache-control": "no-store",
    "content-type": "application/json;charset=UTF-8",
  };

  return { headers, allowed };
}

// ---------------------------------------------------------------------------
// Talking to Sunflower Land
// ---------------------------------------------------------------------------

async function fetchJson(url, token) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", authorization: `Bearer ${token}` },
    });
  } catch {
    throw new HttpError(502, "Could not reach Sunflower Land. Try again in a moment.");
  }

  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = {};
    }
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(
      401,
      "Your game session has expired. Close the arcade and open it again from Sunflower Land.",
    );
  }
  if (!response.ok) {
    const detail = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new HttpError(502, `Sunflower Land refused the request: ${detail}`);
  }
  return body;
}

/**
 * Read the farm id out of a portal JWT payload.
 *
 * This is a *read*, never a *trust*. The payload is base64 and anyone can forge
 * one; nothing here decides who the caller is. The number it produces is only
 * ever used as a key to look up a record, and {@link authenticate} still requires
 * Sunflower Land to accept the same token before that lookup happens. A forged
 * token therefore fails on the upstream call rather than getting to name a farm.
 *
 * Mirrors the main game's own approach: `nightshadeArcadePortalMachine` calls
 * `decodeToken(jwt)` for `farmId` and keeps it in machine context, because the
 * farm document returned by `/portal/{id}/player` has no `id` field of its own —
 * `GameState` has `username`, `balance`, `inventory` and no farm id at all. That
 * is why the earlier version of this file searched the profile response for an
 * `id` and could never find one.
 */
function farmIdFromJwt(token) {
  const parts = token.split(".");
  if (parts.length < 2) return undefined;

  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(atob(padded));
    const merged = { ...claims, ...(asRecord(claims.properties) ?? {}) };

    for (const key of ["farmId", "farmID", "id", "fid", "farm_id", "farm"]) {
      const raw = merged[key];
      const value =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && raw.trim() !== ""
            ? Number(raw)
            : Number.NaN;
      if (Number.isFinite(value) && value > 0) return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Read the JWT payload, or `undefined` if it is not readable JWT shape.
 *
 * Another *unverified read*, like {@link farmIdFromJwt}: the payload is base64 and
 * anyone can produce one. Safe only because every caller gates it behind a verified
 * upstream call. A value from here must never decide anything on its own.
 */
function claimsFromJwt(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    return asRecord(JSON.parse(atob(padded)));
  } catch {
    return undefined;
  }
}

/**
 * Confirm the caller with Sunflower Land, and resolve their farm.
 *
 * Two calls, for two different jobs:
 *
 *  1. `/portal/{id}/player` proves the token is genuine. If Sunflower Land did not
 *     mint it, or will not speak for it, this throws and nothing downstream runs.
 *     This is the security half, and it is the half that cannot be faked.
 *  2. The farm id comes from the JWT, because the verified profile does not carry
 *     one. It is only ever used after step 1 has passed.
 *
 * ## Why the JWT payload is safe to read here
 *
 * `farmIdFromJwt` decodes without checking the signature, which looks alarming
 * until you notice what gates it. A caller can put any farm id they like in their
 * token — but editing the payload invalidates the signature, so step 1 rejects the
 * token at Sunflower Land and nothing downstream ever runs. Verified against the
 * live API: a token with `farmId` rewritten to another farm comes back `401`,
 * while the untouched token passes.
 *
 * The session payload was checked as a stronger alternative and does not carry a
 * farm id — `farm.bumpkin.id` is the bumpkin, not the farm. So this is not a
 * shortcut around a better source, it is the only source.
 *
 * ## The portalId check
 *
 * A token minted for a different economy would still authenticate against *some*
 * Sunflower Land endpoint while naming a different portal. Refusing it here turns a
 * confusing downstream failure into one clear message, and means a token for
 * another game can never reach this economy's ledger. Defence in depth rather than
 * a fix for a live hole: the signature check in step 1 already prevents forgery.
 */
async function identify(token, env) {
  // Defence in depth, not a fix. The signature check below already prevents
  // forgery; this refuses a token minted for a *different* portal before it can
  // reach this economy's ledger, so repointing this worker at another portal can
  // never quietly write into the wrong one.
  const claims = claimsFromJwt(token);
  const tokenPortalId =
    typeof claims?.portalId === "string" ? claims.portalId.trim() : undefined;

  if (!tokenPortalId) {
    throw new HttpError(
      401,
      "This game session was not issued for the arcade. Close it and open it again from Sunflower Land.",
    );
  }
  if (tokenPortalId !== PORTAL_ID) {
    // Logged so a misconfigured portal id is visible to the owner. A farm's own
    // portal name is not a secret, and this worker never logs a token.
    console.warn(
      `[identity] refused a token for portal "${tokenPortalId}"; this worker serves "${PORTAL_ID}".`,
    );
    throw new HttpError(
      401,
      "This game session belongs to a different game. Open the arcade from Sunflower Land.",
    );
  }

  const base = MAIN_API_BY_ENV[env.API_ENV ?? "mainnet"] ?? MAIN_API_BY_ENV.mainnet;
  const url = new URL(`/portal/${encodeURIComponent(PORTAL_ID)}/player`, `${base}/`);

  // Throws on any refusal. Do not skip: it is what makes a forged token useless.
  const body = await fetchJson(url.toString(), token);

  const root = asRecord(body);
  const farm =
    asRecord(root?.farm) ?? asRecord(asRecord(root?.data)?.farm) ?? root;

  const farmId = farmIdFromJwt(token);
  if (!farmId || farmId <= 0) {
    throw new HttpError(
      401,
      "Could not confirm which farm you are. Close the arcade and open it again from Sunflower Land.",
    );
  }

  return {
    farmId,
    username: firstString(farm, ["username", "displayName", "name"]) ?? "",
  };
}

/** The caller's own economy session: their balances, and the published actions. */
async function loadSession(token) {
  const url = new URL("/data", `${ECONOMIES_API}/`);
  url.searchParams.set("type", "session");

  const body = await fetchJson(url.toString(), token);
  const data = asRecord(body?.data);
  if (!data) throw new HttpError(502, "Sunflower Land returned an unexpected session payload.");
  return data;
}

/** The Dev Key's token key. Hosted economies use numeric keys, so match by name. */
function resolveDevKeyTokenKey(session) {
  const playerEconomy = asRecord(session.playerEconomy);
  const items = {
    ...(asRecord(session.items) ?? {}),
    ...(asRecord(playerEconomy?.items) ?? {}),
  };

  for (const [key, item] of Object.entries(items)) {
    const name = asRecord(item)?.name;
    if (typeof name === "string" && DEV_KEY_ITEM_RE.test(name.trim())) return key;
  }
  return DEV_KEY_FALLBACK_TOKEN_KEY;
}

/**
 * Restore the owner's Dev Key after the economy has been wiped.
 *
 * ## The problem it solves
 *
 * The Dev Key is normally unobtainable on purpose. `Dev-Mint-Play-Ticket` requires
 * one, and the action that used to mint one was deleted from the editor — see
 * `lib/devAccess.ts`, which explains why that sequence is what makes the key safe.
 *
 * That holds right up until the economy is reset. If the item definitions are wiped
 * and re-published, the owner is left holding no key, and the action that would
 * have minted them one no longer exists. Every dev tool is then unreachable, and the
 * fix has to be applied by someone who cannot reach the tools that would apply it.
 *
 * The alternative is to re-publish the mint, claim the key, and delete it again by
 * hand after every wipe. That is safe and it is the documented way to get a key in
 * the first place — this route exists so that a reset during development does not
 * require repeating it.
 *
 * ## The rule
 *
 * Three conditions, all checked here and all server-side:
 *
 *   1. the caller is this farm, compared against the *verified* identity rather
 *      than anything in the request;
 *   2. the caller does **not** already hold a Dev Key, so this cannot mint a
 *      second one;
 *   3. no Dev Key exists anywhere in the economy, read from the session's
 *      `supplies` map — the economy-wide circulating total, not this player's
 *      balance.
 *
 * Conditions 1 and 2 are hard. They are computed from Sunflower Land's own numbers
 * for the caller's token, so nothing the browser sends can change them, and between
 * them they stop the obvious abuse: the owner calling this twice. Condition 3 is
 * what keeps the route from being a standing way to hand a key to a farm that
 * should not have one — once anyone holds a key, `supplies` is non-zero and this
 * refuses for good.
 *
 * ## The one deliberate leniency, and what it costs
 *
 * Condition 3 reads an *absent* supply as zero. See {@link circulatingDevKeys} for
 * why that has to be true of a wiped economy. The cost is that the route can no
 * longer tell "no key exists" apart from "the API did not report one" — after a
 * wipe those are indistinguishable, and it takes the first reading.
 *
 * What keeps that from mattering is the item definition, not this file. The Dev Key
 * carries `max: 1` and `supply: 1`, it is not tradeable, and no published action
 * burns it — so the economy's own caps mean a second key cannot come into
 * existence even if condition 3 were wrong. Keep `supply: 1` on that item. Without
 * it, condition 3 is the only thing standing between a request and a second key.
 *
 * This is the deliberate trade: the route stays useful across wipes, which is what
 * makes it worth having during development, at the price of leaning on the item's
 * cap instead of a number read back from the API.
 *
 * ## What it deliberately does not do
 *
 * It does not relax `Dev-Mint-Play-Ticket`'s `require`, and it mints nothing but
 * that one item. It never mints a second key, and never mints for another farm.
 */
async function bootstrapDevKey(request, env, headers) {
  const { token, identity, session } = await authenticate(request, env);

  if (identity.farmId !== DEV_KEY_OWNER_FARM_ID) {
    throw new HttpError(
      403,
      "This is not the farm that can restore a developer key.",
    );
  }

  if (holdsDevKey(session)) {
    throw new HttpError(409, "This farm already holds a Dev Key.");
  }

  const key = resolveDevKeyTokenKey(session);
  const circulating = circulatingDevKeys(session, key);

  // The only thing left that this route refuses on is a value the API reported as
  // present *and* non-numeric, which would mean the session shape changed under us.
  // An absent total is not that case — it reads as zero, deliberately.
  if (circulating === undefined) {
    throw new HttpError(
      503,
      "This arcade cannot confirm how many developer keys exist. Restore the key in the Economy Editor instead.",
    );
  }
  if (circulating > 0) {
    throw new HttpError(
      409,
      "A Dev Key already exists in this economy, so this farm cannot claim one.",
    );
  }

  if (!asRecord(asRecord(session.actions)?.[BOOTSTRAP_DEV_KEY_ACTION])) {
    throw new HttpError(
      503,
      `No ${BOOTSTRAP_DEV_KEY_ACTION} action is published. Publish one that mints the Dev Key, then try again.`,
    );
  }

  const data = await callEconomy(env, { ...session, token }, {
    type: "minigame.action",
    action: BOOTSTRAP_DEV_KEY_ACTION,
    amounts: rangedAmounts(session, BOOTSTRAP_DEV_KEY_ACTION, key),
  });

  console.warn(
    `[dev-key] restored the Dev Key for farm ${DEV_KEY_OWNER_FARM_ID}. This route is now inert while that key exists.`,
  );

  return json({ restored: true, data }, 200, headers);
}

/**
 * Does this player hold a Dev Key?
 *
 * Server-derived: it is Sunflower Land's own balance for this farm, keyed on the
 * caller's token. Nobody can talk their way into it by editing the game.
 */
function holdsDevKey(session) {
  const balances = asRecord(asRecord(session.playerEconomy)?.balances) ?? {};
  const held = balances[resolveDevKeyTokenKey(session)];
  return typeof held === "number" && Number.isFinite(held) && held >= 1;
}

/**
 * How many Dev Keys exist across the whole economy, or `undefined` if that
 * number cannot be read.
 *
 * `session.supplies` is the economy-wide circulating total per token, and it is
 * reported **sparsely**. An item nobody holds is simply left out, and a session
 * with nothing in circulation at all carries `"supplies": {}` rather than a row of
 * zeros — verified against a freshly wiped Nightshade Arcade, where it came back
 * `{}` with every balance also empty.
 *
 * So "no entry for this token" and "a supply of zero" are the same statement, and
 * both have to read as zero. Treating the absent case as unreadable — which an
 * earlier version of this file did — made the route 503 at precisely the moment it
 * exists to be used.
 *
 * Only a value that is *present but not a number* is reported as unreadable. That
 * is worth refusing rather than guessing at, and it is the only failure this route
 * still refuses on.
 *
 * Note the worker reads `supplies` here and nowhere else: the chest tally keeps its
 * own count (see {@link chestTicketCap}) rather than trusting this map, because a
 * sparse economy-wide total is not something to build a budget on.
 *
 * @returns {number | undefined} `undefined` means "could not tell".
 */
function circulatingDevKeys(session, tokenKey) {
  const supplies = asRecord(session.supplies) ?? {};
  if (!Object.prototype.hasOwnProperty.call(supplies, tokenKey)) return 0;
  const value = Number(supplies[tokenKey]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Authenticate a request: pull the bearer token, confirm the farm, load the
 * session, and optionally insist on the Dev Key.
 */
async function authenticate(request, env, { requireDev = false } = {}) {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    throw new HttpError(401, "Missing session token. Open the arcade from Sunflower Land.");
  }
  const token = match[1].trim();
  if (!token) throw new HttpError(401, "Empty session token.");

  const identity = await identify(token, env);
  const session = await loadSession(token);
  const isDev = holdsDevKey(session);

  if (requireDev && !isDev) {
    throw new HttpError(403, "This action is limited to the arcade owner.");
  }

  return { token, identity, session, isDev };
}

// ---------------------------------------------------------------------------
// The chest tally
// ---------------------------------------------------------------------------
//
// The entryway chests pay one Play Ticket for 50 clicks in a row, once a day,
// until the arcade has handed out its whole supply. **The cap is not enforced
// here.** It is the `supply` on the `chest_click_tracker` item in the Economy
// Editor, which the economies server decrements inside the same mint that hands
// over the ticket - atomic, and somewhere the player cannot edit it.
//
// What this worker holds is the part the economy cannot express: who got how
// many. There is no published ranking and no way to ask the economy API for a top
// ten, so the game reports each payout here and reads the board back to show it
// once the pot is empty.
//
// So treat every number here as **bookkeeping, not a ledger of record**:
//
//   - A player who closes the tab between winning and reporting is under-counted.
//     The pot still moved, so the damage is a short row and a late message.
//   - A player who never reports at all - including a cheater - is under-counted
//     the same way. They gain nothing by it: the ticket was already minted, and
//     this worker cannot mint anything.
//   - `get` then `put` is not atomic in KV, and KV is eventually consistent, so a
//     burst of simultaneous reports can lose a count or two.
//
// Losing a count is the only failure this design can produce. It cannot hand out
// a ticket the economy did not mint, which is the only direction that matters.

const KV_CHEST_POT = "chest:pot";
const KV_CHEST_PLAYER_PREFIX = "chest:player:";
const KV_CHEST_PLAYER = (farmId) => `${KV_CHEST_PLAYER_PREFIX}${farmId}`;

/** Fallback when `CHEST_TICKET_CAP` is unset or nonsense. Keep in sync with the item's `supply`. */
const DEFAULT_CHEST_TICKET_CAP = 10000;

/** How many rows the chest leaderboard shows. */
const CHEST_LEADERBOARD_LIMIT = 10;

/**
 * The arcade-wide chest ticket cap, for display only.
 *
 * Deliberately a *mirror* of the item's `supply` rather than a limit of its own:
 * this number decides when the chest switches to the "everybody who told their
 * friends" message, while the item decides when the mint is actually refused. If
 * the two ever disagree, the item wins - the game's refusal handling
 * (`classifyChestClaimRefusal`) treats a server refusal as the real answer and
 * only ever uses this one to speak first.
 *
 * Changing the cap means editing `CHEST_TICKET_CAP` here *and* the `supply` on
 * `chest_click_tracker` in the editor. The two should be set to the same number.
 */
function chestTicketCap(env) {
  const raw = String(env.CHEST_TICKET_CAP ?? "").trim();
  if (!/^\d{1,9}$/.test(raw)) return DEFAULT_CHEST_TICKET_CAP;

  const value = Number(raw);
  return value > 0 ? value : DEFAULT_CHEST_TICKET_CAP;
}

async function readChestPot(env) {
  const raw = await env.REWARDS.get(KV_CHEST_POT);
  if (!raw) return { granted: 0 };

  try {
    const parsed = JSON.parse(raw);
    const granted = Number(parsed?.granted);
    return { granted: Number.isFinite(granted) && granted > 0 ? granted : 0 };
  } catch {
    return { granted: 0 };
  }
}

async function writeChestPot(env, granted) {
  await env.REWARDS.put(KV_CHEST_POT, JSON.stringify({ granted }));
}

async function readChestPlayer(env, farmId) {
  const raw = await env.REWARDS.get(KV_CHEST_PLAYER(farmId));
  if (!raw) return null;

  try {
    const parsed = asRecord(JSON.parse(raw));
    if (!parsed) return null;

    const tickets = Number(parsed.tickets);
    return {
      farmId,
      username: typeof parsed.username === "string" ? parsed.username : "",
      tickets: Number.isFinite(tickets) && tickets > 0 ? Math.trunc(tickets) : 0,
    };
  } catch {
    return null;
  }
}

/** The whole board, highest first, capped at `limit`. */
async function listChestPlayers(env, limit) {
  const keys = [];
  let cursor;

  do {
    const page = await env.REWARDS.list({ prefix: KV_CHEST_PLAYER_PREFIX, cursor });
    for (const key of page.keys ?? []) {
      keys.push(key.name.slice(KV_CHEST_PLAYER_PREFIX.length));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const players = await Promise.all(keys.map((id) => readChestPlayer(env, Number(id))));
  return players
    .filter((entry) => entry && entry.tickets > 0)
    // Farm id as the tiebreak, so two players on the same total have a fixed
    // order. Without it the board reshuffles between reads and the rank numbers
    // mean nothing.
    .sort((a, b) => b.tickets - a.tickets || a.farmId - b.farmId)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// A safety lint for payout buttons
// ---------------------------------------------------------------------------

/**
 * Look at the published action the dev picked and point out anything that would
 * make it leak.
 *
 * These are warnings, not refusals — a button with no `requireAbsent` is still a
 * legal button, it just means "anyone who finds this can use it", and the owner
 * should hear that at the moment they queue it rather than afterwards.
 *
 * The `requireAbsent` + `mint the marker` pairing is the subtle one.
 * `requireAbsent: ["Marker"]` only means "you may run this if you hold zero
 * Markers". On its own that is not a one-time gate at all: nothing ever *sets*
 * the marker, so it stays at zero and the action can be run forever. The action
 * has to mint the marker in the same breath, so that claiming it pushes the
 * player over the line the next time round. Get that pairing wrong and the button
 * is an infinite mint, so it is worth checking every time.
 */
function lintPayoutAction(action) {
  const rule = asRecord(action);
  if (!rule) {
    return ["That action is not published in the economy, so there is nothing to claim."];
  }

  const warnings = [];

  const absent = Array.isArray(rule.requireAbsent)
    ? rule.requireAbsent.filter((token) => typeof token === "string")
    : [];
  const minted = new Set(Object.keys(asRecord(rule.mint) ?? {}));

  // The `requireAbsent` + `mint the marker` pairing is the subtle one.
  // `requireAbsent: ["Marker"]` only means "you may run this if you hold zero
  // Markers". On its own that is not a one-time gate at all: nothing ever *sets*
  // the marker, so it stays at zero and the action can be run forever. The action
  // has to mint the marker in the same breath, so that claiming it pushes the
  // player over the line the next time round. Get that pairing wrong and the button
  // is an infinite mint, so it is worth checking every time.
  //
  // The reverse — no `requireAbsent` at all — is not warned about. One-use is
  // enforced by the worker's D1 ledger (a grant can only be claimed once), not by
  // the economy, so a missing `requireAbsent` is not a leak.
  if (absent.length > 0) {
    const neverSet = absent.filter((token) => !minted.has(token));
    if (neverSet.length > 0) {
      warnings.push(
        `requireAbsent lists ${neverSet.join(", ")} but this action never mints it. ` +
          "The marker stays at 0 forever, so requireAbsent blocks nothing and this button " +
          "can be claimed repeatedly. Add the marker to this action's mint as well.",
      );
    }
  }

  if (rule.showInShop !== false) {
    warnings.push("showInShop is not false, so this button is visible in the economy dashboard.");
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function handleWhoami(request, env, headers) {
  const { identity, isDev } = await authenticate(request, env);
  return json({ farmId: identity.farmId, username: identity.username, isDev }, 200, headers);
}

async function handleCreate(request, env, headers) {
  const { identity, session } = await authenticate(request, env, { requireDev: true });

  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }

  const targetFarmId = Number(payload?.farmId);
  if (!Number.isFinite(targetFarmId) || targetFarmId <= 0) {
    throw new HttpError(400, "farmId is required — the recipient's farm number.");
  }

  const actionId = typeof payload?.actionId === "string" ? payload.actionId.trim() : "";
  if (!Object.prototype.hasOwnProperty.call(REWARD_BUTTONS, actionId)) {
    throw new HttpError(
      400,
      `actionId must be one of the published reward buttons: ${Object.keys(REWARD_BUTTONS).join(", ")}.`,
    );
  }

  const record = {
    id: newId(),
    farmId: targetFarmId,
    label: typeof payload?.label === "string" ? payload.label.trim().slice(0, 120) : "",
    note: typeof payload?.note === "string" ? payload.note.trim().slice(0, 280) : "",
    actionId,
    createdAt: nowSeconds(),
    createdBy: identity.farmId,
    createdByUsername: identity.username,
  };

  await env.LEDGER.prepare(
    `INSERT INTO grants (id, farm_id, action_id, label, note, created_at, created_by, created_by_username)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      record.id,
      record.farmId,
      record.actionId,
      record.label,
      record.note,
      record.createdAt * 1000,
      record.createdBy,
      record.createdByUsername,
    )
    .run();

  return json(
    {
      request: record,
      warnings: lintPayoutAction(asRecord(session.actions)?.[actionId]),
    },
    201,
    headers,
  );
}

async function handleMine(request, env, headers) {
  const { identity } = await authenticate(request, env);
  // Every grant for this farm, with whether *this* farm has claimed it. The join
  // is on `grant_id`, so a grant claimed by a different farm shows as unclaimed
  // here — correct, because it is not this player's to take.
  const { results } = await env.LEDGER.prepare(
    `SELECT g.id, g.farm_id, g.action_id, g.label, g.note,
            g.created_at, g.created_by, g.created_by_username,
            c.claimed_at, c.settled_at, c.detail
       FROM grants g
       LEFT JOIN claims c ON c.grant_id = g.id AND c.farm_id = g.farm_id
      WHERE g.farm_id = ?
      ORDER BY g.created_at DESC
      LIMIT 200`,
  )
    .bind(identity.farmId)
    .all();

  const requests = (results ?? []).map(rowToGrant);
  return json({ farmId: identity.farmId, requests }, 200, headers);
}

/**
 * A D1 `grants` row as the shape the client expects.
 *
 * `settledAt` and `claimedDetail` come from the claim row, and they are the audit
 * trail: `claimedAt` alone cannot distinguish a claim that minted from one that
 * was refused ambiguously and may or may not have paid out. The owner's full
 * history panel shows both, so a manual check months later can tell what happened.
 */
function rowToGrant(row) {
  return {
    id: row.id,
    farmId: row.farm_id,
    actionId: row.action_id,
    label: row.label,
    note: row.note,
    createdAt: Math.floor(row.created_at / 1000),
    createdBy: row.created_by,
    createdByUsername: row.created_by_username,
    claimedAt: row.claimed_at ? Math.floor(row.claimed_at / 1000) : null,
    settledAt: row.settled_at ? Math.floor(row.settled_at / 1000) : null,
    claimedDetail: row.detail ?? null,
    claimedByUsername: row.claimed_by_username ?? null,
  };
}

async function handleList(request, env, headers) {
  await authenticate(request, env, { requireDev: true });

  // Every grant, newest first, joined to its claim — this is the owner's audit
  // view, so it carries `settled_at` and the refusal `detail` as well as
  // `claimed_at`. Without them a claim that was refused ambiguously looks
  // identical to one that paid out, which is the one distinction a manual check
  // most needs.
  //
  // `LIMIT 500` is the cap on how far back this goes. D1 is queried by
  // `created_at DESC`, so it is the most recent 500 and the oldest fall off the
  // end; `grants` and `claims` both persist, so anything older is still on disk
  // and a SQL query can reach it.
  const { results } = await env.LEDGER.prepare(
    `SELECT g.id, g.farm_id, g.action_id, g.label, g.note,
            g.created_at, g.created_by, g.created_by_username,
            c.claimed_at, c.settled_at, c.detail, c.claimed_by_username
       FROM grants g
       LEFT JOIN claims c ON c.grant_id = g.id
      ORDER BY g.created_at DESC
      LIMIT 500`,
  ).all();

  console.log("[handleList] results count:", results?.length);
  if (results?.[0]) {
    console.log("[handleList] first row keys:", Object.keys(results[0]));
    console.log("[handleList] first row claimed_by_username:", results[0].claimed_by_username);
  }

  return json({ requests: (results ?? []).map(rowToGrant) }, 200, headers);
}

/**
 * Claim a reward — the **whole** operation, mint included.
 *
 * This replaces the old two-step design, where the client pressed the published
 * button itself and then told the worker it had done so. That split is what left
 * the hole: the client chose which action to press, and `requireAbsent` on the
 * marker was the only thing making it once-only — a primitive that cannot express
 * "the same reward, many times, to one player".
 *
 * Here the client sends only a grant id. Everything that decides anything —
 * whether the grant exists, whether it is addressed to this farm, whether it has
 * already been taken, which action runs, what it mints — is decided here.
 *
 * Order, and why:
 *
 *   1. `authenticate` — Sunflower Land must accept the token, and the farm id has
 *      to come from that verified token rather than the body.
 *   2. read the grant, and check it is addressed to this farm.
 *   3. `INSERT INTO claims` — the primary key on `grant_id` is the atomic gate. A
 *      second claim of the same grant collides here and never reaches the API,
 *      which is what makes "exactly once" true rather than merely likely.
 *   4. mint, then mark the claim settled.
 *
 * If step 4 fails on a definitive 400 the claim row is removed again, so the player
 * can retry after fixing whatever the rule wanted. If it fails ambiguously — 5xx,
 * timeout — the row stays with `settled_at IS NULL`, because the write may have
 * landed and deleting the evidence would risk paying twice.
 */
async function handleClaim(request, env, headers) {
  const { token, identity, session } = await authenticate(request, env);

  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }

  // `callEconomy` reads the token off the session object it is handed, and the
  // session from `authenticate` does not carry one — so graft it on, exactly as
  // the write handler does. Miss this and the call goes out as `Bearer undefined`
  // and comes back 401, which reads exactly like an expired player session.
  const caller = { ...session, token };

  const grantId = typeof payload?.grantId === "string" ? payload.grantId.trim() : "";
  if (!grantId) throw new HttpError(400, "grantId is required.");

  const grant = (await env.LEDGER.prepare(`SELECT * FROM grants WHERE id = ?`)
    .bind(grantId)
    .first()) ?? undefined;

  if (!grant) throw new HttpError(404, "That reward no longer exists.");
  if (grant.farm_id !== identity.farmId) {
    throw new HttpError(403, "That reward is not addressed to you.");
  }

  // Must still be a published button, or an unpublished one has been withdrawn.
  const button = REWARD_BUTTONS[grant.action_id];
  if (!button) {
    throw new HttpError(409, "That reward is no longer available. Tell the arcade owner.");
  }
  if (!asRecord(asRecord(session.actions)?.[grant.action_id])) {
    throw new HttpError(
      503,
      "That reward is not set up right now. Tell the arcade owner.",
    );
  }

  const now = Date.now();
  // The player's username is in session.farm.username (from the verified token).
  // Store null (not "") so the DB has NULL and rowToGrant returns null.
  const claimantUsername = session.farm?.username ?? null;
  try {
    await env.LEDGER.prepare(
      `INSERT INTO claims (grant_id, farm_id, action_id, claimed_at, claimed_by_username) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(grantId, identity.farmId, grant.action_id, now, claimantUsername)
      .run();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    throw new HttpError(409, "You have already claimed that reward.");
  }

  let data;
  try {
    data = await mintReward(env, caller, grant.action_id);
  } catch (error) {
    const refused = error instanceof HttpError && error.status === 400;
    if (refused) {
      // Nothing was written, so release the claim and let the player try again.
      await env.LEDGER.prepare(`DELETE FROM claims WHERE grant_id = ?`).bind(grantId).run();
    } else {
      // Ambiguous. Keep the row, unsettled, as evidence.
      await env.LEDGER.prepare(`UPDATE claims SET detail = ? WHERE grant_id = ?`)
        .bind(String(error?.message ?? error).slice(0, 300), grantId)
        .run();
    }
    throw error;
  }

  await env.LEDGER.prepare(`UPDATE claims SET settled_at = ? WHERE grant_id = ?`)
    .bind(Date.now(), grantId)
    .run();

  return json(
    {
      grantId,
      actionId: grant.action_id,
      label: button.label,
      claimedAt: Math.floor(now / 1000),
      data,
    },
    200,
    headers,
  );
}

/**
 * Run a published reward button.
 *
 * No `amounts`: every reward action mints a **fixed** amount, and a fixed rule
 * takes none. Deriving the amount here from the published rule rather than from
 * the request is what stops a tampered client asking for a different number — and
 * there is no number to ask for anyway, which is the simpler guarantee.
 */
async function mintReward(env, session, actionId) {
  return callEconomy(env, session, { type: "minigame.action", action: actionId });
}

/**
 * Withdraw a grant before it is taken.
 *
 * Refuses if a claim row exists, unsettled *or* settled. An unsettled row is a
 * claim that may have minted, so deleting the grant would hide the evidence and
 * leave the owner unable to reconcile it.
 */
async function handleCancel(request, env, headers, id) {
  await authenticate(request, env, { requireDev: true });

  const grant = await env.LEDGER.prepare(`SELECT * FROM grants WHERE id = ?`).bind(id).first();
  if (!grant) throw new HttpError(404, "That reward no longer exists.");

  const claim = await env.LEDGER.prepare(`SELECT settled_at FROM claims WHERE grant_id = ?`)
    .bind(id)
    .first();

  if (claim) {
    const unsettled = !claim.settled_at;
    throw new HttpError(
      409,
      unsettled
        ? "That reward is mid-claim. Check the claims table before removing it."
        : "That reward has already been claimed.",
    );
  }

  await env.LEDGER.prepare(`DELETE FROM grants WHERE id = ?`).bind(id).run();
  return json({ cancelled: id }, 200, headers);
}

/**
 * Remove a row from the owner's claimed history.
 *
 * ## Why this is a separate route from cancelling
 *
 * Cancelling withdraws a grant nobody has taken, which is a normal thing to do.
 * This deletes a record of something that *already happened* — the player pressed
 * the button and the mint settled. Those are different acts with different
 * consequences, so they are different verbs: a single `DELETE` that could do both
 * would let a mis-click quietly rewrite the audit trail.
 *
 * ## The guard
 *
 * Refuses while a claim exists, settled or not. An unsettled claim is one whose
 * mint may or may not have gone out, and deleting the grant would destroy the only
 * evidence of an ambiguous payout — the one case where the owner most needs to be
 * able to reconcile it. Settling first is the owner's decision to make with the
 * player's balance in hand, not something a button should do.
 *
 * `?force=true` overrides the unsettled case only. It is the owner saying "I have
 * checked the balance, the payout did not land, delete the record anyway" — an
 * explicit act, logged, rather than a button that quietly rewrites history. The
 * other refusals (no grant, no claim) are not forceable: there is nothing to
 * reconcile when there is nothing there.
 *
 * ## What it actually removes
 *
 * The `grants` row and its `claims` row together. Removing only the grant would
 * leave an orphan claim that could be rejoined to nothing; removing only the claim
 * would let the same grant be claimed a second time. Both go, atomically enough
 * for this purpose — and the claim row going is safe precisely because the grant
 * row goes with it, so the "exactly once" guarantee is not reopened.
 */
async function handleForgetHistory(request, env, headers, id) {
  await authenticate(request, env, { requireDev: true });

  const grant = await env.LEDGER.prepare(`SELECT * FROM grants WHERE id = ?`).bind(id).first();
  if (!grant) throw new HttpError(404, "That reward is no longer in the history.");

  const claim = await env.LEDGER.prepare(`SELECT settled_at FROM claims WHERE grant_id = ?`)
    .bind(id)
    .first();

  // `force` is read from the query string, never the body: this is a `DELETE`, and
  // a body on a delete is easy to forget in a client. The value is a literal
  // "true" — anything else is ignored, so a stale link cannot half-override.
  const force = new URL(request.url).searchParams.get("force") === "true";

  if (claim && !claim.settled_at && !force) {
    throw new HttpError(
      409,
      "That claim never settled, so it may or may not have paid out. Check the player's balance before removing the record.",
    );
  }
  if (!claim) {
    throw new HttpError(
      409,
      "That reward has not been claimed yet. Cancel it from the outstanding list instead.",
    );
  }

  await env.LEDGER.prepare(`DELETE FROM claims WHERE grant_id = ?`).bind(id).run();
  await env.LEDGER.prepare(`DELETE FROM grants WHERE id = ?`).bind(id).run();

  // Not a secret and not a token, so logging the id is enough to answer "who
  // removed this, and when" if it is ever asked. A forced removal of an unsettled
  // claim is the one entry in this table that deserves a second look, so it gets
  // its own line.
  console.warn(
    force
      ? `[rewards] dev force-removed unsettled claim ${id} from the history.`
      : `[rewards] dev removed claimed reward ${id} from the history.`,
  );

  return json({ removed: id }, 200, headers);
}

// ---------------------------------------------------------------------------
// Chest routes
// ---------------------------------------------------------------------------

/**
 * How much of the chest supply is left, and the board.
 *
 * Everyone may read it: it is a leaderboard of usernames and counts, the same
 * things a game's own high-score table shows, and the message that pairs with it
 * is shown to everyone at once anyway.
 */
async function handleChestState(request, env, headers) {
  const { identity } = await authenticate(request, env);

  const cap = chestTicketCap(env);
  const { granted } = await readChestPot(env);

  return json(
    {
      cap,
      granted,
      exhausted: granted >= cap,
      entries: await listChestPlayers(env, CHEST_LEADERBOARD_LIMIT),
      you: await readChestPlayer(env, identity.farmId),
    },
    200,
    headers,
  );
}

/**
 * Record one chest payout.
 *
 * The caller is identified from their own token - the farm id is never read from
 * the body - and the username is re-fetched from Sunflower Land rather than
 * taken on trust, so nobody can put someone else's name on the board.
 *
 * `amount` must be 1. A chest pays one ticket per completed streak, so there is
 * no honest reason for a larger number, and allowing one would let a player post
 * themselves straight to the top of a leaderboard that is meant to be a record
 * of what they actually earned.
 */
async function handleChestTicket(request, env, headers) {
  const { identity } = await authenticate(request, env);

  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }

  const amount = Number(payload?.amount ?? 1);
  if (!Number.isInteger(amount) || amount !== 1) {
    throw new HttpError(400, "A chest payout is exactly one ticket.");
  }

  const previous = await readChestPlayer(env, identity.farmId);
  const record = {
    username: identity.username || previous?.username || "",
    tickets: (previous?.tickets ?? 0) + amount,
    lastAt: nowSeconds(),
  };
  await env.REWARDS.put(KV_CHEST_PLAYER(identity.farmId), JSON.stringify(record));

  const { granted } = await readChestPot(env);
  await writeChestPot(env, granted + amount);

  return json(
    { farmId: identity.farmId, tickets: record.tickets, granted: granted + amount },
    200,
    headers,
  );
}

/**
 * Zero the tally. Dev-only.
 *
 * This does **not** refill the supply - that is the item's `supply` in the
 * Economy Editor and only Sunflower Land can restore it. What this clears is the
 * board and the count, so the owner can see the end-of-the-line message and the
 * leaderboard without having to mint ten thousand tickets first.
 */
async function handleChestReset(request, env, headers) {
  await authenticate(request, env, { requireDev: true });

  const keys = [];
  let cursor;

  do {
    const page = await env.REWARDS.list({ prefix: KV_CHEST_PLAYER_PREFIX, cursor });
    for (const key of page.keys ?? []) keys.push(key.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  await Promise.all(keys.map((key) => env.REWARDS.delete(key)));
  await writeChestPot(env, 0);

  return json({ reset: true, cleared: keys.length }, 200, headers);
}

// ---------------------------------------------------------------------------
// The economy write path
// ---------------------------------------------------------------------------
//
// ## What changed, and why this section exists
//
// Until now this worker could not write to the economy at all — the browser was
// the only writer, which meant anyone could POST a published action id directly
// and be credited whatever it mints. The economy's **Require secret API key**
// toggle fixes that: every write must carry `x-economy-private-key`, so the
// browser is refused with `401 MISSING_PRIVATE_KEY` and this worker is the only
// process that can move a balance.
//
// That makes this worker responsible for the thing it could previously delegate
// entirely, which is why the rules below are stricter than the rest of the file.
//
// ## The one rule
//
// **The client never names an action id, a token, or an amount.** It sends an
// `intent` from a fixed list, and everything the Sunflower Land API needs is
// derived here. A proxy that forwarded whatever action the browser asked for
// would keep the key secret and enforce nothing — the player would simply name
// `Mint-Raven-Coin-Poker` and be served. The allowlist is the security property;
//// the secret key is only what makes this worker the privileged caller.

/** Item names this economy uses, matched loosely so spacing/case cannot break it. */
const RAVEN_COIN_ITEM_RE = /^raven[\s_-]*coins?$/i;
const PLAY_TICKET_ITEM_RE = /^play[\s_-]*tickets?$/i;
const REWARD_ATTEMPT_ITEM_RE = /^reward[\s_-]*attempt$/i;
const FREE_RUN_TOKEN_ITEM_RE = /^free[\s_-]*run[\s_-]*token[\s_-]*(.*)$/i;

const FALLBACK_KEYS = {
  ravenCoin: "0",
  playTicket: "2",
  rewardAttempt: "3",
};

/**
 * Registry id -> the economy's name suffix for it, e.g. `pac-man` -> `PacMan`.
 *
 * Derived the same way the game derives it, so an action id in a request is
 * matched back to a cabinet without the client having to say which cabinet it
 * meant. The list is the arcade's, not the economy's: an id we do not publish has
 * no free-run actions, so an unknown one is refused rather than guessed at.
 */
const CABINETS = {
  poker: "Poker",
  blackjack: "Blackjack",
  gofish: "Gofish",
  uno: "Uno",
  solitaire: "Solitaire",
  "goblin-invaders": "GoblinInvaders",
  tetris: "Tetris",
  "barley-breaker": "BarleyBreaker",
  "pac-man": "PacMan",
  frogger: "Frogger",
  "raven-bubbles": "RavenBubbles",
  "sunflower-brawler": "SunflowerBrawler",
};

const ARCADE_SUFFIX = "Arcade";

/**
 * Shop actions this worker will run on request.
 *
 * An allowlist rather than "anything the economy publishes", so publishing a new
 * `type: "shop"` action in the editor does not silently hand the browser a new
 * button. `buy_*` is the arcade's own naming; nothing from the reward queue is
 * reachable through here.
 */
const BUY_ACTION_RE = /^buy_[a-z0-9_]{1,64}$/;

const GRANT_PREFIX = "Grant-Free-Run-";
const START_FREE_PREFIX = "Start-Free-Run-";

/** UTC day key, matching the game. Slots are per-UTC-day, not local day. */
function utcDayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/** The economy's `balances`, whatever shape it arrived in. */
function balancesOf(session) {
  return asRecord(asRecord(session?.playerEconomy)?.balances) ?? {};
}

/** Published `items`, merged with the mirror some responses carry. */
function itemsOf(session) {
  return {
    ...(asRecord(session?.items) ?? {}),
    ...(asRecord(asRecord(session?.playerEconomy)?.items) ?? {}),
  };
}

/**
 * The `balances` key for an item, found by name.
 *
 * Hosted economies key items numerically (`"0"`, `"2"`), so a name match has to
 * return the *key* rather than the name. Falls back to the key the hosted
 * economy is known to use, which is only ever a better error message.
 */
function tokenKeyFor(session, matcher, fallbackKey) {
  for (const [key, item] of Object.entries(itemsOf(session))) {
    const name = asRecord(item)?.name;
    if (typeof name === "string" && matcher.test(name.trim())) return key;
  }
  return fallbackKey;
}

function ravenCoinKey(session) {
  return tokenKeyFor(session, RAVEN_COIN_ITEM_RE, FALLBACK_KEYS.ravenCoin);
}

function playTicketKey(session) {
  return tokenKeyFor(session, PLAY_TICKET_ITEM_RE, FALLBACK_KEYS.playTicket);
}

function rewardAttemptKey(session) {
  return tokenKeyFor(session, REWARD_ATTEMPT_ITEM_RE, FALLBACK_KEYS.rewardAttempt);
}

/**
 * The `balances` key of one cabinet's free-run token, e.g. `Free Run Token - Poker`.
 *
 * Returns `undefined` rather than a guess: the token is what a free run costs, so
 * a cabinet whose token cannot be identified has no free run here.
 */
function freeRunTokenKey(session, suffix) {
  const wanted = suffix.toLowerCase();
  for (const [key, item] of Object.entries(itemsOf(session))) {
    const name = asRecord(item)?.name;
    if (typeof name !== "string") continue;
    const match = FREE_RUN_TOKEN_ITEM_RE.exec(name.trim());
    if (match && (match[1] ?? "").trim().toLowerCase() === wanted) return key;
  }
  return undefined;
}

/**
 * Is this player VIP?
 *
 * Read from the session *this worker fetched*, never from the request. The flag is
 * produced by Sunflower Land from the farm's own record, so a player editing
 * their browser cannot move it — which is the entire reason the free-run split is
 * enforceable now.
 */
function isVip(session) {
  const vip = asRecord(asRecord(asRecord(session?.farm)?.vip));
  const flag = vip?.isVip;
  if (typeof flag === "boolean") return flag;
  if (flag === "true") return true;
  if (flag === "false") return false;

  // Fallback for an API that has not shipped the flag: an unexpired timestamp.
  const expiresAt = vip?.expiresAt;
  if (typeof expiresAt === "number") return Number.isFinite(expiresAt) && expiresAt > Date.now();
  return false;
}

/**
 * Call the economies API as the privileged writer.
 *
 * The private key is the whole reason this function exists. It comes from the
 * environment and is never echoed back, logged, or accepted from a request.
 *
 * Takes the whole `session` rather than just the token, because a rule refusal
 * has to be translated into copy — and translating it needs the item names, which
 * live on the session. See {@link friendlyRuleRefusal}.
 */
async function callEconomy(env, session, body) {
  const token = session.token;
  const key = env.ECONOMY_PRIVATE_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    // Loud and specific: this is a deployment problem, not a player problem.
    throw new HttpError(
      503,
      "This arcade is misconfigured: the economy private key is not set on the server. Tell the arcade owner.",
    );
  }

  let response;
  try {
    response = await fetch(`${ECONOMIES_API}/action`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json;charset=UTF-8",
        authorization: `Bearer ${token}`,
        "x-economy-private-key": key,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new HttpError(502, "Could not reach Sunflower Land. Try again in a moment.");
  }

  const text = await response.text();
  let parsed = {};
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
  }

  if (response.status === 401 || response.status === 403) {
    // 401/403 here is about *our* key, the player's token, or the farm's access —
    // never the player's mistake — so it must not read as "your session expired".
    const code = typeof parsed?.errorCode === "string" ? parsed.errorCode : "";
    if (code === "MISSING_PRIVATE_KEY" || code === "INVALID_PRIVATE_KEY") {
      throw new HttpError(
        503,
        "This arcade is misconfigured: Sunflower Land rejected the economy key. Tell the arcade owner.",
      );
    }
    if (code === "FEATURE_DISABLED" || code === "FARM_BANNED") {
      throw new HttpError(
        403,
        code === "FARM_BANNED"
          ? "This farm cannot play the arcade. Tell the arcade owner."
          : "Minigames are not enabled for this farm yet.",
      );
    }
    // Anything else is an expired or malformed token. The code is carried into the
    // message so a genuine surprise is diagnosable from the ledger's `detail`
    // column rather than looking identical to an expired session forever.
    const suffix = code ? ` (${code})` : "";
    throw new HttpError(
      401,
      `Your game session has expired. Close the arcade and open it again from Sunflower Land.${suffix}`,
    );
  }

  if (!response.ok) {
    const detail = typeof parsed.error === "string" ? parsed.error : `HTTP ${response.status}`;
    // A 400 is the economy refusing a rule — insufficient token, cooldown, daily
    // cap, item max. That is the player's own answer and it is safe to translate
    // into copy they can act on. See `friendlyRuleRefusal` for why the raw text
    // is not passed through.
    if (response.status === 400) throw new HttpError(400, friendlyRuleRefusal(session, detail));
    throw new HttpError(502, `Sunflower Land refused the request: ${detail}`);
  }

  return parsed.data ?? {};
}

/**
 * Turn a rule-engine refusal into something a player can act on.
 *
 * ## Why not pass the raw message through
 *
 * Sunflower Land names tokens by their internal key: `Insufficient 3`,
 * `Cannot own more than 1 Reward Attempt`, `Missing or invalid burn amount for 3`.
 * That is an implementation detail — `"3"` is the Reward Attempt voucher — and it
 * is not stable: the key is a database id that changes if the economy is ever
 * re-created, so copy written against it silently becomes wrong.
 *
 * It is also *worse than cosmetic* in one specific way. `Insufficient 5` tells a
 * cheater that token 5 is the thing standing between them and a coin, which is
 * precisely the information needed to script an attack against a known-good
 * sequence. The number costs nothing for us to hide and something for them to
 * learn.
 *
 * ## What is safe to pass through
 *
 * The part that says **what to do**, which the player needs and which leaks
 * nothing: "on cooldown", "daily cap", "already own one", "not enough". Those are
 * matched below and rewritten into the game's own copy. Anything unrecognised
 * falls back to a generic message rather than the raw string, because the default
 * has to be the one that reveals nothing — an unrecognised refusal should be
 * boring, not informative.
 *
 * `session` is the player's own session, used only to name a token the player can
 * already see in their own inventory.
 */
function friendlyRuleRefusal(session, detail) {
  const text = String(detail ?? "").toLowerCase();

  // "already at the cap for one" / "cannot own more than N <token>"
  if (/cannot own more than|already own|maximum of|too many/.test(text)) {
    return "You already have that. Finish what you are holding first.";
  }

  // "insufficient <token>" / "missing or invalid burn amount for <token>"
  if (/insufficient|missing or invalid|not enough/.test(text)) {
    const which = refusedTokenName(session, text);
    return which
      ? `You do not have ${which} right now.`
      : "You do not have what this needs yet.";
  }

  if (/cooldown/.test(text)) return "You have already done that today.";
  if (/daily cap|dailycap|cap exceeded/.test(text)) {
    return "You have already done that today.";
  }
  if (/supply|out of stock|exhaust/.test(text)) {
    return "This is all gone for now. Nothing left to claim.";
  }
  if (/unknown action|action not found/.test(text)) {
    return "That is not something this arcade can run right now.";
  }

  // Default: say nothing specific about the rule that refused.
  return "That could not be done right now. Try again in a moment.";
}

/**
 * Best-effort token name for a refusal, from the player's own session.
 *
 * The refusal text names the token by key, so the key is extracted and looked up
 * in `items`. Returns `undefined` when it cannot be resolved, and the caller then
 * says nothing specific — a wrong guess would be worse than no guess.
 */
function refusedTokenName(session, text) {
  if (!session) return undefined;

  // "Insufficient 3" / "... amount for 3"
  const match = /(?:insufficient|for|token)\s+"?([A-Za-z0-9_.-]+)"?\s*$/i.exec(text.trim());
  const key = match?.[1];
  if (!key) return undefined;

  const items = itemsOf(session);
  const item = asRecord(items[key]);
  const name = item?.name;
  if (typeof name === "string" && name.trim() !== "") {
    // Internal bookkeeping names are noise; the player-facing name is the point.
    return name.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/**
 * Take a daily entitlement, or refuse.
 *
 * The `INSERT` is the lock. If the slot is already taken the primary key rejects
 * it, and we never reach Sunflower Land — so a duplicate claim costs one cheap
 * D1 round trip and cannot mint anything.
 */
async function takeSlot(env, farmId, slot, day = utcDayKey()) {
  const now = Date.now();
  try {
    await env.LEDGER.prepare(
      `INSERT INTO daily_slots (farm_id, utc_day, slot, claimed_at) VALUES (?, ?, ?, ?)`,
    )
      .bind(farmId, day, slot, now)
      .run();
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/** Cloudflare reports a primary-key clash as `D1_ERROR: ... UNIQUE constraint failed`. */
function isUniqueViolation(error) {
  const text = String(error?.message ?? error ?? "").toLowerCase();
  return text.includes("unique constraint") || text.includes("constraint failed");
}

/**
 * Record that we are about to write, keyed on the client's nonce.
 *
 * Returns `false` when this nonce has been seen before, which is what makes a
 * double-tap, a client retry, or a replayed request harmless. Written *before*
 * the call so an ambiguous failure leaves evidence to reconcile against.
 */
async function beginAttempt(env, farmId, intent, nonce) {
  if (typeof nonce !== "string" || nonce.length < 8 || nonce.length > 64) return false;
  try {
    await env.LEDGER.prepare(
      `INSERT INTO attempts (id, farm_id, intent, state, created_at) VALUES (?, ?, ?, 'intent', ?)`,
    )
      .bind(nonce, farmId, intent, Date.now())
      .run();
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

async function settleAttempt(env, nonce, state, detail) {
  await env.LEDGER.prepare(
    `UPDATE attempts SET state = ?, detail = ?, settled_at = ? WHERE id = ?`,
  )
    .bind(state, detail ?? null, Date.now(), nonce)
    .run();
}

/**
 * Remember which cabinet the player's open run belongs to.
 *
 * ## Why the cabinet is recorded here and not taken from the claim
--
 * `Claim-Raven-Coin` does not name a cabinet, and adding the field to the claim
 * would not help: the browser picks it, so a player aiming at a verified cabinet
 * would simply declare an unverified one and fall back to the trusting route.
 * The binding has to be fixed at the moment the run is *opened* — a separate
 * request, made before any claim exists, whose answer the claim cannot rewrite.
 *
 * Written only after the economy call succeeds, so a refused open (no ticket, no
 * token) never leaves a row behind to be claimed against. `INSERT … ON CONFLICT
 * DO UPDATE` rather than a plain insert, because a player may open a second run
 * while the first is still unsettled and the newest open is the one the next
 * claim belongs to.
 */
async function recordActiveRun(env, farmId, cabinet) {
  await env.LEDGER.prepare(
    `INSERT INTO active_runs (farm_id, cabinet, opened_at) VALUES (?, ?, ?)
     ON CONFLICT(farm_id) DO UPDATE SET cabinet = excluded.cabinet, opened_at = excluded.opened_at`,
  )
    .bind(farmId, cabinet, Date.now())
    .run();
}

/**
 * The cabinet of the player's open run, or `null` when there is none.
 *
 * `null` is not the same as `""`: the arcade-wide allowance opens a run that
 * names no cabinet of its own, which is stored as `""`. A missing row means no
 * run was opened through this worker at all — which for a *verified* cabinet is
 * itself disqualifying, since the only way to hold a voucher is to have opened
 * one.
 */
async function readActiveRun(env, farmId) {
  const row = await env.LEDGER.prepare(
    `SELECT cabinet, opened_at FROM active_runs WHERE farm_id = ?`,
  )
    .bind(farmId)
    .first();
  // `opened_at` travels with the cabinet because it is the same fact — *which*
  // run is open — read at the same moment from the same row. Splitting it into
  // a second query would risk the two disagreeing if a run were opened between
  // them, and it is used as the identity of a parked replay, where a torn read
  // would resume one run's state against another run's inputs.
  return row ? { cabinet: row.cabinet, runKey: row.opened_at } : null;
}

/** Drop the binding once the run has been settled, so it cannot be reused. */
async function clearActiveRun(env, farmId) {
  await env.LEDGER.prepare(`DELETE FROM active_runs WHERE farm_id = ?`)
    .bind(farmId)
    .run();
}

/**
 * Store an unfinished replay so the next request can resume it.
 *
 * `MatchState` is plain data — numbers, strings, arrays of the same — so JSON
 * round-trips it exactly. That exactness is load-bearing: a resumed replay only
 * reproduces the client's run if the state comes back bit-identical, and any
 * value JSON cannot express (a `NaN`, an `Infinity`) would diverge silently
 * from the browser's run rather than visibly failing. The engine keeps none of
 * those in the simulation; the two `Math.random` sites that remain are confined
 * to `renderMatch`, which is never stepped here.
 *
 * The cursor travels beside the state rather than inside it, so the progress
 * read and the "is this finished" test do not have to parse the whole blob.
 */
async function writeReplayState(env, farmId, park) {
  await env.LEDGER.prepare(
    `INSERT INTO replay_state (farm_id, state, cursor, total, run_key, claim_score, cabinet, inputs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(farm_id) DO UPDATE SET
       state = excluded.state, cursor = excluded.cursor,
       total = excluded.total, run_key = excluded.run_key,
       claim_score = excluded.claim_score, cabinet = excluded.cabinet,
       inputs = excluded.inputs`,
  )
    .bind(
      farmId,
      JSON.stringify(park.state),
      park.cursor,
      park.total,
      park.runKey,
      park.claimScore ?? null,
      park.cabinet ?? null,
      park.inputs ?? null,
    )
    .run();
}

/**
 * The parked replay for a farm, or `null` when there is none.
 *
 * The `match` field is revived by `startReplay`'s caller rather than here,
 * because a parked row is only ever resumed — never created — by this path, and
 * keeping the revive beside the create keeps the two representations in step.
 */
async function readReplayState(env, farmId) {
  const row = await env.LEDGER.prepare(
    `SELECT state, cursor, total, run_key, claim_score, cabinet, inputs
       FROM replay_state WHERE farm_id = ?`,
  )
    .bind(farmId)
    .first();
  if (!row) return null;
  return {
    state: JSON.parse(row.state),
    cursor: row.cursor,
    total: row.total,
    runKey: row.run_key,
    claimScore: row.claim_score ?? null,
    cabinet: row.cabinet ?? null,
    inputs: row.inputs ?? null,
  };
}

/** Drop a replay once it has been judged, so it cannot be resumed twice. */
async function clearReplayState(env, farmId) {
  await env.LEDGER.prepare(`DELETE FROM replay_state WHERE farm_id = ?`)
    .bind(farmId)
    .run();
}

/**
 * Record a replay's verdict.
 *
 * Written even though the verdict does not yet decide the payout: Stage B is
 * shadow mode, where the checkpoints still pay and the replay only records
 * whether it agreed. That record is the entire point of the stage — a match
 * rate measured on real runs is the only way to learn whether replay is safe to
 * enforce before it starts refusing money. Tabled rather than logged because it
 * has to survive the isolate and be counted across players.
 *
 * `matched` is `null` for a replay that could not be completed at all, and
 * `false` for one that completed and disagreed. Collapsing the two would fill
 * the mismatch column with protocol errors — abandoned replays and malformed
 * logs — and the rate would measure the plumbing rather than the play.
 */
async function recordReplayVerdict(
  env,
  { farmId, cabinet, matched, replayScore, claimScore, reason },
) {
  await env.LEDGER.prepare(
    `INSERT INTO replay_verdicts
       (farm_id, cabinet, matched, replay_score, claim_score, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      farmId,
      cabinet,
      matched === null || matched === undefined ? null : matched ? 1 : 0,
      replayScore ?? null,
      claimScore ?? null,
      reason ?? null,
      Date.now(),
    )
    .run();
}

/**
 * Refund a slot we took but could not spend.
 *
 * Only for a failure we *know* was a refusal before anything moved. An ambiguous
 * failure deliberately keeps the slot: the alternative is a double free run when
 * the first one actually succeeded.
 */
async function releaseSlot(env, farmId, slot, day = utcDayKey()) {
  await env.LEDGER.prepare(
    `DELETE FROM daily_slots WHERE farm_id = ? AND utc_day = ? AND slot = ?`,
  )
    .bind(farmId, day, slot)
    .run();
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------

/**
 * Resolve which cabinet an action id refers to.
 *
 * The id is read, not trusted: it must match a cabinet this arcade actually
 * publishes, or the arcade-wide one. Returns `{ machine }` with `machine === null`
 * for the arcade-wide allowance.
 */
function cabinetForAction(actionId) {
  for (const prefix of [GRANT_PREFIX, START_FREE_PREFIX]) {
    if (!actionId.startsWith(prefix)) continue;
    const suffix = actionId.slice(prefix.length);
    if (suffix === ARCADE_SUFFIX) return { machine: null };
    for (const [machine, name] of Object.entries(CABINETS)) {
      if (name === suffix) return { machine };
    }
    return undefined; // a suffix we do not publish
  }
  return undefined;
}

/**
 * Grant a free run: one per cabinet for a VIP, one arcade-wide for everyone else.
 *
 * This is where the VIP rule becomes server-side. The browser no longer decides
 * which allowance it is owed — it says which cabinet it wants, and whether that
 * is allowed at all is answered here from the session's own `isVip`.
 */
function intentGrantFreeRun({ actionId, farmId, session, env, day }) {
  const cabinet = cabinetForAction(actionId);
  if (!cabinet) throw new HttpError(400, "Unknown cabinet.");

  const vip = isVip(session);

  if (cabinet.machine && !vip) {
    throw new HttpError(
      403,
      "A free run on an individual machine is a VIP perk. Use a Play Ticket to play this one.",
    );
  }

  // A VIP is refused the arcade-wide allowance, mirroring `resolveFreeRunEntitlement`
  // on the client. Without this, a VIP could ask for it directly and get a token
  // the game never requests for them — one extra free run a day, on top of the one
  // per cabinet they are already entitled to. The client's reasoning is the reason
  // to copy it verbatim: the arcade-wide token is the *non-VIP* allowance, and a VIP
  // reaching it is a free run on every cabinet that has not published its own pair.
  if (!cabinet.machine && vip) {
    throw new HttpError(
      403,
      "You already get a free run on every machine. The once-a-day arcade allowance is for everyone else.",
    );
  }

  const slot = cabinet.machine ? `machine:${cabinet.machine}` : "free";

  // Whether *this* request took the slot.
  //
  // Load-bearing. Without it the refusal path below refunds a slot it never took,
  // so a player could send the same claim twice: the first takes it, the second
  // is refused — and refunds the first. That is a free-run bypass, so the flag
  // and the `undo` guard are written together below.
  let tookSlot = false;

  return {
    async run() {
      if (!(await takeSlot(env, farmId, slot, day))) {
        throw new HttpError(
          409,
          cabinet.machine
            ? "You have already used today's free run on this machine."
            : "You have already used today's free run.",
        );
      }
      tookSlot = true;
      return callEconomy(env, session, {
        type: "minigame.action",
        action: actionId,
        amounts: rangedAmounts(session, actionId, freeRunTokenKey(session, suffixOf(actionId))),
      });
    },
    async undo() {
      // Only ever refund our own claim. `releaseSlot` deletes by
      // (farm, day, slot), so an unguarded call here would delete the *other*
      // request's slot and hand the player a second free run.
      if (!tookSlot) return;
      await releaseSlot(env, farmId, slot, day);
    },
  };
}

/** The economy name suffix an action id ends with, e.g. `Grant-Free-Run-Poker` -> `Poker`. */
function suffixOf(actionId) {
  const suffix = actionId.slice(GRANT_PREFIX.length);
  return suffix === ARCADE_SUFFIX ? ARCADE_SUFFIX : suffix;
}

/**
 * `amounts` for a ranged mint **or burn**, or `undefined` for a fixed one.
 *
 * Checks both `mint` and `burn`, because a rule can be ranged on either side:
 * `Void-Reward-Attempt` publishes `{ "burn": { "3": { "min": 1, "max": 1000 } } }`
 * with no mint at all, and sending no amount for it is refused by the API as
 * `Missing or invalid burn amount for 3`.
 *
 * Only ever the token's own rule, read from the published action. The number
 * comes from the rule's `min`, never from the request, so a client cannot widen
 * a ranged mint by asking nicely.
 */
function rangedAmounts(session, actionId, tokenKey, preferred = 1) {
  const action = asRecord(asRecord(session?.actions)?.[actionId]);
  const rule =
    asRecord(asRecord(action?.mint)?.[tokenKey]) ??
    asRecord(asRecord(action?.burn)?.[tokenKey]);
  if (!rule) return undefined;
  if (typeof rule.amount === "number") return undefined; // fixed: no amounts needed

  const min = typeof rule.min === "number" ? rule.min : 1;
  const max = typeof rule.max === "number" ? rule.max : Number.NaN;
  if (!Number.isFinite(max)) return undefined;

  const wanted = Math.max(min, Math.min(Math.trunc(preferred), max));
  return { [tokenKey]: wanted };
}

/** Open a free run: burns the cabinet's token, mints the reward-attempt voucher. */
function intentStartFreeRun({ actionId, farmId, session, env, payload }) {
  const cabinet = cabinetForAction(actionId);
  if (!cabinet) throw new HttpError(400, "Unknown cabinet.");

  const tokenKey = freeRunTokenKey(session, suffixOf(actionId));
  if (!tokenKey) {
    throw new HttpError(400, "This cabinet has no Free Run Token published.");
  }

  // A VIP's run-open names its cabinet in the action id, so the server already
  // knows it and takes it as authoritative. The **arcade-wide** open does not —
  // it is one allowance covering every machine, so the action id says only
  // "arcade" while the player is in fact sitting at a particular cabinet. That
  // one has to be declared, and it is validated against the published list so a
  // made-up id cannot become a binding.
  //
  // A declared cabinet cannot be used to shop for a laxer rule set: the binding
  // only decides which verifier the later claim must pass, and the claim has to
  // match it. Naming a cabinet you did not play means producing that cabinet's
  // checkpoints, which is the check itself.
  const declared = typeof payload?.cabinet === "string" ? payload.cabinet : "";
  const openedOn = cabinet.machine ?? declared;
  if (!Object.prototype.hasOwnProperty.call(CABINETS, openedOn)) {
    throw new HttpError(400, "Unknown cabinet.");
  }

  return {
    async run() {
      // No ledger slot: the token is spent by the burn itself, and `max: 1` on
      // the token means absence *is* the signal that the allowance is gone.
      const data = await callEconomy(env, session, {
        type: "minigame.action",
        action: actionId,
        amounts: rangedAmounts(session, actionId, tokenKey),
      });
      await recordActiveRun(env, farmId, openedOn);
      return data;
    },
  };
}

/**
 * Open a ticket-funded run: burns one Play Ticket, mints the voucher.
 *
 * The cabinet is required. A ticket run pays out the same coin as any other, but
 * the claim that follows has to be checked against the rules of the machine it
 * was played on, and the only moment that machine is knowable is now — the
 * browser says which cabinet it is opening, and that answer is fixed to the
 * farm from here on. Without it, a player on a verified cabinet could open the
 * run, then claim through the trusting route by naming a machine that has not
 * adopted verification.
 */
function intentStartTicketRun({ farmId, session, env, payload }) {
  const cabinetId = typeof payload?.cabinet === "string" ? payload.cabinet : "";
  if (!Object.prototype.hasOwnProperty.call(CABINETS, cabinetId)) {
    throw new HttpError(400, "Unknown cabinet.");
  }

  const tokenKey = playTicketKey(session);
  return {
    async run() {
      const data = await callEconomy(env, session, {
        type: "minigame.action",
        action: "Start-Ticket-Run",
        amounts: rangedAmounts(session, "Start-Ticket-Run", tokenKey),
      });
      await recordActiveRun(env, farmId, cabinetId);
      return data;
    },
  };
}

/**
 * A win: burns the voucher, mints the Raven Coin.
 *
 * ## Why this route is now fenced
--
 * This intent trusts the caller: it mints the moment it is asked, on nothing
 * more than the fact that a voucher exists. That was acceptable while a voucher
 * could only be obtained by playing, but it is precisely the shape a cheater
 * forges — open a run, send `claim-result` directly, collect the coin.
 *
 * `claim-verified` exists so a cabinet can require proof instead. If this route
 * stayed open to everyone, it would be the bypass that undoes it: a player on a
 * verified cabinet would send `claim-result` by name and skip verification
 * entirely. So the claim's own `cabinet` field is worthless — the browser picks
 * it — and the fence is instead drawn against the cabinet the run was *opened*
 * on, which was fixed in a separate request before this one existed.
 *
 * A verified cabinet's run therefore cannot be paid here at all. The other
 * cabinets are unaffected: they have not adopted verification, so their runs
 * still settle on the caller's word, exactly as before.
 */
async function intentClaimResult({ session, env, farmId }) {
  const tokenKey = rewardAttemptKey(session);

  // Read in the factory rather than in `run`, because the answer decides whether
  // the claim is allowed at all — a refusal has to land in the validation phase,
  // where nothing has been written yet. `handleEconomyWrite` awaits this factory
  // for exactly that reason.
  const openedOn = await readActiveRun(env, farmId);
  const openedCabinet = openedOn?.cabinet ?? null;
  if (openedCabinet !== null && VERIFIED_CABINETS[openedCabinet]) {
    throw new HttpError(
      400,
      "That cabinet certifies its runs. Claim it through the verified route instead.",
    );
  }

  return {
    async run() {
      // The run has been settled by paying out, so its cabinet binding goes with
      // it — leaving it would let the *next* run inherit this one's machine.
      const data = await callEconomy(env, session, {
        type: "minigame.action",
        action: "Claim-Raven-Coin",
        amounts: rangedAmounts(session, "Claim-Raven-Coin", tokenKey),
      });
      await clearActiveRun(env, farmId);
      return data;
    },
  };
}

/**
 * Advance a claim's replay by one chunk, parking it if more ticks remain.
 *
 * Called with the run already opened and the checkpoints already accepted, so
 * this is the last gate before minting. It never throws: a replay that cannot
 * start, cannot resume or runs out of budget produces a *recorded non-match*
 * rather than an error, because the alternative is a player being refused a
 * coin they fairly earned because verification was unavailable. Stage B is
 * shadow mode — the checkpoints still pay — so the honest outcome is always
 * "pay, and note what the replay said".
 *
 * The returned verdict is `{ matched, reason }` with `matched` tri-state:
 * `true` (replayed to the claimed outcome), `false` (completed and disagreed),
 * or `null` (could not be completed — rejected input, exhaustion, or a
 * throw). The caller records it and pays regardless; Stage C is where `false`
 * starts refusing.
 *
 * @param {object} args
 * @param {object} args.env      D1 and KV bindings.
 * @param {number} args.farmId   The claiming farm.
 * @param {object} args.payload  The claim body, whose `replay` field drives it.
 * @param {string} args.cabinet  The cabinet the run was opened on, for the record.
 * @param {number} args.claimScore The score the claim asserts, kept beside the
 *                                 replayed one so a mismatch is a diff rather
 *                                 than an assertion.
 * @returns {Promise<{ matched: boolean|null, reason: string|null }>}
 */
async function runReplayVerification({ env, farmId, payload, cabinet, claimScore, runKey }) {
  // Validation runs on every request, resumed or not: it is what binds the
  // parked state to *this* claim's inputs. Construction runs on the first chunk
  // only, because a resumed replay already holds the match it was stepping and
  // building another would spend the cold-start cost to immediately discard it.
  let validated;
  try {
    validated = validateReplay(payload?.replay);
  } catch (error) {
    // A malformed submission is not evidence of anything — it says the client
    // and worker disagree about the protocol, or that someone is probing. Either
    // way it must not count as a mismatch, or protocol noise would drown the
    // signal Stage B exists to measure.
    const reason =
      error instanceof ReplayInputError ? error.message : "the replay could not be started";
    await recordReplayVerdict(env, { farmId, cabinet, matched: null, claimScore, reason });
    return { matched: null, reason };
  }

  // Resumed rather than restarted when a previous request already parked this
  // claim's replay. Re-stepping from tick zero would spend the budget on work
  // that is already done and exhaust the request before it reaches the end.
  //
  // The run key is what makes the resume safe. A claim that never finished
  // verifying leaves its state parked, and the *next* claim must not inherit a
  // cursor from a different run — so a park only resumes when it names this
  // run, and any stale row falls through to a fresh start and is overwritten.
  // `cabinet` is compared beside it as belt-and-braces: implied by the run key
  // since one run plays one cabinet, but the failure it guards against —
  // resuming a replay under a different cabinet's rule set — is worth one more
  // comparison.
  const parked = await readReplayState(env, farmId);
  let state;
  if (
    parked &&
    parked.runKey === runKey &&
    parked.cabinet === cabinet &&
    parked.total === validated.total
  ) {
    state = {
      match: parked.state,
      inputs: validated.inputs,
      cursor: parked.cursor,
      total: parked.total,
    };
  } else {
    state = startReplay(payload.replay);
  }

  try {
    stepReplay(state, CHUNK_TICKS);

    if (!isReplayComplete(state)) {
      // Out of request budget, not out of replay. Park the match exactly as it
      // stands and let the next request pick it up — this is the chunked
      // continuation the 10 ms budget forces, and the reason `replay_state`
      // carries a cursor rather than a whole log.
      await writeReplayState(env, farmId, {
        state: state.match,
        cursor: state.cursor,
        total: state.total,
        runKey,
        claimScore,
        cabinet,
        // The log itself, base64, exactly as validated above. Parked rather
        // than left for the continuation to resend: the continuation is sent
        // only its intent, so the inputs it steps are necessarily the ones this
        // claim submitted and the worker decoded — see `resumeReplay`.
        inputs: String(payload.replay.inputs),
      });
      await recordReplayVerdict(env, {
        farmId,
        cabinet,
        matched: null,
        replayScore: state.match.score,
        claimScore,
        reason: `replay still in progress at ${state.cursor} of ${state.total} ticks`,
      });
      return { matched: null, reason: "replay in progress" };
    }

    await clearReplayState(env, farmId);

    // The comparison is deliberately narrow. `score` is the number the coin is
    // minted against, and `reachedFinale` is the event it is minted for — those
    // two together are the claim. Wave, health, magic and lives are *not*
    // compared, because replaying to the same score by a different route is
    // still a legitimately played run, and demanding identity on every field
    // would refuse honest players whose play simply differed from the replay's
    // tie-breaks. Same score, same win: that is the claim, and that is checked.
    const outcome = replayOutcome(state);
    const matched = outcome.score === claimScore && outcome.reachedFinale === true;

    await recordReplayVerdict(env, {
      farmId,
      cabinet,
      matched,
      replayScore: outcome.score,
      claimScore,
      reason: matched
        ? null
        : `replay produced score ${outcome.score}` +
          `${outcome.reachedFinale ? "" : " without reaching the finale"}` +
          ` for a claim of ${claimScore}`,
    });

    return {
      matched,
      reason: matched
        ? null
        : `the re-simulated run scored ${outcome.score}, not ${claimScore}`,
    };
  } catch (error) {
    // A throw mid-replay is a defect in the worker, not in the player. Recording
    // it as "could not complete" keeps it out of the mismatch column — counting
    // our own crashes as suspected cheating would corrupt every rate derived
    // from this table.
    await recordReplayVerdict(env, {
      farmId,
      cabinet,
      matched: null,
      claimScore,
      reason: `the replay threw: ${String(error?.message ?? error).slice(0, 200)}`,
    });
    return { matched: null, reason: "the replay could not be completed" };
  }
}

/**
 * A win that has to prove it first.
 *
 * `claim-result` trusts the caller's word: it burns the voucher and mints the
 * coin the moment it is asked. That is fine for an owner-sent grant, but it is
 * exactly the shape a cheater forges — a direct `POST /economy/write` with
 * `intent: "claim-result"` and no game ever played. This intent is the hardened
 * path: before it will mint, the caller must submit the run's **checkpoints**
 * (wave, score, health, magic, lives, elapsed time at each milestone), and the
 * shared verifier must judge that outcome *reachable* by a legitimate run.
 *
 * Verification runs in `build`, not `run`, so a refused claim never touches the
 * economy — the throw lands in `handleEconomyWrite`'s validation catch, which
 * settles the nonce as `failed` and returns the reason to the player. See
 * `shared/anticheat/verify.js` for the exact invariants (monotonic score within
 * a derived ceiling, legal one-wave-at-a-time progression, resources in range,
 * a physically possible pace).
 *
 * The score and cabinet are read from the same request as the checkpoints and
 * cross-checked by the verifier — the claimed score must equal the final
 * checkpoint's, so a caller cannot submit an honest-looking log alongside an
 * inflated number.
 */
async function intentClaimVerified({ session, env, payload, farmId }) {
  const tokenKey = rewardAttemptKey(session);
  const cabinetId = typeof payload?.cabinet === "string" ? payload.cabinet : "";
  const rules = VERIFIED_CABINETS[cabinetId];
  if (!rules) {
    throw new HttpError(400, "That cabinet is not verified yet.");
  }

  // The claim has to name the cabinet the run was **opened** on, read from the
  // ledger rather than from this request.
  //
  // Checkpoints for a cabinet nobody played are worthless however plausible they
  // look, and this is the one field a caller cannot choose freely: the binding
  // was written when the run opened, in a request this one cannot alter. A
  // mismatch means the log was assembled for a different machine than the
  // voucher was minted on, and is refused outright.
  const openedOn = await readActiveRun(env, farmId);
  if (openedOn === null || openedOn.cabinet !== cabinetId) {
    throw new HttpError(
      400,
      openedOn === null
        ? "No run is open on that cabinet. Start one before claiming."
        : "That run was opened on a different cabinet.",
    );
  }

  const checkpoints = Array.isArray(payload?.checkpoints)
    ? payload.checkpoints
    : [];
  const elapsedMs = Number(payload?.elapsedMs);
  const claimedScore = Number(payload?.score);

  const verdict = verifyCheckpoints({
    checkpoints,
    rules,
    claimedScore,
    claimedWin: true,
    elapsedMs,
  });
  if (!verdict.ok) {
    throw new HttpError(
      400,
      `That run could not be verified: ${verdict.reason ?? "unknown reason"}`,
    );
  }

  // Replayed in `build`, not `run`, for the same reason the checkpoints are:
  // this is a gate, and a gate that only closed after the mint would have
  // already paid. It sits *after* the checkpoint check so the cheap structural
  // invariants reject a forgery before any simulation budget is spent — there
  // is no reason to re-simulate a log whose waves are out of order.
  //
  // Deliberately not awaited into a throw: `runReplayVerification` reports what
  // the replay said rather than deciding anything, because Stage B is shadow
  // mode. `matched === false` does not refuse the claim yet — that flip is
  // Stage C, and it must come with a server-issued seed, since a client-chosen
  // seed lets a cheater shop for one the replay cannot reproduce.
  const replayVerdict = await runReplayVerification({
    env,
    farmId,
    payload,
    cabinet: cabinetId,
    claimScore: claimedScore,
    runKey: openedOn.runKey,
  });

  return {
    // Surfaced so a player whose claim was refused can tell which gate refused
    // it, and so the shadow-mode record is visible in the field rather than
    // only in the ledger. Additive: callers that ignore it are unaffected.
    verification: {
      checkpoints: "passed",
      replay: replayVerdict.matched,
      ...(replayVerdict.reason ? { replayReason: replayVerdict.reason } : {}),
    },
    async run() {
      const data = await callEconomy(env, session, {
        type: "minigame.action",
        action: "Claim-Raven-Coin",
        amounts: rangedAmounts(session, "Claim-Raven-Coin", tokenKey),
      });
      await clearActiveRun(env, farmId);
      return data;
    },
  };
}

/**
 * Drive a parked replay forward by one more chunk.
 *
 * The claim cannot fit a whole replay in one request — a run to the finale is
 * ~10,000 ticks and a Worker gets 10 ms of CPU per call — so the first claim
 * parks the match mid-replay and this intent advances it. The client keeps
 * calling it while the response says "in progress"; each call steps another
 * `CHUNK_TICKS` and parks again, and the call that finishes records the
 * verdict and drops the park.
 *
 * ## What it is allowed to touch
 *
 * Only the parked replay belonging to *this* farm and *this* run. Both checks
 * are read from the ledger rather than taken from the request: the park is
 * keyed by farm, and the run identity is `active_runs.opened_at`, which no
 * later request can rewrite. A continuation for a run that is not open, or a
 * park written by a different run, is refused rather than resumed.
 *
 * ## What it may not do
 *
 * It never touches the economy. By the time it runs, the claim has already been
 * paid or refused — this advances a *replay*, which in Stage B only records
 * whether it agreed. So it holds no voucher, mints nothing and burns nothing,
 * and there is nothing to refund: a continuation that fails costs a delayed
 * verdict and nothing else.
 */
async function intentContinueVerification({ env, farmId }) {
  // Bound to the park, not to an open run. The claim that started this replay
  // settles the run as it pays — `clearActiveRun` — so by the time the first
  // continuation arrives there is no open run to name, and requiring one would
  // make this intent unreachable by construction.
  //
  // The park is keyed by farm and already carries the run key written under
  // `claim-verified`, so it names its own run. What that buys is expiry against
  // the *next* claim: a fresh claim overwrites the row with a new run key, so a
  // continuation left over from the previous run finds a key that is no longer
  // its own and is refused rather than stepping someone else's match.
  const parked = await readReplayState(env, farmId);
  if (parked === null) {
    // No park means the replay already finished and recorded its verdict, or
    // its claim never started one. Either way there is nothing to advance.
    throw new HttpError(400, "There is no replay in progress for this run.");
  }

  // The claim body is not resent: the parked row *is* the claim's replay, down
  // to the validated log it stepped with, so `resumeReplay` decodes those exact
  // bytes rather than trusting whatever this request might have carried. It
  // also re-checks that the log still describes `total` ticks — a row that was
  // truncated or overwritten fails here, as a recorded non-match, instead of
  // dereferencing a missing input mid-step.
  let replay;
  try {
    replay = resumeReplay(parked);
  } catch (error) {
    const reason =
      error instanceof ReplayInputError ? error.message : "the parked replay could not be resumed";
    await clearReplayState(env, farmId);
    await recordReplayVerdict(env, {
      farmId,
      cabinet: parked.cabinet,
      matched: null,
      claimScore: parked.claimScore,
      reason,
    });
    throw new HttpError(400, `That run's replay could not be resumed: ${reason}`);
  }

  stepReplay(replay, CHUNK_TICKS);

  if (!isReplayComplete(replay)) {
    await writeReplayState(env, farmId, {
      state: replay.match,
      cursor: replay.cursor,
      total: replay.total,
      runKey: parked.runKey,
      claimScore: parked.claimScore,
      cabinet: parked.cabinet,
      // Re-parked unchanged. The log is not re-derived: it is the same bytes
      // `resumeReplay` just decoded, and re-encoding here could only introduce
      // a difference between what was stepped and what the next chunk steps.
      inputs: parked.inputs,
    });
    return {
      verification: {
        checkpoints: "passed",
        replay: null,
        replayProgress: `${replay.cursor} of ${replay.total} ticks`,
        replayReason: "replay in progress",
      },
      async run() {
        return { continued: true, complete: false };
      },
    };
  }

  await clearReplayState(env, farmId);

  // The comparison is deliberately narrow. `score` is the number the coin is
  // minted against, and `reachedFinale` is the event it is minted for — those
  // two together are the claim. Wave, health, magic and lives are *not*
  // compared, because replaying to the same score by a different route is
  // still a legitimately played run, and demanding identity on every field
  // would refuse honest players whose play simply differed from the replay's
  // tie-breaks. Same score, same win: that is the claim, and that is checked.
  const outcome = replayOutcome(replay);
  const matched =
    outcome.score === parked.claimScore && outcome.reachedFinale === true;

  await recordReplayVerdict(env, {
    farmId,
    cabinet: parked.cabinet,
    matched,
    replayScore: outcome.score,
    claimScore: parked.claimScore,
    reason: matched
      ? null
      : `replay produced score ${outcome.score} and reachedFinale=${outcome.reachedFinale}, ` +
        `against a claim of ${parked.claimScore}`,
  });

  return {
    verification: {
      checkpoints: "passed",
      // The real verdict, not a placeholder: this is the number the client's
      // loop stops on, and in Stage C it is the number that will decide the
      // payout. Reporting null here would make a finished replay
      // indistinguishable from one that never produced one.
      replay: matched,
      replayReason: matched
        ? `replay agreed at ${outcome.score}`
        : `replay produced score ${outcome.score} and reachedFinale=${outcome.reachedFinale}, ` +
          `against a claim of ${parked.claimScore}`,
    },
    async run() {
      return { continued: true, complete: true };
    },
  };
}

/** A loss, a walk-out, or a refresh: burns the voucher, mints nothing. */
function intentVoidAttempt({ session, env, farmId }) {
  const tokenKey = rewardAttemptKey(session);
  return {
    async run() {
      // A voided run is still a *settled* one: its voucher is burned, so its
      // cabinet binding must not survive to be inherited by the next run.
      const data = await callEconomy(env, session, {
        type: "minigame.action",
        action: "Void-Reward-Attempt",
        amounts: rangedAmounts(session, "Void-Reward-Attempt", tokenKey),
      });
      await clearActiveRun(env, farmId);
      return data;
    },
  };
}

/**
 * The entryway chest's daily ticket.
 *
 * The ledger slot is a courtesy: the real cap is the `cooldownSeconds` on the
 * action and the `supply` on `chest_click_tracker`, both enforced by Sunflower
 * Land inside the same atomic mint. This only stops a same-day duplicate from
 * costing a round trip.
 */
function intentClaimPlayTicket({ farmId, session, env, day }) {
  let tookSlot = false;

  return {
    async run() {
      if (!(await takeSlot(env, farmId, "chest", day))) {
        throw new HttpError(409, "You have already claimed a chest ticket today.");
      }
      tookSlot = true;
      return callEconomy(env, session, {
        type: "minigame.action",
        action: "Claim-Play-Ticket",
        amounts: chestAmounts(session),
      });
    },
    async undo() {
      // See `intentGrantFreeRun`: refunding a slot we did not take would undo the
      // legitimate claim that beat us to it.
      if (!tookSlot) return;
      await releaseSlot(env, farmId, "chest", day);
    },
  };
}

/**
 * `amounts` for the chest claim.
 *
 * The Play Ticket is a ranged rule so the caller must name an amount; the tracker
 * beside it is fixed, and a fixed rule takes none. Both are derived from the
 * published action, never from the request.
 */
function chestAmounts(session) {
  return rangedAmounts(session, "Claim-Play-Ticket", playTicketKey(session));
}

/**
 * A shop purchase.
 *
 * The one intent that carries an id, so the id is checked twice: it must match the
 * arcade's `buy_*` naming, *and* the economy must publish it as a shop rule.
 * Anything else is refused, which is what stops this becoming a back door to the
 * uncapped `Dev-Mint-Play-Ticket` or the `Payout-*` buttons.
 */
function intentBuyItem({ actionId, session, env, isDev }) {
  if (typeof actionId !== "string" || !BUY_ACTION_RE.test(actionId)) {
    throw new HttpError(400, "That is not something this arcade sells.");
  }
  if (actionId === "buy_dev_mint_play_ticket" || actionId.startsWith("buy_dev")) {
    throw new HttpError(403, "That is not for sale.");
  }

  const action = asRecord(asRecord(session?.actions)?.[actionId]);
  if (!action || action.type !== "shop") {
    throw new HttpError(400, "That is not something this arcade sells.");
  }

  const mintedKey = Object.keys(asRecord(action.mint) ?? {})[0];
  if (!mintedKey) throw new HttpError(400, "That shop item is not published.");

  return {
    async run() {
      return callEconomy(env, session, {
        type: "minigame.action",
        action: actionId,
        amounts: rangedAmounts(session, actionId, mintedKey),
      });
    },
  };
}

/** The owner's uncapped Play Ticket mint. Dev Key required. */
function intentDevMintTickets({ amount, session, env, isDev }) {
  if (!isDev) throw new HttpError(403, "This action is limited to the arcade owner.");

  const wanted = Number.isFinite(amount) ? Math.trunc(amount) : 1;
  const capped = Math.max(1, Math.min(wanted, 10000));

  return {
    async run() {
      return callEconomy(env, session, {
        type: "minigame.action",
        action: "Dev-Mint-Play-Ticket",
        amounts: rangedAmounts(session, "Dev-Mint-Play-Ticket", playTicketKey(session), capped),
      });
    },
  };
}

/**
 * A leaderboard score.
 *
 * Not a mint, so nothing here is rationed — but it is a write, so it needs the
 * key, and it is the one thing a player most obviously wants to inflate. It is
 * clamped to a sane range and recorded, so a leaderboard built on it is at least
 * reading something bounded.
 */
function intentSubmitScore({ score, session, env }) {
  const raw = Number(score);
  const value = Number.isFinite(raw) ? Math.max(0, Math.min(Math.trunc(raw), 100_000_000)) : 0;
  return {
    async run() {
      return callEconomy(env, session, { type: "score.submitted", score: value });
    },
  };
}

/**
 * Verification rules for the cabinets that mint through a checked claim.
 *
 * Keyed by the registry id the client already uses as its `cabinet` field. A
 * cabinet absent from this table simply cannot be claimed via `claim-verified`
 * — that is the default for a new game, so forgetting to add one fails closed
 * (the claim is refused) rather than open.
 *
 * ## Where these numbers come from
 *
 * **`maxScoreByWave` is not written by hand — it is computed.** `scoreRules.js`
 * imports the client's own `WAVES` table and derives the exact maximum score
 * after each wave from the enemy scores, the per-wave clear bonus and the
 * finale bonus, plus an explicit allowance for the two sources that cannot be
 * computed (ambushes during the walks, and pickups). The result is the precise
 * curve the engine enforces, so it cannot drift when someone tunes a balance
 * number — the import pulls the change straight through.
 *
 * The rest are read off the engine's constants:
 *
 *  - **`maxHp`** — the highest champion's health. Pickups heal with
 *    `Math.min(player.maxHp, …)`, so no honest run ever reports more.
 *  - **`maxMagic` / `maxLives`** — `MAGIC_MAX` and `MAX_LIVES`.
 *  - **`minMsPerWave`** — a physical floor, not a skill gate, set from the
 *    engine's own fixed timers (intro, wave-intro, wave-clear, the walk between
 *    waves) plus a beat of actual fighting. A bot that clears fifteen waves in
 *    four seconds is caught here, before the score is even considered.
 */
const VERIFIED_CABINETS = {
  "sunflower-brawler": {
    maxWave: 15,
    maxScoreByWave: MAX_SCORE_BY_WAVE,
    // Present because the type requires it; the table above always wins.
    maxScoreCeiling: MAX_RUN_SCORE,
    maxHp: 120, // highest champion maxHp; pickups cap at maxHp
    maxMagic: 100, // MAGIC_MAX
    maxLives: 3, // MAX_LIVES
    minMsPerWave: 4_000,
    finaleWave: 15,
  },
};

const INTENTS = {
  "grant-free-run": intentGrantFreeRun,
  "start-free-run": intentStartFreeRun,
  "start-ticket-run": intentStartTicketRun,
  "claim-result": intentClaimResult,
  "claim-verified": intentClaimVerified,
  "continue-verification": intentContinueVerification,
  "void-attempt": intentVoidAttempt,
  "claim-play-ticket": intentClaimPlayTicket,
  "buy-item": intentBuyItem,
  "dev-mint-tickets": intentDevMintTickets,
  "submit-score": intentSubmitScore,
};

/**
 * `POST /economy/write` — the only way anything moves in this economy.
 *
 * Order matters and is deliberate:
 *
 *   1. `identify` — Sunflower Land has to accept the token. A forged JWT fails
 *      here, so it can never reach the ledger and cannot burn a victim's daily
 *      slot.
 *   2. session — only for the intents that need it, which is most of the latency
 *      saved. The others let the economy's own burns be the balance authority.
 *   3. `beginAttempt` — the nonce is claimed *before* the write, so a retry or a
 *      double-tap cannot run it twice.
 *   4. the intent's `run()`.
 *
 * A slot taken by step 4 is refunded only when the failure is known to have
 * happened before anything moved. An ambiguous timeout keeps it, because the
 * cost of keeping one is a missed run and the cost of releasing one is a double
 * free run.
 */
async function handleEconomyWrite(request, env, headers) {
  const { token, identity, session, isDev } = await authenticate(request, env);

  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }

  const intent = typeof payload?.intent === "string" ? payload.intent : "";
  const build = INTENTS[intent];
  if (!build) {
    throw new HttpError(400, "Unknown intent. This worker only runs a fixed list.");
  }

  const day = utcDayKey();
  const nonce = typeof payload?.nonce === "string" ? payload.nonce.trim() : "";

  // Validate the nonce *before* touching the ledger, so a malformed one is a clear
  // 400 rather than being conflated with a replay.
  if (nonce.length < 8 || nonce.length > 64) {
    throw new HttpError(400, "Missing request id. Reload the arcade and try again.");
  }

  // The primary key on `attempts.id` is what makes a double-tap, a client retry or
  // a replayed request harmless: the second one loses here and never reaches the
  // API. Checked *before* the write, so an interrupted first attempt leaves
  // evidence to reconcile against rather than a silent gap.
  const fresh = await beginAttempt(env, identity.farmId, intent, nonce);
  if (!fresh) {
    throw new HttpError(409, "That request was already processed.");
  }

  // `authenticate` already loaded the session to answer "is this the owner?", and
  // every intent needs it: to derive amounts from the published rules, and to
  // resolve item names to the numeric keys this hosted economy uses. The token is
  // grafted on because the intents make the call on the player's behalf.
  let plan;
  try {
    // Awaited because a build may need to read the ledger before it can decide
    // whether the claim is allowed at all — the verified/verified-adjacent
    // intents ask which cabinet the open run belongs to. A synchronous intent is
    // unaffected by the await.
    plan = await build({
      actionId: payload?.actionId,
      amount: payload?.amount,
      score: payload?.score,
      // The whole body, for the intents that read fields of their own (the
      // verified claim reads `cabinet`, `checkpoints`, `elapsedMs`). Intents
      // that ignore it are unaffected.
      payload,
      farmId: identity.farmId,
      session: { ...session, token },
      env,
      isDev,
      day,
    });
  } catch (error) {
    // The intent refused during validation, before any write was attempted.
    // Closing the record here is what keeps the ledger honest: an intent that
    // never reaches `run()` has still consumed its nonce, so leaving the row in
    // `intent` would look exactly like an interrupted request that may or may not
    // have minted — the one state this table exists to make unambiguous.
    await settleAttempt(env, nonce, "failed", String(error?.message ?? error).slice(0, 300));
    throw error;
  }

  try {
    const data = await plan.run();
    await settleAttempt(env, nonce, "settled", intent);
    // The envelope is byte-compatible with the economies API's own, so the game's
    // existing response handling needs no changes.
    //
    // `verification` is additive and optional: only `claim-verified` produces
    // it. It rides beside `data` rather than inside it precisely so the
    // compatibility above holds — a caller that reads `data` as the economies
    // API's own shape never sees it, and one that wants the verdict can opt in.
    return json(
      plan.verification ? { data, verification: plan.verification } : { data },
      200,
      headers,
    );
  } catch (error) {
    // Refund the ledger slot only on a **definitive** refusal — a 400 from the
    // rule engine, which means a rule said no and nothing was written.
    //
    // Never on a 5xx, a network failure or a timeout: those are exactly the
    // cases where the write may still have landed, and releasing then would hand
    // the player a second allowance for a run that already counted. A lost slot
    // costs one run today; a wrongly released one costs an unbounded supply of
    // coins. Each intent's `undo` also refuses to release a slot this request did
    // not take, so a duplicate claim cannot refund the original.
    const refused = error instanceof HttpError && error.status === 400;
    if (refused && plan.undo) await plan.undo();
    await settleAttempt(env, nonce, "failed", String(error?.message ?? error).slice(0, 300));
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const { headers, allowed } = corsHeaders(request, env);

    if (!allowed) {
      return json({ error: "Origin not allowed." }, 403, headers);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (request.method === "GET" && path === "/whoami") {
        return await handleWhoami(request, env, headers);
      }
      if (request.method === "POST" && path === "/requests") {
        return await handleCreate(request, env, headers);
      }
      if (request.method === "GET" && path === "/requests") {
        return await handleList(request, env, headers);
      }
      if (request.method === "GET" && path === "/requests/mine") {
        return await handleMine(request, env, headers);
      }
      if (request.method === "POST" && path === "/requests/claim") {
        return await handleClaim(request, env, headers);
      }
      if (request.method === "DELETE" && path.startsWith("/requests/")) {
        const rest = path.slice("/requests/".length);
        // `/requests/:id/history` removes a settled row from the owner's history;
        // a bare `/requests/:id` cancels an unclaimed grant. Checked before the
        // bare form so the history route is not swallowed by the prefix match.
        if (rest.endsWith("/history")) {
          return await handleForgetHistory(
            request,
            env,
            headers,
            rest.slice(0, -"/history".length),
          );
        }
        return await handleCancel(request, env, headers, rest);
      }

      if (request.method === "GET" && path === "/chest") {
        return await handleChestState(request, env, headers);
      }
      if (request.method === "POST" && path === "/chest/tickets") {
        return await handleChestTicket(request, env, headers);
      }
      if (request.method === "POST" && path === "/chest/reset") {
        return await handleChestReset(request, env, headers);
      }

      if (request.method === "POST" && path === "/dev-key/bootstrap") {
        return await bootstrapDevKey(request, env, headers);
      }

      if (request.method === "POST" && path === "/economy/write") {
        return await handleEconomyWrite(request, env, headers);
      }

      return json(
        { error: "Not found.", routes: ["GET /whoami", "POST /requests", "GET /requests", "GET /requests/mine", "POST /requests/claim", "DELETE /requests/:id", "GET /chest", "POST /chest/tickets", "POST /chest/reset", "POST /dev-key/bootstrap", "POST /economy/write"] },
        404,
        headers,
      );
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.message }, error.status, headers);
      }
      // Never surface a stack trace or an upstream body to the browser.
      return json({ error: "Something went wrong on the worker." }, 500, headers);
    }
  },
};
