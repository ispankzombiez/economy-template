#!/usr/bin/env node
/**
 * Build `vip-index.json` from the Community API's nightly farm dump.
 *
 * Why this exists
 * ---------------
 * The arcade needs to know which farms are VIP, and it cannot ask the Community
 * API itself. Two independent reasons, both measured against the live host:
 *
 *   1. **CORS.** `api.sunflower-land.com` echoes `Access-Control-Allow-Origin`
 *      only for `sunflower-land.com` and `www.sunflower-land.com`. A browser on
 *      the arcade's own host (`nightshade-arcade.economies.sunflower-land.com`)
 *      is refused the response even though the request itself succeeds — the
 *      body comes back and the browser throws it away.
 *   2. **The key is a credential.** It was wired in as `VITE_SUNFLOWER_COMMUNITY_API_KEY`,
 *      which Vite inlines into the shipped bundle, so every visitor could read it.
 *
 * This script moves both problems server-side. It runs in GitHub Actions where
 * `COMMUNITY_API_KEY` is a repository secret, and it publishes a credential-free
 * index that the arcade reads from `raw.githubusercontent.com`, which answers
 * `Access-Control-Allow-Origin: *`. Nothing signed in leaves GitHub.
 *
 * Inputs
 * ------
 *   GET https://api.sunflower-land.com/community/data?type=nightlyDump   (key)
 *     -> manifest of { filename, size, modifiedAt } covering the last 7 days.
 *   GET https://community.sunflower-land.com/{filename}                  (no key)
 *     -> newline-delimited JSON, one farm per line:
 *          { id, nftId, farm: { username, vip: { expiresAt, ... }, ... },
 *            isBlacklisted, lastActivity }
 *
 * The dump is ~810 MB gzipped for ~64k active farms. It is streamed and parsed
 * line by line; peak memory is the entry list, not the file.
 *
 * Output
 * ------
 *   {
 *     "source": "2026-09-27/active.jsonl.gz",
 *     "generatedAt": 1790570000000,
 *     "count": 17020,
 *     "entries": [[121500, "someplayer", 32501520000000], ...]
 *   }
 *
 * Only farms whose `vip.expiresAt` is in the future are written, and blacklisted
 * accounts are dropped. `expiresAt` is an absolute timestamp rather than a flag,
 * which is what makes a snapshot up to ~24 hours old safe: everyone already VIP
 * stays correctly VIP right up to their real expiry. The only lag is for a farm
 * that became VIP after the dump, which waits for the next one.
 *
 * Usage
 * -----
 *   COMMUNITY_API_KEY=... node scripts/build-vip-index.mjs [--out ./vip-index.json]
 */
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const MANIFEST_URL = "https://api.sunflower-land.com/community/data?type=nightlyDump";
/** The dump files sit on a plain CDN: no key, no rate limit. */
const CDN_BASE = "https://community.sunflower-land.com";
/** Per-IP throttle on the manifest endpoint: roughly one request per 5s. */
const THROTTLE_MS = 5100;
/** How many of the newest dump files to try before giving up. */
const MAX_FALLBACK = 3;

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outPath = resolve(
  outFlag !== -1 && args[outFlag + 1] ? args[outFlag + 1] : "vip-index.json",
);

/**
 * The API key. Read from `COMMUNITY_API_KEY`, falling back to `.env` so the same
 * command works on a laptop as it does in Actions. Deliberately *not* a `VITE_`
 * variable — those are inlined into the bundle by design.
 */
function readKey() {
  const fromEnv = process.env.COMMUNITY_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  if (existsSync(".env")) {
    for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*COMMUNITY_API_KEY\s*=\s*(.*?)\s*$/);
      if (match) {
        const value = match[1].replace(/^["']|["']$/g, "");
        if (value) return value;
      }
    }
  }
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, key) {
  const headers = { accept: "application/json" };
  if (key) headers["x-api-key"] = key;

  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) return res.json();
    lastStatus = res.status;
    // 429 is documented at roughly one request per 5s, doubling when hammered.
    if (res.status !== 429) break;
    await sleep(THROTTLE_MS * (attempt + 1));
  }
  throw new Error(`${url} -> HTTP ${lastStatus}`);
}

/** Newest `active.jsonl.gz` first. `active` is the arcade's world: it skips dead farms. */
async function pickDump(key) {
  const manifest = await getJson(MANIFEST_URL, key);
  const files = manifest.data ?? manifest.files ?? manifest;
  if (!Array.isArray(files)) throw new Error("manifest was not a list of files");

  return files
    .filter((f) => typeof f?.filename === "string" && f.filename.endsWith("active.jsonl.gz"))
    .sort((a, b) => (a.filename < b.filename ? 1 : -1));
}

/**
 * Stream one dump, keeping every farm with VIP still in the future.
 *
 * Returns `undefined` instead of an entry list when the CDN has not published
 * the newest manifest file yet, so the caller can fall back to the day before
 * rather than failing the whole run.
 */
async function readDump(filename) {
  const url = `${CDN_BASE}/${filename}`;
  const res = await fetch(url);
  if (!res.ok) return undefined;
  if (!res.body) throw new Error(`${url} returned no body`);

  const now = Date.now();
  const entries = [];
  let lines = 0;
  let blacklisted = 0;
  const started = Date.now();

  const gunzip = createGunzip();
  const rl = createInterface({
    // `fetch` hands back a web ReadableStream; node:zlib wants a Node one.
    input: Readable.fromWeb(res.body).pipe(gunzip),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line) continue;
    lines++;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a single corrupt line must not sink a 64k-line run
    }
    if (parsed.isBlacklisted) {
      blacklisted++;
      continue;
    }

    const farm = parsed.farm;
    if (!farm || typeof farm !== "object") continue;

    const expiresAt = Number(farm.vip?.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;

    entries.push([parsed.id, typeof farm.username === "string" ? farm.username : "", expiresAt]);
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[vip-index] ${filename}: ${lines} farms, ${entries.length} active VIP ` +
      `(${blacklisted} blacklisted skipped) in ${seconds}s`,
  );

  return { entries, lines };
}

async function main() {
  const key = readKey();
  if (!key) {
    console.error(
      "[vip-index] No API key. Set COMMUNITY_API_KEY (GitHub Actions secret, or .env locally).",
    );
    process.exit(1);
  }

  console.log("[vip-index] reading manifest…");
  const dumps = await pickDump(key);
  if (dumps.length === 0) throw new Error("manifest listed no active.jsonl.gz files");

  let result;
  let source;
  for (const dump of dumps.slice(0, MAX_FALLBACK)) {
    source = dump.filename;
    console.log(`[vip-index] downloading ${source} (${(dump.size / 1e6).toFixed(0)} MB)…`);
    result = await readDump(source);
    if (result) break;
    console.warn(`[vip-index] ${source} not on the CDN yet, trying the previous day`);
  }

  if (!result) throw new Error("no dump could be downloaded");

  // Sorted so two runs over the same dump produce byte-identical output.
  result.entries.sort((a, b) => a[0] - b[0]);

  const index = {
    source,
    generatedAt: Date.now(),
    count: result.entries.length,
    entries: result.entries,
  };

  writeFileSync(outPath, `${JSON.stringify(index)}\n`, "utf8");
  const kb = (Buffer.byteLength(JSON.stringify(index)) / 1024).toFixed(0);
  console.log(
    `[vip-index] wrote ${outPath} — ${index.count} VIP farms, ${kb} KB, source ${source}`,
  );
}

main().catch((err) => {
  console.error(`[vip-index] FAILED — ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
