#!/usr/bin/env node
/**
 * Replay harness — proves the engine is a pure function of (seed, inputs).
 *
 * ## Why this file exists
 *
 * Server-side replay is the only anti-cheat that cannot be forged: the client
 * sends its inputs, the server re-simulates them, and the score that falls out
 * is the only score that ever gets paid. That guarantee rests entirely on one
 * property, which nothing about the engine used to establish:
 *
 *     (same seed, same inputs)  =>  identical run
 *
 * Without it a server replay diverges from the client's run on the first random
 * branch and every check after that is noise. So this harness exists to fail
 * loudly the moment anyone reintroduces `Math.random()` into the simulation,
 * reads a clock inside the step loop, or changes the knockback constant.
 *
 * ## What it checks
 *
 * Determinism alone is easy to satisfy vacuously — a sim that ignores both
 * inputs and seed is perfectly deterministic. The three properties below only
 * pass together:
 *
 *   1. **Repeatability.** Same seed, same inputs, run twice *in separate
 *      processes* (so no module-level state can be carrying the result), the
 *      snapshots are identical.
 *   2. **Seed sensitivity.** A different seed changes the outcome — otherwise
 *      "deterministic" just means "ignores the seed".
 *   3. **Input sensitivity.** Different inputs change the outcome — otherwise
 *      the sim is ignoring its inputs and the replay proves nothing about play.
 *
 * Plus structural checks that the determinism *cannot* silently rot:
 *
 *   4. **Stream isolation.** `renderMatch` must be the only consumer of
 *      `Math.random()`. If rendering ever drew from the simulation's stream it
 *      would consume a frame-rate-dependent number of values between two
 *      `stepMatch` calls, and the same inputs would replay differently on a
 *      60 Hz phone and a 144 Hz monitor.
 *   5. **Portable math.** No `Math.hypot` in the sim (implementation-dependent
 *      rounding) and the knockback constant still equals the expression it
 *      replaced, so it cannot go stale if `FIXED_STEP_MS` ever changes.
 *
 * ## What it does not prove
 *
 * The behavioural checks cover what the scripted scenarios happen to reach, and
 * that is a real limit, not a formality. Reintroducing `Math.random()` into the
 * knockback tie-break (`delta === 0` in `applyHit`) was caught by the structural
 * scan and **not** by the determinism checks — even after the scripts were
 * improved to fight properly. Actors rarely end up at exactly the same `z`, so
 * that branch never fires here, and two processes still agreed with an unseeded
 * roll sitting in the sim.
 *
 * Which is why the structural checks matter more than they look: counting
 * `Math.random()` and confining it to `renderMatch` is coverage-independent, so
 * it holds for branches no synthetic script will ever reach. Trust that scan,
 * not the scenario, to catch unseeded randomness.
 *
 * Real replay will exercise far more of the engine than any script can — it is
 * driven by a logged human run rather than by this file. Stage B's shadow
 * replay compares against live client logs, which is where the remaining branches
 * actually get covered.
 *
 * ## Usage
 *
 *     node scripts/replayHarness.mjs
 *     npm run anticheat:replay
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
// The same file the game and the worker read. Deliberately not a local copy:
// three implementations of one bit-layout is three ways to disagree about it.
import { applyMask, inputMask } from "../shared/anticheat/inputLog.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(ROOT, "src/features/arcade/games/sunflowerbrawler/engine.ts");
const SESSION = path.join(ROOT, "src/features/arcade/games/sunflowerbrawler/session.ts");

// Bundled into the repo rather than the OS temp dir: keeps the artifact next to
// the code that produced it, survives parallel runs, and never mixes with a
// stale copy from another checkout.
const CACHE = path.join(ROOT, "node_modules/.cache/anticheat");
const ENTRY = path.join(CACHE, "entry.mjs");
const BUNDLE = path.join(CACHE, "engine.bundle.mjs");

const TICKS = 6000; // 100 s — longer than the shortest legal full run
const TICK_MS = 1000 / 60;

// ── Child mode ───────────────────────────────────────────────────────────────
//
// Each scenario runs in a fresh process. Two runs in one process would share
// module state and could agree for the wrong reason; only separate processes
// rule that out.

if (process.argv.includes("--child")) {
  const seed = Number(process.argv[process.argv.indexOf("--child") + 1]);
  const variant = Number(process.argv[process.argv.indexOf("--child") + 2] ?? 0);
  // A `file://` URL, not a bare path: on Windows a dynamic `import()` of
  // `C:\...` is rejected as an unsupported URL scheme.
  const mod = await import(pathToFileURL(BUNDLE).href);
  const { createMatch, stepMatch, readHud, emptyInput } = mod;
  const difficulty =
    mod.SUNFLOWER_BRAWLER_DIFFICULTIES.find((d) => d.name === "expert") ??
    mod.SUNFLOWER_BRAWLER_DIFFICULTIES[3];

  const input = emptyInput();
  const match = createMatch({ playerId: "barlow", difficulty, input, seed });

  // Scripted play that actually plays.
  //
  // Two earlier mistakes are worth recording, because both produced checks that
  // *passed* while proving nothing:
  //
  //  1. Setting `attackBuf = 150` on every tick looks like aggression but locks
  //     the player in a continuous combo string — `canAct` is false throughout,
  //     so walk input is discarded and the player pins itself to the left wall.
  //     Two "different" scripts then produced byte-identical runs.
  //
  //  2. Varying the *movement* legs per variant was worse: that script walked a
  //     leg order that never reached the wave-1 gate, so it never fought at all
  //     (`maxEnemies=0, maxWave=0`). It was testing determinism of an idle run.
  //
  // So movement is held constant — it is the part that reliably reaches combat
  // — and the variant varies swing and magic cadence instead. Still genuinely
  // different inputs, so the input-sensitivity check is real, but both runs are
  // in a fight.
  const legs = [1, 2, 3, 0];
  const attackEvery = 9 + variant * 4;
  const magicEvery = 240 - variant * 60;

  /** The scripted play, as a function of tick alone. */
  const applyScript = (inp, t) => {
    const leg = legs[Math.floor(t / 48) % legs.length];
    inp.left = leg === 1;
    inp.right = leg === 2;
    inp.up = leg === 3;
    inp.down = leg === 0;
    // Only occasionally, so the player spends most ticks free to move.
    inp.attackBuf = (t + variant * 5) % attackEvery === 0 ? 150 : 0;
    inp.magicBuf = (t + variant * 30) % magicEvery === 0 ? 150 : 0;
  };

  /** Everything two identical runs must agree on. */
  const plainSnapshot = (m) => {
    const hud = readHud(m);
    const first = m.enemies[0];
    return {
      score: hud.score,
      wave: hud.wave,
      phase: hud.phase,
      rngA: m.rng.a,
      playerX: m.player.x,
      playerZ: m.player.z,
      playerHp: m.player.hp,
      magic: m.magic,
      lives: m.lives,
      worldMs: m.worldMs,
      enemies: m.enemies.length,
      enemy0: first ? { x: first.x, z: first.z, hp: first.hp } : null,
      pickups: m.pickups.length,
      sparks: m.sparks.length,
      floaters: m.floaters.length,
      nextId: m.nextId,
      result: m.result,
      reachedFinale: m.reachedFinale,
    };
  };

  // Coverage accumulators. The snapshot is taken at the end of the run, where a
  // cleared wave leaves nothing behind to look at — end-state alone cannot tell
  // "combat happened and finished" from "nothing ever happened". Maxima and
  // ever-seen counters record what the run *went through*.
  //
  // This matters because a regression on a branch the scenario never reaches is
  // invisible to a behavioural check. Reintroducing `Math.random()` into the
  // knockback tie-break (`delta === 0`) was caught only by the structural scan:
  // that path never fires under this script, so two processes still agreed.
  let maxEnemies = 0;
  let maxWave = 0;
  let maxMagic = 0;
  let maxFloaters = 0;
  let maxPickups = 0;
  let sparkTicks = 0;

  for (let t = 0; t < TICKS; t++) {
    applyScript(input, t);

    stepMatch(match, TICK_MS);
    // Kept alive so the run never goes idle through death — a run that died at
    // tick 40 would compare equal for reasons that have nothing to do with
    // determinism.
    if (match.player.hp < match.player.maxHp) match.player.hp = match.player.maxHp;

    if (match.enemies.length > maxEnemies) maxEnemies = match.enemies.length;
    if (match.waveIndex > maxWave) maxWave = match.waveIndex;
    if (match.magic > maxMagic) maxMagic = match.magic;
    if (match.floaters.length > maxFloaters) maxFloaters = match.floaters.length;
    if (match.pickups.length > maxPickups) maxPickups = match.pickups.length;
    if (match.sparks.length > 0) sparkTicks++;
  }

  // ── Replay fidelity ───────────────────────────────────────────────────────
  //
  // The question Stage B actually turns on: does (seed, logged inputs)
  // reproduce the run *exactly*? If it does not, the worker's re-simulation
  // cannot be compared against the client's claim, and there is nothing to
  // measure a match rate against.
  //
  // Deliberately unlike the coverage run above in one respect: **no healing**.
  // Topping the player back up is an out-of-band state change the replay has no
  // way to know about, so including it would make this check measure the
  // harness's own intervention rather than the input encoding. A run that dies
  // part-way is the better test regardless — it exercises the death path, which
  // a kept-alive run never reaches.
  const logged = [];
  const original = createMatch({
    playerId: "barlow",
    difficulty,
    input: emptyInput(),
    seed,
  });
  for (let t = 0; t < TICKS; t++) {
    applyScript(original.playerInput, t);
    // Recorded before the step, exactly as the game does — `stepMatch` drains
    // the buffers, so sampling after would log the press as already spent.
    logged.push(inputMask(original.playerInput));
    stepMatch(original, TICK_MS);
  }

  // Reconstructed purely from what was logged. Nothing else about `original`
  // reaches this run: no shared state, no common RNG, no re-applied script.
  const replayed = createMatch({
    playerId: "barlow",
    difficulty,
    input: emptyInput(),
    seed,
  });
  for (const mask of logged) {
    // The shared decoder — exactly the call the worker will make. `bufferMs`
    // comes from the engine so the replay restores what the client actually
    // wrote on keydown; only `> 0` is ever read today, but passing the real
    // figure means that stops mattering if that ever changes.
    applyMask(replayed.playerInput, mask, mod.INPUT_BUFFER_MS);
    stepMatch(replayed, TICK_MS);
  }

  const originalSnapshot = plainSnapshot(original);
  const replayedSnapshot = plainSnapshot(replayed);

  // ── Chunked-park fidelity ────────────────────────────────────────────────
  //
  // The same replay, but re-serialised between chunks — which is what the
  // worker *actually* does. A run to the finale is ~10,000 ticks and the
  // Worker's CPU budget is 10 ms per request, so `claim-verified` steps 600
  // ticks, parks the match as JSON in D1, and lets `continue-verification`
  // resume it. Every one of those hops goes through `JSON.stringify` and
  // `JSON.parse`.
  //
  // That is the assumption the whole continuation design rests on, and it is a
  // genuinely risky one: JSON cannot express `NaN`, `Infinity` or `-0` (all
  // become `0` or `null`), nor `undefined` inside an array. Any of those in the
  // live `MatchState` would round-trip into a *different* number and the
  // resumed replay would diverge from the client's run — not visibly failing,
  // but silently reporting a mismatch against an honest player, which would
  // poison the match rate Stage B exists to measure.
  //
  // So this is the direct test rather than an argument: park it the way D1
  // does, resume, and require the final state to be identical to an unparked
  // replay of the same log.
  let parked = createMatch({
    playerId: "barlow",
    difficulty,
    input: emptyInput(),
    seed,
  });
  const CHUNK = 600; // the worker's configured chunk size
  let parks = 0;
  for (let i = 0; i < logged.length; i += CHUNK) {
    for (const mask of logged.slice(i, i + CHUNK)) {
      applyMask(parked.playerInput, mask, mod.INPUT_BUFFER_MS);
      stepMatch(parked, TICK_MS);
    }
    // The park — `JSON.parse(JSON.stringify(match))`, which is verbatim what
    // `replay_state` does to the match between requests. No restoration, no
    // special-casing: if the match needs a helping hand to survive this, the
    // worker does not get one either, and the honest failure is the point.
    //
    // (`playerInput` is a plain record of booleans and small numbers held only
    // by the match itself, so it crosses as data — verified by this very check
    // rather than assumed.)
    if (i + CHUNK < logged.length) {
      parked = JSON.parse(JSON.stringify(parked));
      parks += 1;
    }
  }
  const parkedSnapshot = plainSnapshot(parked);

  process.stdout.write(
    JSON.stringify({
      ...plainSnapshot(match),
      maxEnemies,
      maxWave,
      maxMagic,
      maxFloaters,
      maxPickups,
      sparkTicks,
      fidelityMatched:
        JSON.stringify(originalSnapshot) === JSON.stringify(replayedSnapshot),
      fidelityTicks: logged.length,
      fidelityScore: original.score,
      fidelityPhase: original.phase,
      fidelityLives: original.lives,
      replayScore: replayed.score,
      // The first field on which the two runs disagree, so a failure names the
      // divergence instead of only reporting that one occurred.
      fidelityDivergesAt: firstDivergingKey(originalSnapshot, replayedSnapshot),
      // The same comparison for the chunked, JSON-parked path.
      parkedMatched: JSON.stringify(originalSnapshot) === JSON.stringify(parkedSnapshot),
      parkedDivergesAt: firstDivergingKey(originalSnapshot, parkedSnapshot),
      parkedParks: parks,
    }),
  );
  process.exit(0);
}

