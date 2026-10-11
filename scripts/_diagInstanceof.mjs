#!/usr/bin/env node
// Diagnostic: does `instanceof ReplayInputError` survive the wrangler bundle?
//
// The live worker recorded "the replay could not be started" — the catch-all
// used when the thrown error is NOT recognised as a ReplayInputError — for a
// submission whose every failure path throws exactly that class. Two candidate
// causes, and they need opposite fixes:
//
//   a) The class is duplicated in the bundle, so `instanceof` is always false
//      and every real validation message is being swallowed.
//   b) Something genuinely non-validation threw (a TypeError from a missing
//      field, a decode failure outside the inner try).
//
// This reproduces the bundling wrangler uses and asks the question directly.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARED = path.join(ROOT, "shared/anticheat");
const CACHE = path.join(ROOT, "node_modules/.cache/anticheat");
const ENTRY = path.join(CACHE, "instanceof-entry.mjs");
const BUNDLE = path.join(CACHE, "instanceof.bundle.mjs");
const toUrl = (p) => p.split(path.sep).join("/");

mkdirSync(CACHE, { recursive: true });
writeFileSync(
  ENTRY,
  [
    `export * from ${JSON.stringify(toUrl(path.join(ROOT, "worker/src/replay.js")))};`,
    `export { encodeInputLog } from ${JSON.stringify(toUrl(path.join(SHARED, "inputLog.js")))};`,
    "",
  ].join("\n"),
);

await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "esm",
  outfile: BUNDLE,
  loader: { ".png": "empty", ".webp": "empty", ".gif": "empty", ".mp3": "empty" },
  plugins: [
    {
      name: "nightshade-shared",
      setup(b) {
        b.onResolve({ filter: /^@nightshade\/shared\// }, (args) => {
          const rest = args.path.slice("@nightshade/shared/".length);
          const inAnticheat = path.join(SHARED, `${rest}.js`);
          const asWritten = path.join(ROOT, "shared", `${rest}.js`);
          return { path: existsSync(inAnticheat) ? inAnticheat : asWritten };
        });
      },
    },
  ],
  define: { "import.meta.env": "{}" },
  logLevel: "error",
});

function existsSyncSafe(p) {
  try {
    return !!require("node:fs").existsSync(p);
  } catch {
    return false;
  }
}

const mod = await import(pathToFileURL(BUNDLE).href);
const { ReplayInputError, validateReplay } = mod;
const { encodeInputLog } = mod;

// A well-formed log, so we reach the validation branches rather than the decode.
const goodInputs = encodeInputLog(new Uint8Array(1200).fill(0));
const base = { seed: 1, playerId: "barlow", difficulty: "expert", ticks: 1200, inputs: goodInputs };

const cases = [
  ["missing seed", { ...base, seed: undefined }, "missing its seed"],
  ["unknown champion", { ...base, playerId: "nobody" }, "unknown champion"],
  ["unknown difficulty", { ...base, difficulty: "nightmare" }, "unknown difficulty"],
  ["undecodable log", { ...base, inputs: "!!not base64!!" }, "not decodable"],
  ["ticks disagree", { ...base, ticks: 999 }, "carries"],
  ["replay absent entirely", undefined, "missing its seed"],
];

let instanceOfFailures = 0;
for (const [label, payload, expect] of cases) {
  try {
    validateReplay(payload);
    console.log(`? ${label}: no error thrown`);
  } catch (error) {
    const recognised = error instanceof ReplayInputError;
    const saysGeneric = !recognised;
    if (saysGeneric) instanceOfFailures += 1;
    console.log(
      `${recognised ? "ok " : "BAD"} ${label}: instanceof=${recognised} ` +
        `name=${error?.constructor?.name} msg=${JSON.stringify(error?.message)}` +
        (recognised && !String(error.message).includes(expect) ? `  (expected "${expect}")` : ""),
    );
  }
}

console.log(
  instanceOfFailures === 0
    ? "\ninstanceof holds for every case — so the live generic reason was NOT a bundling issue."
    : `\n${instanceOfFailures} case(s) lost to instanceof — the bundle duplicates the class.`,
);
process.exit(instanceOfFailures === 0 ? 0 : 1);
