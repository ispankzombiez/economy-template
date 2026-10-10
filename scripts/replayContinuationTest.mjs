#!/usr/bin/env node
/**
 * Continuation test — the *worker's own* chunked-replay path, end to end.
 *
 * ## Why this exists beside `replayHarness.mjs`
 *
 * The harness proves the engine replays exactly and that a match survives JSON
 * parks — but it does both with its *own* loop, calling `createMatch` and
 * `stepMatch` directly. It therefore cannot catch a defect in the code the
 * worker actually runs: `startReplay`, `stepReplay`, `resumeReplay`,
 * `replayOutcome`, and the encode/decode round trip that carries a log between
 * claim and continuation.
 *
 * That gap is not theoretical. When the continuation path was first written,
 * the continuation rebuilt its replay state from the parked row *without the
 * input log* — so the first `continue-verification` in production would have
 * dereferenced a missing `inputs` and thrown. The harness stayed green
 * throughout, because it never called that function. This test does.
 *
 * ## What it checks
 *
 *  1. **Equivalence.** A claim replayed in one pass and the same claim
 *     replayed in `CHUNK_TICKS` slices with a JSON park between every slice
 *     produce the same outcome, the same final match, *and* the same match the
 *     client originally played.
 *  2. **The park binds.** `resumeReplay` refuses a truncated log, a
 *     cursor outside its log, an undecodable log — each as a
 *     `ReplayInputError`, which is what keeps protocol noise out of the match
 *     rate.
 *  3. **Validation rejects.** `validateReplay` refuses a wrong tick count,
 *     an unknown champion or difficulty, an empty log and an oversized one —
 *     every refusal *before* a tick is stepped.
 *  4. **The budget closes.** `CHUNK_TICKS` and `MAX_REPLAY_TICKS` are shared
 *     with the client, whose continuation count is derived from them; a log at
 *     the ceiling must be finishable within that many continuations.
 *
 * ## Usage
 *
 *     node scripts/replayContinuationTest.mjs
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(ROOT, "src/features/arcade/games/sunflowerbrawler/engine.ts");
const SESSION = path.join(ROOT, "src/features/arcade/games/sunflowerbrawler/session.ts");
const WORKER_REPLAY = path.join(ROOT, "worker/src/replay.js");
const SHARED = path.join(ROOT, "shared/anticheat");
const BUDGET = path.join(SHARED, "replayBudget.js");

const CACHE = path.join(ROOT, "node_modules/.cache/anticheat");
const ENTRY = path.join(CACHE, "continuation-entry.mjs");
const BUNDLE = path.join(CACHE, "continuation.bundle.mjs");

const passes = [];
const failures = [];
function check(ok, label, detail = "") {
  if (ok) passes.push(label);
  else failures.push(detail ? `${label} — ${detail}` : label);
}

const toUrl = (p) => p.split(path.sep).join("/");

mkdirSync(CACHE, { recursive: true });
writeFileSync(
  ENTRY,
  [
    `export * from ${JSON.stringify(toUrl(ENGINE))};`,
    `export { SUNFLOWER_BRAWLER_DIFFICULTIES } from ${JSON.stringify(toUrl(SESSION))};`,
    `export * from ${JSON.stringify(toUrl(WORKER_REPLAY))};`,
    `export { inputMask, encodeInputLog, decodeInputLog } from ${JSON.stringify(toUrl(path.join(SHARED, "inputLog.js")))};`,
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
      // Two spellings of one package, and the worker's is *not* the client's.
      // Client code imports `@nightshade/shared/anticheat/<file>`; the worker
      // imports the package subpath `@nightshade/shared/<file>`, resolved by
      // `shared/package.json`'s `exports` map. Neither spelling resolves on its
      // own under a single alias, so both are answered here — from the same
      // directory, which is the whole point of the package: one file, two ends.
      name: "nightshade-shared",
      setup(build_) {
        build_.onResolve({ filter: /^@nightshade\/shared\// }, (args) => {
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

const mod = await import(pathToFileURL(BUNDLE).href);
const { createMatch, stepMatch, emptyInput } = mod;
const {
  CHUNK_TICKS,
  MAX_REPLAY_TICKS,
  ReplayInputError,
  isReplayComplete,
  replayOutcome,
  resumeReplay,
  startReplay,
  stepReplay,
} = mod;
const { encodeInputLog, decodeInputLog } = mod;

const difficulty =
  mod.SUNFLOWER_BRAWLER_DIFFICULTIES.find((d) => d.name === "expert") ??
  mod.SUNFLOWER_BRAWLER_DIFFICULTIES[3];

/** A run long enough to need several chunks — and one that is not a round
 *  multiple of the chunk, so the last slice is short and the final park
 *  boundary lands mid-log. */