/**
 * The first key whose values differ, or `null`. A fidelity failure without this
 * reduces to "the runs differ somewhere", which says nothing about where to
 * look — `rngA` diverging points somewhere very different from `playerHp`.
 */
function firstDivergingKey(a, b) {
  for (const key of Object.keys(a)) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return key;
  }
  return null;
}

// ── Parent mode ──────────────────────────────────────────────────────────────

const failures = [];
const passes = [];
const check = (ok, label, detail = "") => {
  if (ok) passes.push(label);
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
};

async function bundle() {
  mkdirSync(CACHE, { recursive: true });
  // A re-export shim, so one esbuild pass yields both the engine's exports and
  // the difficulty table the scenarios need. Absolute paths keep this working
  // regardless of where the process was started.
  const toUrl = (p) => p.split(path.sep).join("/");
  writeFileSync(
    ENTRY,
    [
      `export * from ${JSON.stringify(toUrl(ENGINE))};`,
      `export { SUNFLOWER_BRAWLER_DIFFICULTIES } from ${JSON.stringify(toUrl(SESSION))};`,
      "",
    ].join("\n"),
  );

  // esbuild's JS API rather than shelling out to `npx`: `npx` is `npx.cmd` on
  // Windows and `execFileSync` will not resolve a `.cmd` without `shell: true`,
  // which would then need every argument re-quoted. The API is also where the
  // `@nightshade/shared` alias can be stated explicitly instead of relying on
  // esbuild finding the tsconfig from a file inside `node_modules`.
  await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "esm",
    outfile: BUNDLE,
    loader: {
      ".png": "empty",
      ".webp": "empty",
      ".gif": "empty",
      ".mp3": "empty",
    },
    // The client's shared-module alias, mirroring `vite.config.ts` — the bundle
    // must import exactly the file the app does, or this harness would be
    // proving determinism for a copy the game never runs.
    alias: {
      "@nightshade/shared": path.join(ROOT, "shared").split(path.sep).join("/"),
    },
    define: { "import.meta.env": "{}" },
    logLevel: "error",
  });
}

