#!/usr/bin/env node
/**
 * Emit the economy ids a cabinet needs, ready to paste into the economy editor.
 *
 *   npm run freerun:add -- <economy.json> [cabinet ...]
 *   npm run freerun:add -- economy.json                 # every unpublished cabinet
 *   npm run freerun:add -- economy.json sunflower-brawler
 *
 * Writes `<economy>.with-cabinets.json` and prints the four blocks to add.
 *
 * ## Why a script rather than a checklist
 *
 * A cabinet's free-run allowance is four ids whose whole job is to agree with
 * each other: the grant must mint *exactly* the token the open burns, or the gate
 * watches a balance nothing ever touches and every run is free. Writing those ids
 * by hand is how they end up disagreeing, so this derives them from
 * `GAME_REGISTRY` and **clones the shape of a cabinet that already works** in
 * your economy — same fields, same `max` / `is_visible` / `cooldownSeconds`, same
 * `min`/`max`/`dailyCap`. A cabinet that has never been published in that economy
 * falls back to the canonical shape documented in `lib/ravenCoin.ts`.
 *
 * Refuses to touch an id that already exists, so it cannot silently rewrite a
 * live allowance or clobber a token somebody is holding.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    "usage: npm run freerun:add -- <economy.json> [cabinet ...]\n" +
      "  Pass the economy JSON exported from the economy editor.",
  );
  process.exit(2);
}

const economyPath = resolve(args[0]);
const only = args.slice(1);

let economy;
try {
  economy = JSON.parse(readFileSync(economyPath, "utf8"));
} catch (error) {
  console.error(`[freerun-add] cannot read ${economyPath}: ${error.message}`);
  process.exit(2);
}

const actions = economy.actions ?? (economy.actions = {});
const items = economy.items ?? (economy.items = {});

const clone = (v) => JSON.parse(JSON.stringify(v));
const isRecord = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKey = (rules) =>
  isRecord(rules) && Object.keys(rules).length === 1
    ? Object.keys(rules)[0]
    : null;

function machineSuffix(machine) {
  return String(machine)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

/** Cabinet ids, read from `registry.tsx` — the same file the runtime reads. */
function registryIds() {
  const text = readFileSync(
    resolve("src/features/arcade/games/registry.tsx"),
    "utf8",
  );
  return [...text.matchAll(/\n\s{4}id:\s*"([^"]+)"/g)].map((m) => m[1]);
}

const cabinets = only.length ? only : registryIds();

const ids = (machine) => {
  const s = machineSuffix(machine);
  return {
    suffix: s,
    tokenName: `Free Run Token - ${s}`,
    grant: `Grant-Free-Run-${s}`,
    open: `Start-Free-Run-${s}`,
    mint: `Mint-Raven-Coin-${s}`,
  };
};

/** Token key an existing cabinet's grant/open pair already agree on. */
function publishedTokenKey(id) {
  const grantMints =
    id.grant in actions ? onlyKey(actions[id.grant].mint) : null;
  const openBurns = id.open in actions ? onlyKey(actions[id.open].burn) : null;
  if (grantMints && grantMints === openBurns) return grantMints;
  const byName = Object.keys(items).find(
    (k) => isRecord(items[k]) && items[k].name === id.tokenName,
  );
  return byName ?? null;
}

/**
 * The voucher a run-open mints, taken from whatever your economy already uses.
 *
 * Matched on the **item name**, not just the key. A hosted economy keys items
 * numerically — the voucher is `"3"`, and only `items["3"].name` says
 * "Reward Attempt" — so a key-shaped match alone finds nothing and falls through
 * to the offline sample's literal `"Reward Attempt"`. That is a rule that
 * *looks* right and silently fails to mint, so the name is checked too, and the
 * existing `Start-Free-Run-*` actions are preferred as the authority.
 */
function voucherKey() {
  const REWARD_ATTEMPT = /reward[\s_-]*attempts?$/i;
  const isVoucher = (key) =>
    REWARD_ATTEMPT.test(key) ||
    REWARD_ATTEMPT.test(String(items[key]?.name ?? ""));

  // Prefer a key an existing run-open already mints — that is known-good.
  for (const id of Object.keys(actions)) {
    if (!id.startsWith("Start-")) continue;
    const minted = Object.keys(actions[id].mint ?? {});
    const voucher = minted.find(isVoucher);
    if (voucher) return voucher;
  }
  // Otherwise resolve it through the published item names.
  for (const [key, item] of Object.entries(items)) {
    if (REWARD_ATTEMPT.test(String(item?.name ?? ""))) return key;
  }
  return "Reward Attempt";
}

/** The coin key, from `mainCurrencyToken` or any existing mint. */
function coinKey() {
  if (typeof economy.mainCurrencyToken === "string") {
    return economy.mainCurrencyToken;
  }
  for (const id of Object.keys(actions)) {
    if (!id.startsWith("Mint-Raven-Coin")) continue;
    const k = onlyKey(actions[id].mint);
    if (k) return k;
  }
  return "RavenCoin";
}

/** A cabinet in this economy that already publishes all four ids, to copy. */
function referenceCabinet() {
  for (const machine of registryIds()) {
    const id = ids(machine);
    const tokenKey = publishedTokenKey(id);
    if (
      tokenKey &&
      id.grant in actions &&
      id.open in actions &&
      id.mint in actions
    ) {
      return { machine, id, tokenKey };
    }
  }
  return null;
}

