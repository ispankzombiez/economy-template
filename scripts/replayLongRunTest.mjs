#!/usr/bin/env node
/**
 * Long-run parity — a *full-length* run, replayed the way production replays it.
 *
 * ## Why this exists beside the harness and the continuation test
 *
 * Both of those top out around 3,000 ticks — about fifty seconds, waves one to
 * three, grunts only. Every live claim is ~21,600 ticks: six minutes through
 * fifteen waves, with between-wave walks and ambushes, heavy and boss enemies
 * using specials, pickups, magic, deaths and respawns. A divergence that only
 * bites in those later phases is invisible to a short run, and the one thing
 * the live brawler verdicts have never once shown is a match.
 *
 * The live mismatch (claim 45,040 vs replay 17,670, `reachedFinale=false` after
 * stepping every logged tick) is exactly the shape a mid-run divergence takes:
 * the replayed player fights the wrong game and dies partway. Static analysis
 * finds no channel — engine is pure, the mask covers every input field, the
 * specs are untouched, the JSON park round-trips — so the remaining question is
 * empirical: does the current stack replay a *production-length* run exactly?
 *
 * ## What it checks, per scenario
 *
 *  1. **One pass.** `startReplay` + `stepReplay` over the whole claim reaches
 *     the same score, wave and `reachedFinale` the client's run had at its
 *     freeze.
 *  2. **Chunked, with a JSON park at every boundary.** The same claim replayed
 *     in `CHUNK_TICKS` slices — `JSON.parse(JSON.stringify(match))` between
 *     every slice, verbatim what `writeReplayState`/`readReplayState` do —
 *     ends on a byte-identical match, not merely an equal score.
 *  3. **The production verdict holds.** `score === claimScore && reachedFinale
 *     === true` — the exact predicate `claim-verified` mints on. A finale run
 *     must satisfy it; a death run must at least replay to its own defeat.
 *
 * The bot plays like a person: chases the nearest enemy, presses attack on a
 * beat (as an *event* — the buffer then decays through the mask exactly as a
 * real keypress does), casts when charged, runs away at low health, holds right
 * to walk the street between waves.
 *
 * ## Usage
 *
 *     node scripts/replayLongRunTest.mjs
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

const CACHE = path.join(ROOT, "node_modules/.cache/anticheat");
const ENTRY = path.join(CACHE, "longrun-entry.mjs");
const BUNDLE = path.join(CACHE, "longrun.bundle.mjs");

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
      // Two spellings of one package, and the worker's is *not* the client's —
      // see replayContinuationTest.mjs for the full story. Same directory
      // answers both, which is the point of shipping one copy.
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
const { createMatch, stepMatch, emptyInput, FIXED_STEP_MS, INPUT_BUFFER_MS, MAGIC_COST } = mod;
const {
  CHUNK_TICKS,
  MAX_REPLAY_TICKS,
  isReplayComplete,
  replayOutcome,
  resumeReplay,
  startReplay,
  stepReplay,
  inputMask,
  encodeInputLog,
} = mod;
const { SUNFLOWER_BRAWLER_DIFFICULTIES } = mod;

const difficulty =
  SUNFLOWER_BRAWLER_DIFFICULTIES.find((d) => d.name === "expert") ??
  SUNFLOWER_BRAWLER_DIFFICULTIES[3];

/**
 * Play one tick, like a person at the cabinet.
 *
 * Reads the client's *own* match state — the real player reads the screen, and
 * the replay never calls this; it only consumes the masks this play produced.
 * Presses are events: the buffer is set once and then decays through the
 * engine's timers, so the mask records a multi-tick `>0` run and the replay's
 * `applyMask` resets it every one of those ticks — the exact equivalence the
 * codec's docstring argues and this test needs to keep true at length.
 */
function driveBot(input, match, t, variant) {
  input.left = false;
  input.right = false;
  input.up = false;
  input.down = false;

  const p = match.player;
  let target = null;
  let best = Infinity;
  for (const e of match.enemies) {
    if (e.action === "ko") continue;
    const d = Math.abs(e.x - p.x) + Math.abs(e.z - p.z) * 2;
    if (d < best) {
      best = d;
      target = e;
    }
  }

  if (target) {
    const dx = target.x - p.x;
    const dz = target.z - p.z;
    const threatened = Math.abs(dx) < 46 && Math.abs(dz) < 22;
    const coward = variant >= 5;
    if (coward || (p.hp < p.maxHp * 0.25 && threatened)) {
      // Run away — the only survival mechanic a bot has besides lives.
      if (dx > 0) input.left = true;
      else input.right = true;
      if (dz > 0) input.up = true;
      else input.down = true;
    } else {
      if (dx > 30) input.right = true;
      else if (dx < -30) input.left = true;
      if (dz > 12) input.down = true;
      else if (dz < -12) input.up = true;
      const beat = 5 + (variant % 4) * 2; // variants press at different rhythms
      if (Math.abs(dx) <= 52 && Math.abs(dz) <= 20 && t % beat === variant % beat) {
        input.attackBuf = INPUT_BUFFER_MS;
      }
    }
    if (variant < 5 && match.magic >= MAGIC_COST && t % (17 + variant * 9) === 3) {
      input.magicBuf = INPUT_BUFFER_MS;
    }
  } else if (match.phase === "walking") {
    // Walk the street until the camera settles and the wave opens.
    input.right = true;
  }
}

/**
 * The client's half, at production fidelity: log before every step, stop
 * logging the moment the claim freezes (finale cleared, or the run is over),
 * and that frozen prefix *is* the claim.
 */