function scenario(seed, variant) {
  const out = execFileSync(
    process.execPath,
    [fileURLToPath(import.meta.url), "--child", String(seed), String(variant)],
    { encoding: "utf8" },
  );
  return JSON.parse(out);
}

console.log("bundling engine...");
await bundle();

// Several (seed, input-script) combinations rather than one. A single scenario
// exercises one path through the engine, and a regression on an unreached branch
// is invisible to a behavioural check — which is exactly how the `Math.random()`
// knockback mutation slipped past the determinism tests below and was caught
// only by the structural scan.
const COMBOS = [
  [1234, 0],
  [99999, 0],
  [7, 1],
  [555, 1],
];

const runs = new Map();
const key = (seed, variant) => `${seed}/${variant}`;
for (const [seed, variant] of COMBOS) {
  runs.set(key(seed, variant), scenario(seed, variant));
}

// 1. Repeatability — every combination, each in a fresh pair of processes, so
//    module-level state cannot be carrying the result.
for (const [seed, variant] of COMBOS) {
  const first = scenario(seed, variant);
  const second = scenario(seed, variant);
  const identical = JSON.stringify(first) === JSON.stringify(second);
  check(
    identical,
    `seed ${seed} + script ${variant} reproduces in a second process`,
    `first divergence: ${firstDivergence(first, second)}`,
  );
}