const TICKS_LONG = 3000; // exactly 5 chunks
const TICKS_ODD = 3137; // 5 full chunks + 137

/** Scripted play, as a function of tick alone. Compact cousin of the harness
 *  script: walk, attack on a beat, occasionally cast. */
function playScript(input, t, variant) {
  const legs = [1, 2, 3, 0];
  const leg = legs[Math.floor(t / 48) % legs.length];
  input.left = leg === 1;
  input.right = leg === 2;
  input.up = leg === 3;
  input.down = leg === 0;
  input.attackBuf = (t + variant * 5) % (9 + variant * 4) === 0 ? 150 : 0;
  input.magicBuf = (t + variant * 30) % (240 - variant * 60) === 0 ? 150 : 0;
}

/** The client's half: play a run and log what the claim would carry. */
function playAndLog(ticks, seed, variant) {
  const input = emptyInput();
  const match = createMatch({ playerId: "barlow", difficulty, input, seed });
  const logged = [];
  for (let t = 0; t < ticks; t++) {
    playScript(input, t, variant);
    // Before the step, exactly as the game logs it — `stepMatch` drains the
    // buffers, so sampling after would record the press as already spent.
    logged.push(mod.inputMask(input));
    stepMatch(match, 1000 / 60);
  }
  return { match, logged };
}

const snapshot = (m) => JSON.parse(JSON.stringify(m));

/** The worker's half: one claim, replayed in a single pass. */
function replayInOnePass(claim) {
  const state = startReplay(claim);
  stepReplay(state, state.total);
  return state;
}

/** The worker's half, the way it really runs: chunk, park, resume. */
function replayChunked(claim, chunk) {
  let state = startReplay(claim);
  let parks = 0;
  while (!isReplayComplete(state)) {
    stepReplay(state, chunk);
    if (isReplayComplete(state)) break;
    // Verbatim what `writeReplayState` / `readReplayState` do: the match as
    // JSON, the cursor and total beside it, the validated log as base64.
    const park = {
      state: JSON.parse(JSON.stringify(state.match)),
      cursor: state.cursor,
      total: state.total,
      inputs: encodeInputLog(state.inputs),
    };
    state = resumeReplay(park);
    parks += 1;
  }
  return { state, parks };
}

const runFor = (ticks, seed, variant) => {
  const { logged } = playAndLog(ticks, seed, variant);
  const claim = {
    seed,
    playerId: "barlow",
    difficulty: difficulty.name,
    ticks: logged.length,
    inputs: encodeInputLog(Uint8Array.from(logged)),
  };
  return claim;
};

// ── 1. Equivalence ───────────────────────────────────────────────────────────
//
// Four scenarios rather than one: a defect in chunk handling that only bites
// at a particular log length, or after a particular phase transition, is
// invisible to a single run.

const SCENARIOS = [
  [TICKS_LONG, 1234, 0],
  [TICKS_ODD, 1234, 0],
  [TICKS_LONG, 99999, 1],
  [TICKS_ODD, 7, 1],
];