const reference = referenceCabinet();
const VOUCHER = voucherKey();
const COIN = coinKey();

/** Next unused numeric item id, so a new token never collides. */
function nextItemId() {
  const used = new Set(
    Object.keys(items)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n)),
  );
  let n = 0;
  while (used.has(n)) n++;
  return n;
}

const plan = [];
const skipped = [];

for (const machine of cabinets) {
  const id = ids(machine);
  const existingToken = publishedTokenKey(id);
  const haveAll =
    existingToken &&
    id.grant in actions &&
    id.open in actions &&
    id.mint in actions;

  if (haveAll) {
    skipped.push(`${machine} — already published (token ${existingToken})`);
    continue;
  }
  if (existingToken) {
    // Partially published. Refuse: re-deriving would mint a *second* token for
    // a cabinet that already has one, and the old gate would still be watching
    // the first. `npm run freerun:audit` names exactly what is missing.
    skipped.push(
      `${machine} — PARTIAL (token ${existingToken} exists but an action does ` +
        `not); run "npm run freerun:audit" and fix that cabinet by hand first`,
    );
    continue;
  }

  const tokenKey = String(nextItemId());
  plan.push({ machine, id, tokenKey });
}

if (plan.length === 0) {
  console.log(`\n[freerun-add] nothing to add.\n`);
  for (const s of skipped) console.log(`  ${s}`);
  console.log("");
  process.exit(0);
}

// ── Build the blocks ─────────────────────────────────────────────────────────
// Clone a working cabinet's shapes where possible, so the result matches what
// your editor already publishes field-for-field rather than merely being valid.

const blocks = [];

for (const { machine, id, tokenKey } of plan) {
  // Item: clone the reference token, retarget the name and id.
  const refItem = reference ? items[reference.tokenKey] : null;
  const item = refItem
    ? clone(refItem)
    : {
        description: "Internal arcade bookkeeping. Not a collectable.",
        is_visible: false,
        max: 1,
      };
  item.name = id.tokenName;
  item.id = Number(tokenKey);

  const grant = reference && id.grant in actions
    ? clone(actions[reference.id.grant])
    : {
        mint: { [tokenKey]: { min: 1, max: 1, dailyCap: 1 } },
        showInShop: false,
        cooldownSeconds: 86400,
        type: "custom",
      };
  grant.mint = { [tokenKey]: clone(grant.mint[reference?.tokenKey ?? tokenKey] ?? { min: 1, max: 1, dailyCap: 1 }) };

  const open = reference && id.open in actions
    ? clone(actions[reference.id.open])
    : {
        burn: { [tokenKey]: { amount: 1 } },
        mint: { [VOUCHER]: { amount: 1 } },
        showInShop: false,
        type: "custom",
      };
  open.burn = { [tokenKey]: clone(open.burn[reference?.tokenKey ?? tokenKey] ?? { amount: 1 }) };
  open.mint = { [VOUCHER]: clone(open.mint?.[VOUCHER] ?? { amount: 1 }) };

  const mint = reference && id.mint in actions
    ? clone(actions[reference.id.mint])
    : {
        mint: { [COIN]: { min: 1, max: 1, dailyCap: 1 } },
        showInShop: false,
        type: "custom",
      };
  mint.mint = { [COIN]: clone(mint.mint?.[COIN] ?? { min: 1, max: 1, dailyCap: 1 }) };

  // Insert next to its RavenBubbles counterpart so the file stays grouped.
  const insertAfter = (obj, anchor, key, value) => {
    if (!(anchor in obj)) {
      obj[key] = value;
      return;
    }
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = v;
      if (k === anchor) out[key] = value;
    }
    for (const [k, v] of Object.entries(obj)) if (!(k in out)) out[k] = v;
    for (const k of Object.keys(obj)) delete obj[k];
    Object.assign(obj, out);
  };

  insertAfter(items, "16", tokenKey, item);
  insertAfter(actions, "Mint-Raven-Coin-RavenBubbles", id.mint, mint);
  insertAfter(actions, "Start-Free-Run-RavenBubbles", id.open, open);
  insertAfter(actions, "Grant-Free-Run-RavenBubbles", id.grant, grant);

  blocks.push({ machine, id, tokenKey, item, grant, open, mint });
}

const outPath = economyPath.replace(/\.json$/i, "") + ".with-cabinets.json";
writeFileSync(outPath, JSON.stringify(economy, null, 2) + "\n", "utf8");

console.log(`\n[freerun-add] read   ${economyPath}`);
console.log(`[freerun-add] wrote  ${outPath}`);
if (reference) {
  console.log(
    `[freerun-add] shape cloned from "${reference.machine}" (token ${reference.tokenKey})`,
  );
}
console.log(`[freerun-add] voucher "${VOUCHER}", coin "${COIN}"\n`);

for (const b of blocks) {
  console.log(`── ${b.machine} → token key "${b.tokenKey}" ──\n`);
  console.log(
    JSON.stringify(
      {
        items: { [b.tokenKey]: b.item },
        actions: {
          [b.id.mint]: b.mint,
          [b.id.open]: b.open,
          [b.id.grant]: b.grant,
        },
      },
      null,
      2,
    ),
  );
  console.log("");
}

for (const s of skipped) console.log(`  skipped: ${s}`);

console.log(
  `\n[freerun-add] verify with:\n` +
    `  npm run freerun:audit -- ${outPath}\n`,
);