const at = (seed, variant) => runs.get(key(seed, variant));

// 2. Seed sensitivity — same input script, different seed.
for (const [a, b, variant] of [
  [1234, 99999, 0],
  [7, 555, 1],
]) {
  const differs = JSON.stringify(at(a, variant)) !== JSON.stringify(at(b, variant));
  check(
    differs,
    `seed ${a} vs ${b} (script ${variant}) produces different runs`,
    differs ? "" : `seed appears unused — both runs ${JSON.stringify(at(a, variant))}`,
  );
}

// 3. Input sensitivity.
const inputDiffers =
  JSON.stringify(at(1234, 0)) !== JSON.stringify(at(1234, 1));
check(
  inputDiffers,
  "different inputs change the run",
  inputDiffers ? "" : "sim is ignoring its inputs; determinism here is vacuous",
);

// 4. Coverage — the scenario has to actually fight. Determinism over a run that
//    never left the opening would pass while proving nothing about the branches
//    a real claim exercises. `sparkTicks` counts ticks with live hit-sparks, so
//    it is a proxy for swings landing rather than merely being thrown.
const covered = COMBOS.map(([seed, variant]) => ({ seed, variant, ...at(seed, variant) }));
for (const r of covered) {
  check(
    r.maxEnemies >= 3 && r.sparkTicks > 0 && r.maxWave >= 1,
    `seed ${r.seed}/${r.variant} exercised combat and wave progression`,
    `maxEnemies=${r.maxEnemies} sparkTicks=${r.sparkTicks} maxWave=${r.maxWave}`,
  );
}