function playToClaim(ticks, seed, variant) {
  const input = emptyInput();
  const match = createMatch({ playerId: "barlow", difficulty, input, seed });
  const logged = [];
  let frozenAt = -1;
  for (let t = 0; t < ticks; t++) {
    if (frozenAt >= 0) break; // the component stops *logging*, not stepping —
    // stepping on would only matter for endless waves nobody claims.
    driveBot(input, match, t, variant);
    logged.push(inputMask(input));
    stepMatch(match, FIXED_STEP_MS);
    if (frozenAt < 0 && (match.reachedFinale || match.result !== null)) {
      frozenAt = logged.length;
    }
  }
  if (frozenAt < 0) frozenAt = logged.length;
  const claim = {
    seed,
    playerId: "barlow",
    difficulty: difficulty.name,
    ticks: frozenAt,
    inputs: encodeInputLog(Uint8Array.from(logged.slice(0, frozenAt))),
  };
  return { claim, match };
}

const snapshot = (m) => JSON.parse(JSON.stringify(m));

/** The worker's half, the way it really runs: slice, park as JSON, resume. */
function replayChunked(claim, chunk) {
  let state = startReplay(claim);
  let parks = 0;
  while (!isReplayComplete(state)) {
    stepReplay(state, chunk);
    if (isReplayComplete(state)) break;
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

// ── Scenarios ────────────────────────────────────────────────────────────────
//
// Production-length and beyond, several seeds, several play rhythms, one
// coward that spends the run fleeing (to exercise deaths, lives and respawns),
// and ceilings chosen so at least some runs must reach the finale for the
// verdict predicate to be checkable at all.

const SCENARIOS = [
  { ticks: 21_600, seed: 1234, variant: 0 },
  { ticks: 21_600, seed: 99_999, variant: 1 },
  { ticks: 36_000, seed: 7, variant: 2 },
  { ticks: 45_000, seed: 424_242, variant: 3 },
  { ticks: 60_000, seed: 31_337, variant: 4 },
  { ticks: 21_600, seed: 555_555, variant: 5 },
];

if (MAX_REPLAY_TICKS < 60_000) {
  check(false, "scenario ceilings fit under MAX_REPLAY_TICKS", `cap=${MAX_REPLAY_TICKS}`);
}

let finaleRuns = 0;
let defeatRuns = 0;

for (const { ticks, seed, variant } of SCENARIOS) {
  const started = Date.now();
  const { claim, match: client } = playToClaim(ticks, seed, variant);

  check(
    claim.ticks > 0,
    `seed ${seed}/v${variant}: the bot actually played`,
    `froze at ${claim.ticks} ticks`,
  );

  const one = startReplay(claim);
  stepReplay(one, one.total);
  const oneOutcome = replayOutcome(one);

  const { state: many, parks } = replayChunked(claim, CHUNK_TICKS);
  const manyOutcome = replayOutcome(many);

  const clientOutcome = replayOutcome({
    match: client,
    cursor: claim.ticks,
    total: claim.ticks,
  });

  check(
    JSON.stringify(oneOutcome) === JSON.stringify(manyOutcome),
    `seed ${seed}/v${variant}: chunked replay agrees with a single pass`,
    `single=${JSON.stringify(oneOutcome)} chunked=${JSON.stringify(manyOutcome)}`,
  );

  // The full match, not just the verdict: two runs can agree on score while the
  // enemy positions underneath have diverged, and the next chunk would then
  // step a different game.
  check(
    JSON.stringify(snapshot(one.match)) === JSON.stringify(snapshot(many.match)),
    `seed ${seed}/v${variant}: chunked replay's final match is identical to single-pass`,
  );

  check(
    JSON.stringify(oneOutcome) === JSON.stringify(clientOutcome),
    `seed ${seed}/v${variant}: replay reproduces the run the client played`,
    `client=${JSON.stringify(clientOutcome)} replay=${JSON.stringify(oneOutcome)}`,
  );

  check(
    parks === Math.ceil(claim.ticks / CHUNK_TICKS) - 1,
    `seed ${seed}/v${variant}: parked once per chunk boundary`,
    `parks=${parks}, expected ${Math.ceil(claim.ticks / CHUNK_TICKS) - 1}`,
  );

  // The production verdict, verbatim: this is what mints the coin. The claim's
  // score is the client's frozen `match.score` — here, the replayable stand-in
  // for the payload's `score` field.
  const matched =
    oneOutcome.score === clientOutcome.score && oneOutcome.reachedFinale === true;
  if (oneOutcome.reachedFinale) {
    finaleRuns += 1;
    check(
      matched,
      `seed ${seed}/v${variant}: finale run satisfies the mint predicate`,
      `client=${clientOutcome.score} replay=${oneOutcome.score} reachedFinale=${oneOutcome.reachedFinale}`,
    );
  } else {
    defeatRuns += 1;
    // Not a mint candidate — but its defeat must be *the same defeat*.
    check(
      oneOutcome.score === clientOutcome.score && oneOutcome.wave === clientOutcome.wave,
      `seed ${seed}/v${variant}: non-finale run replays to the same place`,
      `client=${JSON.stringify(clientOutcome)} replay=${JSON.stringify(oneOutcome)}`,
    );
  }

  console.log(
    `  seed ${seed}/v${variant}: ${claim.ticks} ticks (${(claim.ticks / 60).toFixed(0)}s), ` +
      `score ${oneOutcome.score}, wave ${oneOutcome.wave}, finale=${oneOutcome.reachedFinale}, ` +
      `${parks} parks, ${Date.now() - started}ms`,
  );
}

console.log(`\n  ${passes.length} passed, ${failures.length} failed ` +
  `(finale runs: ${finaleRuns}, non-finale: ${defeatRuns})`);

if (failures.length > 0) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
