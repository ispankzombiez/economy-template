#!/usr/bin/env node
/**
 * Preflight check for the hosted-upload flow.
 *
 * Run automatically at the end of `npm run build:hosted`, or on its own:
 *   npm run upload:check
 *
 * Why this exists
 * ---------------
 * 1. The Sunflower Land upload dialog caps a batch at **300 files** and only
 *    lets you pick **one folder (or file) at a time**. Uploading the repo root
 *    (~350 files) therefore fails outright — only `dist/` may be uploaded.
 * 2. The CDN behind `*.economies.sunflower-land.com` answers **403** for any
 *    object whose key contains a space (e.g. `world/Teeny Tiny Pixls5.png`),
 *    so those files silently go missing at runtime.
 * 3. **A build made with the wrong mode produces a `dist/` that looks perfect
 *    and does not work.** `vite build --mode pages` sets `base` to
 *    `/economy-template/` for GitHub Pages; `npm run build` sets it to `/` for
 *    the hosted uploader. Uploading the Pages build puts every asset request
 *    under `/economy-template/assets/...`, which the hosted origin has never
 *    heard of — so the page loads, the JS never arrives, and the player gets a
 *    blank white screen with no error anywhere to look. This is silent: no
 *    console message, no failed request in the network tab's summary, nothing.
 *    So the base path is asserted here, and `vite build --mode pages` is run
 *    with the uploader's own mode instead (see `base:` below).
 *
 * This script fails the build if `dist/` would be rejected, would ship a file
 * the CDN cannot serve, or was built for the wrong target.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Hard limit imposed by the upload dialog. */
const MAX_FILES = 300;
/** Files the host is known to 403 on (whitespace / non-ASCII object keys). */
const UNSAFE_KEY = /[^\x21-\x7E]| /;

const root = process.cwd();
const distDir = join(root, "dist");

const rel = (p) => relative(root, p).split(sep).join("/");
const fail = (msg) => {
  console.error(`  ✗ ${msg}`);
};

if (!existsSync(distDir)) {
  console.error("\n[upload-check] dist/ not found — run `npm run build:hosted` first.");
  process.exit(1);
}

const files = [];
const folders = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      folders.push(full);
      walk(full);
    } else {
      files.push(full);
    }
  }
};
walk(distDir);

const problems = [];

// 1. Batch size -------------------------------------------------------------
const total = files.length + folders.length;
if (total > MAX_FILES) {
  problems.push(
    `dist/ holds ${total} entries — the upload dialog rejects batches over ${MAX_FILES}.`,
  );
}

// 2. Filenames the CDN will 403 on ------------------------------------------
const unsafe = files.filter((f) => UNSAFE_KEY.test(rel(f)));
for (const f of unsafe) {
  problems.push(
    `unsafe filename (spaces / non-ASCII break the CDN): ${rel(f)}`,
  );
}

// 3. Sanity: the entry points must exist ------------------------------------
for (const required of ["dist/index.html"]) {
  if (!existsSync(join(root, required))) problems.push(`missing ${required}`);
}

// 4. The base path must be the hosted one -----------------------------------
//
// This is the check that would have caught the white screen. Every `src`/`href`
// in `index.html` is emitted relative to Vite's `base`, so a Pages build asks
// for `/economy-template/assets/...` and the hosted origin 404s every one of
// them. Read the HTML and read the paths, rather than checking a constant —
// that way this keeps working if `base` is ever changed.
if (existsSync(join(distDir, "index.html"))) {
  const html = readFileSync(join(distDir, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((href) => !href.startsWith("data:"));

  const badBase = refs.filter((href) => href.startsWith("/economy-template/"));
  if (badBase.length > 0) {
    problems.push(
      `index.html references /economy-template/ — this is a GitHub Pages build. ` +
        `Run "npm run build" (build:hosted), not "vite build --mode pages". ` +
        `Offending refs: ${badBase.slice(0, 3).join(", ")}`,
    );
  } else if (refs.length === 0) {
    problems.push("index.html references no scripts or stylesheets at all.");
  } else {
    const notRooted = refs.filter(
      (href) => !href.startsWith("/") && !href.startsWith("./"),
    );
    if (notRooted.length > 0) {
      problems.push(
        `index.html has non-absolute asset refs: ${notRooted.slice(0, 3).join(", ")}`,
      );
    }
  }
}

const assetDir = join(distDir, "assets");
if (!existsSync(assetDir) || readdirSync(assetDir).length === 0) {
  problems.push("dist/assets/ is missing or empty.");
}

// Report --------------------------------------------------------------------
const size = files.reduce((n, f) => n + statSync(f).size, 0);
const mb = (size / 1024 / 1024).toFixed(2);

console.log("\n[upload-check]");
console.log(`  folder   ${rel(distDir)}/`);
console.log(`  entries  ${total} (${files.length} files, ${folders.length} folders)`);
console.log(`  size     ${mb} MB`);
console.log(`  limit    ${MAX_FILES} entries per batch`);

if (problems.length > 0) {
  console.error(`\n[upload-check] FAILED — ${problems.length} problem(s):`);
  for (const p of problems) fail(p);
  console.error("");
  process.exit(1);
}

console.log(`\n[upload-check] OK — select the single folder "dist" in the upload dialog.`);
console.log(`[upload-check] base path verified as "/" (hosted), not GitHub Pages.\n`);