// 5. Replay fidelity — the check Stage B exists to establish.
//
// Every other property here is a precondition; this is the payoff. If a run
// cannot be rebuilt from (seed, logged inputs), the worker's re-simulation
// describes a different run than the client played and a "match rate" would be
// measuring nothing.
for (const r of covered) {
  check(
    r.fidelityMatched === true,
    `seed ${r.seed}/${r.variant} replays exactly from (seed, logged inputs)`,
    r.fidelityMatched
      ? ""
      : `diverged at ${r.fidelityDivergesAt} after ${r.fidelityTicks} ticks ` +
        `(original score=${r.fidelityScore}/${r.fidelityPhase}/lives=${r.fidelityLives}, ` +
        `replay score=${r.replayScore})`,
  );
}

// 6. Chunked-park fidelity — the check Stage B3 rests on.
//
// The worker cannot replay ten thousand ticks inside one 10 ms request, so it
// parks the match as JSON in D1 and resumes on the next call. That makes every
// replay a sequence of `JSON.parse(JSON.stringify(...))` hops, and JSON is not
// a faithful transport for every number JavaScript can hold: `NaN` and
// `Infinity` collapse to `null`, and `-0` arrives back as `0`. A match that
// carried any of those would resume into a subtly different simulation and
// report a mismatch against a run the player actually played.
//
// Asserted separately from #5 because it can fail on its own: a run that
// replays perfectly in one piece can still fall apart at a park boundary, and
// #5 would stay green while every real continuation diverged.
for (const r of covered) {
  check(
    r.parkedMatched === true,
    `seed ${r.seed}/${r.variant} survives ${r.parkedParks} JSON park(s) byte-for-byte`,
    r.parkedMatched
      ? ""
      : `diverged at ${r.parkedDivergesAt} after ${r.fidelityTicks} ticks ` +
        `(unparked replay agrees; the park is the difference)`,
  );
}