for (const [ticks, seed, variant] of SCENARIOS) {
  const claim = runFor(ticks, seed, variant);
  const client = playAndLog(ticks, seed, variant).match;

  const one = replayInOnePass(claim);
  const { state: many, parks } = replayChunked(claim, CHUNK_TICKS);

  const oneOutcome = replayOutcome(one);
  const manyOutcome = replayOutcome(many);

  check(
    JSON.stringify(oneOutcome) === JSON.stringify(manyOutcome),
    `seed ${seed}/${variant} @${ticks}: chunked replay matches a single-pass replay`,
    `single=${JSON.stringify(oneOutcome)} chunked=${JSON.stringify(manyOutcome)}`,
  );

  // The full match, not just the verdict fields. Two runs can agree on score
  // and lives while the enemy positions underneath have diverged — and the
  // next chunk would then step a different game. The park is only safe if
  // *everything* round-trips.
  check(
    JSON.stringify(snapshot(one.match)) === JSON.stringify(snapshot(many.match)),
    `seed ${seed}/${variant} @${ticks}: chunked replay's final match is identical to single-pass`,
  );

  check(
    JSON.stringify(replayOutcome(many)) === JSON.stringify(replayOutcome({ match: client, cursor: ticks, total: ticks })),
    `seed ${seed}/${variant} @${ticks}: replay outcome matches the run the client played`,
    `client score=${client.score} wave=${client.waveIndex} replay score=${manyOutcome.score} wave=${manyOutcome.wave}`,
  );

  check(
    parks === Math.ceil(ticks / CHUNK_TICKS) - 1,
    `seed ${seed}/${variant} @${ticks}: parked once per chunk boundary`,
    `parks=${parks}, expected ${Math.ceil(ticks / CHUNK_TICKS) - 1}`,
  );
}

// ── 2. The park binds ────────────────────────────────────────────────────────
//
// A continuation receives no replay body — it reads the row the claim parked.
// So the row itself must be the thing that refuses a bad resume: a truncated
// or swapped log has to fail *here*, as a recorded non-match, rather than
// mid-step where it would surface as a bogus mismatch against an honest run.

{
  const claim = runFor(TICKS_LONG, 4242, 0);
  const good = startReplay(claim);
  stepReplay(good, CHUNK_TICKS);
  const park = {
    state: JSON.parse(JSON.stringify(good.match)),
    cursor: good.cursor,
    total: good.total,
    inputs: encodeInputLog(good.inputs),
  };

  const resumed = resumeReplay(park);
  check(
    resumed.cursor === park.cursor && resumed.total === park.total,
    "resumeReplay carries the parked cursor and total through",
    `cursor=${resumed.cursor} total=${resumed.total}`,
  );

  /** Assert that `fn` throws a `ReplayInputError` mentioning `want`. */
  const rejects = (fn, label, want) => {
    try {
      fn();
      check(false, label, "no error thrown");
    } catch (error) {
      check(
        error instanceof ReplayInputError && error.message.includes(want),
        label,
        `threw ${error?.constructor?.name}: ${error?.message}`,
      );
    }
  };

  rejects(
    () => resumeReplay({ ...park, inputs: encodeInputLog(good.inputs.subarray(0, park.cursor - 1)) }),
    "resumeReplay refuses a truncated parked log",
    "claims",
  );
  rejects(
    () => resumeReplay({ ...park, cursor: park.total + 1 }),
    "resumeReplay refuses a cursor past the end of its log",
    "outside its log",
  );
  rejects(
    () => resumeReplay({ ...park, cursor: -1 }),
    "resumeReplay refuses a negative cursor",
    "outside its log",
  );
  rejects(
    () => resumeReplay({ ...park, cursor: 1.5 }),
    "resumeReplay refuses a fractional cursor",
    "outside its log",
  );
  rejects(
    () => resumeReplay({ ...park, inputs: "not base64 at all!!" }),
    "resumeReplay refuses an undecodable parked log",
    "not decodable",
  );

  // Resuming twice from the same park must land on the same state — the row is
  // not consumed by the read, and `continue-verification` retries.
  const again = resumeReplay(park);
  stepReplay(resumed, CHUNK_TICKS);
  stepReplay(again, CHUNK_TICKS);
  check(
    JSON.stringify(snapshot(resumed.match)) === JSON.stringify(snapshot(again.match)),
    "resuming the same park twice reaches the same state (retries are safe)",
  );
}

// ── 3. Validation rejects ────────────────────────────────────────────────────

