/**
 * Nightshade Arcade — reward request worker
 * =========================================
 *
 * Holds the list of rewards the arcade owner owes players, and answers the only
 * question that matters: *is this request actually for the person asking?*
 *
 * ## What this is, and what it is not
 *
 * This worker CANNOT give anyone tokens. It never touches a balance, never mints,
 * never burns. Tokens only ever move when a player presses a button that was
 * published in the Economy Editor and the Sunflower Land server accepts it.
 *
 * All this does is keep a list and tell a player which button they are allowed to
 * press. That is a much smaller promise, and it is one this worker can actually
 * keep.
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
 * The browser is never asked who it is. That is the whole trick, and it is why
 * this worker needs no API key, no password, and no shared secret of any kind —
 * there is nothing here worth stealing.
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
 * ## Storage
 *
 * Cloudflare Workers KV, two keys per request:
 *
 *   req:<id>            -> the full record
 *   farm:<farmId>:<id>  -> just the id, so "what am I owed" is a prefix scan
 *
 * KV is eventually consistent (a write can take up to ~60s to be visible in
 * another location). That is acceptable here: claiming is already guarded by the
 * button's own `requireAbsent`, so a stale read can only ever produce a "you
 * already claimed this" message, never a double payout.
 */

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

/**
 * Only actions whose id starts with this may ever appear in a request.
 *
 * Two reasons. It keeps the dev menu from accidentally queueing an unrelated
 * action. And it specifically fences off `Dev-Mint-Play-Ticket`, which is an
 * uncapped ranged mint — a request pointing at that would be a payout button
 * with no ceiling on it.
 */
const PAYOUT_PREFIX = "Payout-";
const PAYOUT_ACTION_RE = /^Payout-[A-Za-z0-9_-]{1,64}$/;

/** Matches the Dev Key item by name, the same way the game resolves it. */
const DEV_KEY_ITEM_RE = /^dev[\s_-]*keys?$/i;

/** Only used when the session carries no item metadata at all. */
const DEV_KEY_FALLBACK_TOKEN_KEY = "4";

const DEFAULT_ORIGINS = [
  "https://nightshade-arcade.economies.sunflower-land.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const CORS_MAX_AGE = "86400";

const KV_RECORD = (id) => `req:${id}`;
const KV_FARM_INDEX = (farmId, id) => `farm:${farmId}:${id}`;

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
 * Confirm the caller with Sunflower Land, and resolve their farm.
 *
 * Two calls, for two different jobs:
 *
 *  1. `/portal/{id}/player` proves the token is genuine. If Sunflower Land did not
 *     mint it, or will not speak for it, this throws and nothing downstream runs.
 *     This is the security half, and it is the half that cannot be faked.
 *  2. The farm id comes from the JWT, because the verified profile does not carry
 *     one. It is only ever used after step 1 has passed.
 */
async function identify(token, env) {
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
// Storage
// ---------------------------------------------------------------------------

async function readRequest(env, id) {
  const raw = await env.REWARDS.get(KV_RECORD(id));
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Every request addressed to one farm, newest first. */
async function listForFarm(env, farmId) {
  const ids = [];
  let cursor;

  do {
    const page = await env.REWARDS.list({ prefix: `farm:${farmId}:`, cursor });
    for (const key of page.keys ?? []) {
      ids.push(key.name.slice(`farm:${farmId}:`.length));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const records = await Promise.all(ids.map((id) => readRequest(env, id)));
  return records
    .filter(Boolean)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Every request, newest first. Dev-only. */
async function listAll(env) {
  const ids = [];
  let cursor;

  do {
    const page = await env.REWARDS.list({ prefix: "req:", cursor });
    for (const key of page.keys ?? []) {
      ids.push(key.name.slice("req:".length));
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const records = await Promise.all(ids.map((id) => readRequest(env, id)));
  return records
    .filter(Boolean)
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
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

  if (absent.length === 0) {
    warnings.push(
      "No requireAbsent, so this button is not one-use. Anyone who finds it can claim it as many times as they like.",
    );
  } else {
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
  if (!PAYOUT_ACTION_RE.test(actionId)) {
    throw new HttpError(
      400,
      `actionId must start with "${PAYOUT_PREFIX}" — e.g. ${PAYOUT_PREFIX}25.`,
    );
  }

  // The recipient's farm number is the only identity the dev supplies. The dev's
  // own farm comes from their token, and the recipient's username is a label
  // only — resolving a name to a farm number needs moderator access we do not
  // have, so it is never load-bearing.
  const record = {
    id: newId(),
    farmId: targetFarmId,
    label: typeof payload?.label === "string" ? payload.label.trim().slice(0, 120) : "",
    note: typeof payload?.note === "string" ? payload.note.trim().slice(0, 280) : "",
    actionId,
    createdAt: nowSeconds(),
    createdBy: identity.farmId,
    createdByUsername: identity.username,
    claimedAt: null,
  };

  await env.REWARDS.put(KV_RECORD(record.id), JSON.stringify(record));
  await env.REWARDS.put(KV_FARM_INDEX(targetFarmId, record.id), record.id);

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
  const records = await listForFarm(env, identity.farmId);
  return json(
    { farmId: identity.farmId, requests: records },
    200,
    headers,
  );
}

async function handleList(request, env, headers) {
  await authenticate(request, env, { requireDev: true });
  return json({ requests: await listAll(env) }, 200, headers);
}

async function handleClaim(request, env, headers) {
  const { identity } = await authenticate(request, env);

  let payload;
  try {
    payload = await request.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }

  const id = typeof payload?.id === "string" ? payload.id.trim() : "";
  if (!id) throw new HttpError(400, "id is required.");

  const record = await readRequest(env, id);
  if (!record) throw new HttpError(404, "That reward request no longer exists.");
  if (record.farmId !== identity.farmId) {
    throw new HttpError(403, "That reward is not addressed to you.");
  }
  if (record.claimedAt) throw new HttpError(409, "That reward has already been claimed.");

  record.claimedAt = nowSeconds();
  await env.REWARDS.put(KV_RECORD(record.id), JSON.stringify(record));

  return json({ request: record }, 200, headers);
}

async function handleCancel(request, env, headers, id) {
  await authenticate(request, env, { requireDev: true });

  const record = await readRequest(env, id);
  if (!record) throw new HttpError(404, "That reward request no longer exists.");

  await env.REWARDS.delete(KV_RECORD(id));
  await env.REWARDS.delete(KV_FARM_INDEX(record.farmId, id));

  return json({ cancelled: id }, 200, headers);
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
        return await handleCancel(request, env, headers, path.slice("/requests/".length));
      }

      return json(
        { error: "Not found.", routes: ["GET /whoami", "POST /requests", "GET /requests", "GET /requests/mine", "POST /requests/claim", "DELETE /requests/:id"] },
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
