#!/usr/bin/env node
/**
 * Audit the arcade's free-run allowance against a published economy.
 *
 * Run it on its own, or on a saved copy of a real session's economy:
 *
 *   npm run freerun:audit
 *   npm run freerun:audit -- path/to/economy-export.json
 *
 * ## Why this exists
 *
 * The rule is "one free reward run per cabinet for VIP, one for the whole arcade
 * otherwise". It is enforced entirely by **published economy data**, and a cabinet
 * needs **four** ids to take part:
 *
 *   1. `Free Run Token - <Cabinet>`      an item
 *   2. `Grant-Free-Run-<Cabinet>`        mints 1 token, `cooldownSeconds: 86400`
 *   3. `Start-Free-Run-<Cabinet>`        burns 1 token, mints 1 Reward Attempt
 *   4. `Mint-Raven-Coin-<Cabinet>`       the cabinet's own payout
 *
 * So a new machine is, by definition, half-published for a while — and a
 * half-published cabinet does not degrade politely. `Start-Free-Run-*` used to
 * fall back to the arcade-wide action, so publishing only the *item* left the gate
 * watching a per-cabinet token that nothing ever burned: the gate read "still
 * holding a token" forever and every run was free. That is an unbounded Raven Coin
 * leak, and it is silent — the cabinet looks like it is working.
 *
 * `resolveFreeRunEntitlement` now fails closed on any incoherent cabinet, so the
 * worst case is "charges a Play Ticket". This script exists for the other half of
 * the job: making the missing ids **obvious**, and printing the exact JSON to paste
 * into the economy editor so publishing is a copy-paste rather than an archaeology.
 *
 * Exits non-zero while any cabinet is incomplete, so it can gate a deploy.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_SAMPLE =
  "src/features/arcade/nightshade-arcade-editor-sample.json";

/** `sunflower-brawler` → `SunflowerBrawler`, matching `lib/ravenCoin.ts`. */
function machineSuffix(machine) {
  return String(machine)
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

const isRecord = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The single key a `mint`/`burn` rule map declares, or null. */
function onlyKey(rules) {
  if (!isRecord(rules)) return null;
  const keys = Object.keys(rules);
  return keys.length === 1 ? keys[0] : null;
}

/**
 * Cabinet ids, read straight out of `registry.tsx`.
 *
 * A text scan rather than an import so the script stays dependency-free and
 * runnable without a TypeScript loader — but it reads the same file the runtime
 * does, so a cabinet cannot be registered without appearing in this audit.
 */
function registryIds() {
  const file = resolve("src/features/arcade/games/registry.tsx");
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/\n\s{4}id:\s*"([^"]+)"/g)].map((m) => m[1]);
}

const economyPath = resolve(process.argv[2] ?? DEFAULT_SAMPLE);
let economy;
try {
  economy = JSON.parse(readFileSync(economyPath, "utf8"));
} catch (error) {
  console.error(`[freerun-audit] cannot read ${economyPath}: ${error.message}`);
  process.exit(2);
}

const actions = isRecord(economy.actions) ? economy.actions : {};
const items = isRecord(economy.items) ? economy.items : {};
const cabinets = registryIds();

const VOUCHER = "Reward Attempt";
const problems = [];
const rows = [];