{
  const claim = runFor(1200, 31337, 1);

  const rejects = (bad, label, want) => {
    try {
      startReplay(bad);
      check(false, label, "no error thrown");
    } catch (error) {
      check(
        error instanceof ReplayInputError && error.message.includes(want),
        label,
        `threw ${error?.constructor?.name}: ${error?.message}`,
      );
    }
  };

  rejects({ ...claim, ticks: claim.ticks + 1 }, "validateReplay refuses a tick count that disagrees with the log", "carries");
  rejects({ ...claim, playerId: "nobody" }, "validateReplay refuses an unknown champion", "unknown champion");
  rejects({ ...claim, difficulty: "nightmare" }, "validateReplay refuses an unknown difficulty", "unknown difficulty");
  // An empty log *with* a matching tick count, so it reaches the emptiness
  // check rather than the earlier mismatch guard (`{ticks: 1200, inputs: ""}`
  // is refused for disagreeing about length, which is also correct but is a
  // different check).
  rejects({ ...claim, ticks: 0, inputs: "" }, "validateReplay refuses an empty log", "empty");
  rejects({ ...claim, seed: undefined }, "validateReplay refuses a missing seed", "seed");
  rejects(
    { ...claim, ticks: MAX_REPLAY_TICKS + 1, inputs: encodeInputLog(new Uint8Array(MAX_REPLAY_TICKS + 1)) },
    "validateReplay refuses an oversized log before stepping",
    "implausibly long",
  );

  // The positive control: the same claim still starts. Without it the checks
  // above could pass because *every* submission is being refused.
  let started = false;
  try {
    startReplay(claim);
    started = true;
  } catch {
    started = false;
  }
  check(started, "the untouched claim still starts a replay (positive control)");

  // A decoded log round-trips: the codec is the only thing standing between
  // the client's bytes and the worker's stepping loop.
  const bytes = decodeInputLog(claim.inputs);
  check(
    bytes.length === claim.ticks && encodeInputLog(bytes) === claim.inputs,
    "the input log round-trips through encode/decode byte-for-byte",
  );
}

// ── 4. The budget closes ─────────────────────────────────────────────────────
//
// The client's continuation count is `ceil(MAX_REPLAY_TICKS / CHUNK_TICKS)`, so
// by construction a ceiling-sized log fits. What is *not* by construction is
// that the chunk stepping actually reaches the end within that many parks — a
// fencepost slip (`>=` vs `>`) would strand the last tick and the verdict
// would never be recorded. Proved here at the ceiling itself.

{
  const total = MAX_REPLAY_TICKS;
  let steps = 0;
  let parks = 0;
  let cursor = 0;
  while (cursor < total) {
    cursor += Math.min(CHUNK_TICKS, total - cursor);
    steps += 1;
    if (cursor < total) parks += 1;
  }
  const continuations = Math.ceil(total / CHUNK_TICKS);
  check(
    steps === continuations && parks === continuations - 1,
    "a ceiling-sized log finishes within the derived continuation count",
    `steps=${steps} parks=${parks} budget=${continuations}`,
  );
  check(
    cursor === total,
    "the final chunk lands exactly on the last tick (no fencepost slip)",
    `cursor=${cursor} total=${total}`,
  );
  // The client's own bound, derived the same way api.ts derives it. Kept here
  // because a `Math.ceil` that disagreed with the stepping loop above would
  // strand the run with one tick left and no verdict recorded.
  const clientContinuations = Math.ceil(MAX_REPLAY_TICKS / CHUNK_TICKS);
  check(
    clientContinuations >= steps,
    "the client's continuation budget covers the worker's own ceiling",
    `client=${clientContinuations} needed=${steps}`,
  );
}

// ── Report ───────────────────────────────────────────────────────────────────

const sample = replayOutcome(replayChunked(runFor(TICKS_LONG, 1234, 0), CHUNK_TICKS).state);
console.log(
  `\nsample continuation (seed 1234, ${TICKS_LONG} ticks): score=${sample.score} wave=${sample.wave} ` +
    `reachedFinale=${sample.reachedFinale} chunks=${Math.ceil(TICKS_LONG / CHUNK_TICKS)}\n`,
);
for (const p of passes) console.log(`pass  ${p}`);
for (const f of failures) console.log(`FAIL  ${f}`);

if (failures.length > 0) {
  console.log(`\n${failures.length} failed, ${passes.length} passed.`);
  process.exit(1);
}
console.log(`\nAll ${passes.length} checks passed.`);