// The fidelity runs are deliberately unhealed, so a death mid-run would be a
// *legitimate* outcome — but a run that never fought would mean the log was
// too short to be worth replaying. Same floor as the coverage check.
for (const r of covered) {
  check(
    r.fidelityTicks === TICKS,
    `seed ${r.seed}/${r.variant} logged every tick`,
    `logged ${r.fidelityTicks} of ${TICKS}`,
  );
  check(
    r.fidelityScore > 0 || r.fidelityPhase === "down" || r.fidelityPhase === "gameover",
    `seed ${r.seed}/${r.variant} fidelity run reached combat`,
    `score=${r.fidelityScore} phase=${r.fidelityPhase}`,
  );
}

// 4. Stream isolation — structural, because rendering cannot be exercised here
//    without a canvas.
//
// Comments are stripped before scanning: `rngNext`'s own docblock explains the
// `Math.random()` situation in prose, and counting prose made the first run of
// this harness report five "sim" sites where there were two. The guard on `//`
// (a preceding non-colon character) keeps URLs in strings from being clipped.
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const src = stripComments(readFileSync(ENGINE, "utf8"));
const renderAt = src.indexOf("export const renderMatch");
check(renderAt !== -1, "renderMatch is present (structural check target)");

const randomSites = [...src.matchAll(/Math\.random\(\)/g)].map((m) => m.index);
check(
  randomSites.length === 2,
  "exactly two Math.random() calls remain in engine.ts",
  `found ${randomSites.length}`,
);
check(
  randomSites.every((i) => i > renderAt),
  "every remaining Math.random() is inside renderMatch",
  randomSites
    .filter((i) => i < renderAt)
    .map((i) => `line ${src.slice(0, i).split("\n").length}`)
    .join(", ") || "one or more sim sites still draw from the render stream",
);
check(
  !/Math\.hypot\(/.test(src),
  "no Math.hypot in the sim (implementation-dependent rounding)",
);

// 5. The precomputed constant must still match the expression it replaced.
const literal = src.match(/KNOCK_DECAY_PER_TICK = ([0-9.eE+-]+)/);
const expected = Math.exp(-6 * ((1000 / 60) / 1000));
check(
  literal !== null && Number(literal[1]) === expected,
  "KNOCK_DECAY_PER_TICK still equals Math.exp(-6 * FIXED_STEP_MS/1000)",
  literal
    ? `found ${literal[1]}, expected ${expected} — FIXED_STEP_MS changed?`
    : "constant not found in engine.ts",
);

// ── Report ───────────────────────────────────────────────────────────────────

const sample = at(1234, 0);
console.log(
  `\nsample run (seed 1234): score=${sample.score} wave=${sample.wave} phase=${sample.phase}\n` +
    `  coverage: maxEnemies=${sample.maxEnemies} sparkTicks=${sample.sparkTicks} maxWave=${sample.maxWave} maxPickups=${sample.maxPickups} rngA=${sample.rngA}\n`,
);
for (const p of passes) console.log(`pass  ${p}`);
for (const f of failures) console.log(`FAIL  ${f}`);

if (failures.length > 0) {
  console.log(`\n${failures.length} failed, ${passes.length} passed.`);
  process.exit(1);
}
console.log(`\nAll ${passes.length} checks passed.`);

function firstDivergence(a, b) {
  for (const key of Object.keys(a)) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      return `${key}: ${JSON.stringify(a[key])} vs ${JSON.stringify(b[key])}`;
    }
  }
  return "none";
}