for (const machine of cabinets) {
  const suffix = machineSuffix(machine);
  const tokenName = `Free Run Token - ${suffix}`;
  const grantId = `Grant-Free-Run-${suffix}`;
  const openId = `Start-Free-Run-${suffix}`;
  const mintId = `Mint-Raven-Coin-${suffix}`;

  // 1. the token item, and the key the actions reference it by
  const tokenKey = Object.keys(items).find(
    (k) => isRecord(items[k]) && items[k].name === tokenName,
  );

  const grantMints = grantId in actions ? onlyKey(actions[grantId].mint) : null;
  const openBurns = openId in actions ? onlyKey(actions[openId].burn) : null;

  const missing = [];
  if (!tokenKey) missing.push(`item "${tokenName}"`);
  if (!(grantId in actions)) missing.push(`action "${grantId}"`);
  if (!(openId in actions)) missing.push(`action "${openId}"`);
  if (grantMints && openBurns && grantMints !== openBurns) {
    missing.push(
      `${grantId} mints "${grantMints}" but ${openId} burns "${openBurns}"`,
    );
  }
  if (grantMints && tokenKey && grantMints !== tokenKey) {
    missing.push(`${grantId} mints "${grantMints}", expected "${tokenKey}"`);
  }
  if (!(mintId in actions)) missing.push(`action "${mintId}" (payout)`);

  if (missing.length) {
    problems.push({ machine, missing });
  }

  rows.push({
    machine,
    token: tokenKey ?? "—",
    grant: grantId in actions ? "yes" : "NO",
    open: openId in actions ? "yes" : "NO",
    mint: mintId in actions ? "yes" : "NO",
    agree: grantMints && openBurns ? (grantMints === openBurns ? "yes" : "NO") : "—",
    vip: missing.length ? "ticket" : "1 / day",
    nonVip: "1 / arcade / day",
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n[freerun-audit] ${economyPath}`);
console.log(`[freerun-audit] ${cabinets.length} cabinets\n`);
console.log(
  pad("cabinet", 20) +
    pad("token", 8) +
    pad("grant", 7) +
    pad("open", 6) +
    pad("mint", 6) +
    pad("agree", 7) +
    "VIP free run",
);
console.log("-".repeat(70));
for (const r of rows) {
  console.log(
    pad(r.machine, 20) +
      pad(r.token, 8) +
      pad(r.grant, 7) +
      pad(r.open, 6) +
      pad(r.mint, 6) +
      pad(r.agree, 7) +
      r.vip,
  );
}

// A non-VIP is rationed arcade-wide, so the shared pair is all they need.
const arcadeOk =
  "Grant-Free-Run-Arcade" in actions && "Start-Free-Run-Arcade" in actions;
console.log(
  `\n[freerun-audit] non-VIP allowance: ${
    arcadeOk
      ? "Start-Free-Run-Arcade + Grant-Free-Run-Arcade published"
      : "MISSING — every cabinet will demand a Play Ticket"
  }`,
);

if (problems.length === 0) {
  console.log("[freerun-audit] OK — every cabinet can hand out its own free run.\n");
  process.exit(0);
}

console.log(
  `\n[freerun-audit] ${problems.length} cabinet(s) cannot hand out a VIP free run.`,
);
console.log(
  "[freerun-audit] Until published they charge a Play Ticket (that is the safe\n" +
    "[freerun-audit] direction — the reverse leaks a coin per attempt).\n",
);

for (const { machine, missing } of problems) {
  const suffix = machineSuffix(machine);
  console.log(`── ${machine} ──`);
  for (const m of missing) console.log(`   missing: ${m}`);
  console.log(
    [
      "",
      "  Paste into the economy editor:",
      `    item  "${suffix} token"`,
      `      name: "Free Run Token - ${suffix}"`,
      `      description: "Internal arcade bookkeeping. Not a collectable."`,
      `      is_visible: false`,
      "",
      `    action "${`Grant-Free-Run-${suffix}`}"`,
      `      { "type": "custom", "showInShop": false,`,
      `        "mint": { "<${suffix} token key>": { "min": 1, "max": 1, "dailyCap": 1 } },`,
      `        "cooldownSeconds": 86400 }`,
      "",
      `    action "Start-Free-Run-${suffix}"`,
      `      { "type": "custom", "showInShop": false,`,
      `        "burn": { "<${suffix} token key>": { "amount": 1 } },`,
      `        "mint": { "${VOUCHER}": { "amount": 1 } } }`,
      "",
      `    action "Mint-Raven-Coin-${suffix}"`,
      `      { "type": "custom", "showInShop": false,`,
      `        "mint": { "<Raven Coin key>": { "amount": 1, "dailyCap": 1 } } }`,
      "",
    ].join("\n"),
  );
}

process.exit(1);
