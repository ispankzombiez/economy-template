#!/usr/bin/env node
/**
 * Goblin Invaders replay harness — proves `(difficulty, seed, inputs) => the
 * same run`.
 *
 * ## Why this file exists
 *
 * The worker mints a Raven Coin only if its own re-run of the claimed session
 * ends `gameOver && won` at the score the claim asserts. That guarantee rests
 * on three properties, and this harness fails loudly the moment any breaks:
 *
 *   1. **Determinism.** The step function has no `Math.random()` and no clock:
 *      every roll — the mystery ship's respawn delay, its direction and its
 *      points, the source column of each enemy shot — draws from a mulberry32
 *      stream seeded by the server-issued run seed, and the difficulty is
 *      baked into the runtime at run-open. So `(difficulty, seed, inputs)`
 *      fixes the run on any machine.
 *   2. **Parity.** The log the component's loop produces — one input byte per
 *      16ms step, sampled *before* the step — is exactly the log the worker's
 *      replay driver consumes, through the same `tick` both ends import. A
 *      divergence here would refuse honest players for a difference nobody
 *      can see.
 *   3. **Streamability.** A run is thousands of steps, far past one Worker's
 *      CPU budget, so it is replayed in `CHUNK_TICKS` windows with the match
 *      parked between them. The park goes through D1 as JSON, so the runtime
 *      must survive a JSON round trip at every boundary unchanged — the
 *      reason the seed and the difficulty ride *on* the runtime rather than
 *      being looked up at step time.
 *
 * ## What it checks
 *
 *   - **The input codec round trips** — every keyboard byte (direction +
 *     fire) through encode and decode, every quantised scrub position 0..127,
 *     and the bytes the client could never write (the reserved direction bits
 *     `3`, and the gap `7..127` between the keyboard layout and the scrub
 *     tag).
 *   - **The seed is the worker's, not the claim's** — the ledger seed is
 *     required (`assertRunSeed` refuses a missing one with no fallback), the
 *     same seed twice builds the same opening rolls, and a different seed
 *     builds a different run that no log can paper over.
 *   - **Difficulty is the worker's, not the claim's** — today's and
 *     yesterday's names validate (a run may straddle UTC midnight); any other
 *     is refused before a single step ("always claim easy" buys nothing).
 *   - **Malformed submissions are refused** — missing replay, missing/garbage
 *     inputs, `ticks` disagreeing with the byte count, an empty log, a
 *     fractional/negative/over-ceiling tick count, a byte outside the
 *     encoding.
 *   - **A real win pays** — a bot-played session replays step-for-step to an
 *     identical final runtime, through the chunked park/continue pipeline
 *     with a JSON round trip per window, and its verdict matches.
 *   - **Forgery is refused** — a score that disagrees with its own log, a
 *     truncated log (the park's binding refuses it), a spliced tail (the run
 *     diverges), a finished session the player did not win.
 *   - **Post-win bytes cannot inflate** — steps after `gameOver` are no-ops,
 *     so padding a winning log with junk changes nothing the worker pays.
 *   - **The engine is exact-ops only** — source scan: no RNG, no clock, and
 *     no transcendental (`Math.sin`/`cos`/`atan2`/`hypot`/`pow`/…), whose
 *     last-ulp freedom is implementation-defined; `sqrt` (IEEE 754 specifies
 *     it exactly) is exempt.
 *   - **Budget** — every chunk request's stepping fits a Worker request
 *     (loosely, 25 ms), and a real run needs more than one chunk.
 *
 * ## How the bot plays
 *
 * Goblin Invaders' input is a held direction plus a fire press (and, on
 * touch, an absolute finger position — the codec covers both). The bot's
 * policy is reactive and stateless, which is exactly what the engine rewards:
 *
 *   - **Fire always** — the engine holds one player shot in flight at a time,
 *     so a standing fire bit *is* max fire rate, and a constant stream of
 *     player shots cancels incoming enemy shots on contact (the classic
 *     Space Invaders rule).
 *   - **Dodge first** — any enemy shot inside the danger band below the
 *     formation and within 60 px of the ship sends it the other way, at full
 *     speed, before anything else is considered. At 420 px/s against a 260
 *     px/s shot there is hundreds of pixels of margin once a shot is
 *     detected.
 *   - **Aim otherwise** — walk to the nearest column still holding a goblin;
 *     the shot upward hits the topmost goblin in that column first, so
 *     columns clear top-down without aiming at rows.
 *
 * The loss session is the *absence* of that policy: a bot that never fires
 * and never moves lets the formation walk down and take the run honestly.
 *
 * ## How it runs
 *
 * Node cannot import TypeScript, and the worker imports the engine with one
 * spelling of `@nightshade/shared` while the client uses another — so,
 * exactly like `froggerReplayTest.mjs`, everything is bundled by esbuild
 * with a resolve plugin answering both spellings *from the same directory*,
 * which is the entire point of the shared package: one file, two ends.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(
  ROOT,
  "src/features/arcade/games/goblininvaders/engine.ts",
);
const SESSION = path.join(
  ROOT,
  "src/features/arcade/games/goblininvaders/session.ts",
);
const WORKER_REPLAY = path.join(ROOT, "worker/src/goblinInvadersReplay.js");
// `ReplayInputError` and `CHUNK_TICKS` live in the brawler's module — the
// shared plumbing every streamed cabinet throws and budgets against.
const SHARED_STREAM = path.join(ROOT, "worker/src/replay.js");
const SHARED = path.join(ROOT, "shared/anticheat");

const CACHE = path.join(ROOT, "node_modules/.cache/anticheat");
const ENTRY = path.join(CACHE, "goblininvaders-entry.mjs");
const BUNDLE = path.join(CACHE, "goblininvaders.bundle.mjs");

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
    `export * from ${JSON.stringify(toUrl(SESSION))};`,
    `export * from ${JSON.stringify(toUrl(WORKER_REPLAY))};`,
    `export * from ${JSON.stringify(toUrl(SHARED_STREAM))};`,
    `export * from ${JSON.stringify(toUrl(path.join(SHARED, "inputLog.js")))};`,
  ].join("\n"),
);

await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: BUNDLE,
  // The brawler's module rides along (ReplayInputError, CHUNK_TICKS); none of
  // that executes here, and the engine imports no art assets at all.
  loader: {
    ".png": "empty",
    ".webp": "empty",
    ".gif": "empty",
    ".mp3": "empty",
  },
  plugins: [
    {
      // Client code imports `@nightshade/shared/anticheat/<file>`; the worker
      // imports the package subpath `@nightshade/shared/<file>`, resolved by
      // `shared/package.json`'s `exports` map. Neither spelling resolves on
      // its own under a single alias, so both are answered here — from the
      // same directory, which is the entire point of the package: one file,
      // two ends.
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
const {
  // Engine
  FIXED_STEP_MS,
  encodeTick,
  decodeTick,
  createRuntime,
  tick,
  ARENA_WIDTH,
  PLAYER_SIZE,
  PLAYER_Y,
  ENEMY_WIDTH,
  // Session (difficulty derivation, shared with the worker)
  GOBLIN_INVADERS_DIFFICULTIES,
  getGoblinInvadersDifficulty,
  // Worker verifier
  validateGoblinInvadersReplay,
  startGoblinInvadersReplay,
  openGoblinInvadersChunkReplay,
  stepGoblinInvadersReplay,
  goblinInvadersOutcome,
  // Shared streamed plumbing (the brawler's module)
  ReplayInputError,
  CHUNK_TICKS,
  // Codec
  encodeInputLog,
  decodeInputLog,
} = mod;

const MAX_REPLAY_TICKS = 64_000; // shared/anticheat/replayBudget.js

const bytesToWire = (bytes) => encodeInputLog(Uint8Array.from(bytes));

// ─────────────────────────────────────────────────────────────────────────────
// The client's half: a bot that plays the way a player does.
//
// Reactive and stateless: fire always (the engine holds one shot in flight,
// so the standing bit *is* max fire rate, and the shot stream cancels enemy
// shots on contact), dodge any shot inside the danger band before anything
// else, otherwise walk to the nearest column still holding a goblin. Random
// lives only in the harness's seed search, never in the engine.
// ─────────────────────────────────────────────────────────────────────────────

const IDLE = { dir: 0, fire: false, scrub: null };

/** A shot this close (above the ship, inside 60 px horizontally) must be dodged. */
const DANGER_BAND_ABOVE = 220;
const DANGER_X = 60;

/**
 * The bot's per-tick decision. Stateless — the whole policy is visible in
 * one function, which is what makes the live run replay identically: the
 * worker re-runs this same policy's *log*, not this policy.
 *
 * @param {{ fires?: boolean }} opts `fires: false` is the loss bot (never
 *   shoots; the formation walks down and takes the run).
 */
function makeBot({ fires = true } = {}) {
  return function choose(g) {
    if (g.gameOver) return IDLE;
    // The recovery pause swallows inputs anyway (the step returns early), but
    // the client's loop logs one byte per step regardless — so does the bot.
    if (g.respawnPauseMs > 0) return IDLE;

    const playerCenter = g.playerX + PLAYER_SIZE / 2;

    // ── Dodge first ────────────────────────────────────────────────────────
    // The nearest shot still inside the danger band: anything above the ship
    // within a couple of seconds of landing, and within reach of it. At
    // 420 px/s against a 260 px/s shot, a shot detected 220 px up is beaten
    // by ~350 px of lateral movement — several times the 60 px that makes it
    // a threat in the first place.
    let threat = null;
    for (const shot of g.enemyShots) {
      if (
        shot.y > PLAYER_Y - DANGER_BAND_ABOVE &&
        shot.y < PLAYER_Y + 40 &&
        (threat === null || shot.y > threat.y)
      ) {
        threat = shot;
      }
    }

    let dir = 0;
    let dodging = false;
    if (threat !== null && Math.abs(playerCenter - threat.x) < DANGER_X) {
      const dx = playerCenter - threat.x;
      // Away from the shot; dead-centre picks the side with more room.
      dir =
        dx > 0
          ? 1
          : dx < 0
            ? -1
            : playerCenter < ARENA_WIDTH / 2
              ? 1
              : -1;
      dodging = true;
    }

    // ── Otherwise aim ──────────────────────────────────────────────────────
    // The nearest column still holding a goblin. The shot hits the *topmost*
    // goblin in its path first (the collision scan runs in row order), so
    // columns clear top-down without ever aiming at a row.
    if (!dodging) {
      let best = null;
      for (const enemy of g.enemies) {
        if (!enemy.alive) continue;
        const center = enemy.x + ENEMY_WIDTH / 2;
        const distance = Math.abs(center - playerCenter);
        if (best === null || distance < best.distance) {
          best = { center, distance };
        }
      }
      if (best !== null && best.distance > 5) {
        dir = best.center > playerCenter ? 1 : -1;
      }
    }

    return { dir, fire: fires, scrub: null };
  };
}

/**
 * Play a whole session the way the component's loop does: sample the input,
 * log its byte, step, repeat — and stop when the run settles.
 */
function playSession(difficulty, seed, bot, { stepCap = 60_000 } = {}) {
  let game = createRuntime(difficulty, seed);
  const choose = bot;
  const bytes = [];

  while (!game.gameOver && bytes.length < stepCap) {
    const input = choose(game);
    bytes.push(encodeTick(input));
    game = tick(game, FIXED_STEP_MS, input);
  }

  return { game, bytes };
}

// ─────────────────────────────────────────────────────────────────────────────
// The worker's half, as the three intents actually drive it.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The streamed pipeline, exactly as `verify-chunk` + `claim-verified` +
 * `continue-verification` run it: windows of `CHUNK_TICKS`, the match parked
 * between requests **through JSON** (that is what D1 stores), the seed on the
 * opening window the ledger's (chunk 0 is where the worker builds the run),
 * the claim resuming the park and stepping only the tail.
 */
function chunkedReplay({
  difficultyName,
  seed,
  bytes,
  chunkTicks = CHUNK_TICKS,
}) {
  let state = null;
  let worstChunkMs = 0;

  for (let start = 0; start < bytes.length; start += chunkTicks) {
    const window = Uint8Array.from(bytes.slice(start, start + chunkTicks));
    if (start === 0) {
      state = openGoblinInvadersChunkReplay({
        seed,
        difficulty: difficultyName,
        inputs: window,
      });
    } else {
      // The park grows by exactly the ticks it receives — see appendChunkInputs.
      state.inputs = Uint8Array.from([...state.inputs, ...window]);
      state.total = state.inputs.length;
    }

    const t0 = performance.now();
    stepGoblinInvadersReplay(state, chunkTicks);
    const windowMs = performance.now() - t0;
    if (process.env.GI_TRACE_CHUNKS && windowMs > 10) {
      console.log(
        `  [trace] window ${start / chunkTicks}: ${windowMs.toFixed(2)} ms (${window.length} bytes)`,
      );
    }
    worstChunkMs = Math.max(worstChunkMs, windowMs);

    // Park through D1's representation.
    state.match = JSON.parse(JSON.stringify(state.match));
  }

  return { state, worstChunkMs };
}

/** The claim's own request: validate, resume the park, step the tail, judge. */
function claimVerdict({ difficultyName, seed, bytes, claimScore, park }) {
  const validated = validateGoblinInvadersReplay({
    difficulty: difficultyName,
    ticks: bytes.length,
    inputs: bytesToWire(bytes),
  });

  // The binding a claim must satisfy: the park holds exactly this log.
  if (park.total !== validated.total) {
    return { matched: null, reason: "park/claim length binding failed" };
  }

  const resumed = {
    match: park.match,
    inputs: validated.inputs,
    cursor: park.cursor,
    total: park.total,
  };
  stepGoblinInvadersReplay(resumed, CHUNK_TICKS); // the tail — usually zero steps

  if (resumed.cursor !== resumed.total) {
    return { matched: null, reason: "replay in progress" };
  }

  const outcome = goblinInvadersOutcome(resumed);
  const matched =
    outcome.score === claimScore && outcome.reachedFinale === true;
  return { matched, replayScore: outcome.score, outcome };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The input codec
// ─────────────────────────────────────────────────────────────────────────────

{
  // Every keyboard byte the client can write round trips: the layout is
  // `dir + 1 | fire`, so −1 → 0, 0 → 1, +1 → 2 with bit 2 (0x04) the fire.
  for (const dir of [-1, 0, 1]) {
    for (const fire of [false, true]) {
      const input = { dir, fire, scrub: null };
      const code = encodeTick(input);
      check(
        code === ((dir + 1) | (fire ? 4 : 0)),
        `keyboard (${dir}, fire=${fire}) encodes to ${(dir + 1) | (fire ? 4 : 0)} (${code})`,
      );
      const back = decodeTick(code);
      check(
        back !== null && back.dir === dir && back.fire === fire && back.scrub === null,
        `keyboard round trip: dir ${dir}, fire ${fire}`,
      );
    }
  }

  // Spot checks of the layout.
  check(
    encodeTick({ dir: -1, fire: false, scrub: null }) === 0,
    "left is 0",
  );
  check(
    encodeTick({ dir: 1, fire: false, scrub: null }) === 2,
    "right is 2",
  );
  check(
    encodeTick({ dir: 0, fire: true, scrub: null }) === 5,
    "fire is bit 2 (0x04)",
  );

  // Every quantised scrub position round trips exactly: bits 0–6 carry the
  // finger at 128 levels of the ship's travel.
  for (let level = 0; level <= 127; level++) {
    const ratio = level / 127;
    const code = encodeTick({ dir: 0, fire: false, scrub: ratio });
    check(code === (0x80 | level), `scrub level ${level} encodes to ${code}`);
    const back = decodeTick(code);
    check(
      back !== null && back.scrub === ratio && back.dir === 0 && back.fire === false,
      `scrub round trip: level ${level}`,
    );
  }

  // A raw (unquantised) ratio still lands within one level of itself — the
  // ship parks under the finger, not one level short of it.
  const raw = decodeTick(encodeTick({ dir: 0, fire: false, scrub: 0.5 }));
  check(
    raw !== null && Math.abs(raw.scrub - 0.5) <= 1 / 127,
    "an unquantised scrub ratio survives within one level",
  );

  // Bytes the client could never have written: the reserved direction bits
  // (`0b11`), and the gap between the keyboard layout (≤ 6) and the scrub tag
  // (≥ 128).
  for (const bad of [3, 7, 8, 16, 31, 64, 100, 127]) {
    check(
      decodeTick(bad) === null,
      `byte ${bad} is not an input the client can produce`,
    );
  }
  // The scrub tag itself always decodes.
  for (const scrubByte of [128, 192, 254, 255]) {
    check(decodeTick(scrubByte) !== null, `scrub byte ${scrubByte} decodes`);
  }

  // The claim's journey: bytes → base64 → JSON → decoded bytes.
  const sample = [0, 1, 2, 4, 5, 6, 128, 255, 1, 0];
  const wire = JSON.parse(JSON.stringify({ inputs: bytesToWire(sample) }));
  const back = decodeInputLog(wire.inputs);
  check(
    Array.from(back).join(",") === sample.join(","),
    "log round trips through base64 and JSON",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B. The worker's validation: difficulty is derived, seed is issued
// ─────────────────────────────────────────────────────────────────────────────

const today = getGoblinInvadersDifficulty();
const yesterday = getGoblinInvadersDifficulty(Date.now() - 86_400_000);

{
  const dummy = { difficulty: today.name, ticks: 1, inputs: bytesToWire([1]) };

  const expectInputError = (payload, label) => {
    try {
      validateGoblinInvadersReplay(payload);
      check(false, label, "did not throw");
    } catch (error) {
      check(
        error instanceof ReplayInputError,
        label,
        `wrong error type: ${error}`,
      );
    }
  };

  const todayValidated = validateGoblinInvadersReplay(dummy);
  check(
    todayValidated.difficulty.name === today.name &&
      todayValidated.total === 1,
    "today's difficulty validates with the worker's own parameters",
  );

  validateGoblinInvadersReplay({ ...dummy, difficulty: yesterday.name });
  check(
    true,
    "yesterday's difficulty validates (UTC-midnight-straddling runs)",
  );

  const other = GOBLIN_INVADERS_DIFFICULTIES.find(
    (d) => d.name !== today.name && d.name !== yesterday.name,
  );
  if (other) {
    expectInputError(
      { ...dummy, difficulty: other.name },
      `difficulty ${other.name} (not today/yesterday) is refused`,
    );
  }
  expectInputError(
    { ...dummy, difficulty: "impossible" },
    "an unknown difficulty is refused",
  );
  expectInputError(undefined, "a missing replay is refused");
  expectInputError(
    { difficulty: today.name },
    "a replay without inputs is refused",
  );
  expectInputError(
    { ...dummy, inputs: "!!! not base64 !!!" },
    "garbage base64 is refused",
  );
  expectInputError(
    { ...dummy, ticks: 2 },
    "a ticks/byte-count mismatch (short) is refused",
  );
  expectInputError(
    { ...dummy, ticks: 0, inputs: bytesToWire([]) },
    "an empty log is refused",
  );
  expectInputError({ ...dummy, ticks: -1 }, "a negative tick count is refused");
  expectInputError(
    { ...dummy, ticks: 1.5 },
    "a fractional tick count is refused",
  );
  expectInputError(
    {
      ...dummy,
      ticks: MAX_REPLAY_TICKS + 1,
      inputs: bytesToWire(new Array(MAX_REPLAY_TICKS + 1).fill(1)),
    },
    "a log over the shared ceiling is refused",
  );
  expectInputError(
    { ...dummy, ticks: 2, inputs: bytesToWire([1, 3]) },
    "a byte outside the encoding is refused (the reserved direction bits)",
  );
  expectInputError(
    { ...dummy, ticks: 3, inputs: bytesToWire([1, 16, 1]) },
    "byte 16 — inside the keyboard/gap region — is refused",
  );
}

// The seed is the ledger's. There is no fallback and no claim field.
{
  const payload = { difficulty: today.name, ticks: 1, inputs: bytesToWire([4]) };

  const expectSeedError = (fn, label) => {
    try {
      fn();
      check(false, label, "did not throw");
    } catch (error) {
      check(
        error instanceof ReplayInputError &&
          /no server-issued seed/.test(error.message),
        label,
        `wrong error: ${error}`,
      );
    }
  };

  for (const bad of [null, undefined, "abc", 1.5, -1, 0x1_0000_0000]) {
    expectSeedError(
      () => startGoblinInvadersReplay(payload, bad),
      `a claim over a run with seed ${String(bad)} is refused (issued only)`,
    );
    expectSeedError(
      () =>
        openGoblinInvadersChunkReplay({
          seed: bad,
          difficulty: today.name,
          inputs: Uint8Array.from([4]),
        }),
      `a first chunk for a run with seed ${String(bad)} is refused (issued only)`,
    );
  }

  // The same seed builds the same opening rolls; a different seed builds a
  // different run — which is the entire reason the column is issued rather
  // than chosen. (The opening roll is the mystery ship's respawn delay.)
  const seedA = 123456789;
  const seedB = 987654321;
  const a1 = createRuntime(today, seedA);
  const a2 = createRuntime(today, seedA);
  const b = createRuntime(today, seedB);
  check(
    JSON.stringify(a1) === JSON.stringify(a2),
    "the same (difficulty, seed) builds the identical opening rolls",
  );
  check(
    JSON.stringify(a1) !== JSON.stringify(b),
    "a different seed builds a different run",
  );
  check(
    a1.seed === seedA && a1.rngState !== undefined && a1.nextId !== undefined,
    "the seed, the stream state and the id counter ride the runtime",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// C. A real win — a bot-played session pays, through the streamed pipeline
// ─────────────────────────────────────────────────────────────────────────────

// Play under whichever of today's/yesterday's difficulties is easiest to win
// (both are accepted, so the harness stays robust however the date hash
// falls).
console.log(
  `  [debug] today: ${today.name} (target ${today.targetScore}), yesterday: ${yesterday.name} (target ${yesterday.targetScore})`,
);
const easiest = [today, yesterday].reduce((a, b) =>
  a.targetScore <= b.targetScore ? a : b,
);

let winRun = null;
{
  let wins = 0;
  let bestScore = 0;
  const SEARCH = 40;
  for (let i = 0; i < SEARCH && !winRun; i++) {
    const seed = (20_261_016 + i * 7_919) >>> 0;
    const run = playSession(easiest, seed, makeBot(), { stepCap: 60_000 });
    if (run.game.score > bestScore) bestScore = run.game.score;
    if (run.game.won) wins += 1;
    if (run.game.won && !winRun) winRun = { seed, ...run };
  }

  if (!winRun) {
    console.log(
      `  [debug] bot search failed; best score on ${easiest.name}: ${bestScore} (target ${easiest.targetScore})`,
    );
  }
  check(
    winRun !== null,
    `the bot wins a ${easiest.name} session (target ${easiest.targetScore})`,
  );
  check(wins > 0, "at least one honest winning session exists in the search");
}

if (winRun) {
  check(
    winRun.bytes.length > CHUNK_TICKS,
    `the winning run (${winRun.bytes.length} steps) needs more than one chunk`,
  );
  check(
    winRun.bytes.length <= MAX_REPLAY_TICKS,
    "the winning run fits the shared tick ceiling",
  );

  // The streamed pipeline: windows stepped with the park JSON round-tripped
  // at every boundary — the D1 representation — under the issued seed.
  const { state, worstChunkMs } = chunkedReplay({
    difficultyName: easiest.name,
    seed: winRun.seed,
    bytes: winRun.bytes,
  });
  check(
    state.cursor === state.total,
    "every window stepped; the park is complete",
  );
  check(
    JSON.stringify(state.match) === JSON.stringify(winRun.game),
    "the streamed replay's final runtime is identical to the state the bot played to",
  );

  // The claim: resumes the fully-stepped park, steps only the tail.
  const verdict = claimVerdict({
    difficultyName: easiest.name,
    seed: winRun.seed,
    bytes: winRun.bytes,
    claimScore: winRun.game.score,
    park: state,
  });
  check(
    verdict.matched === true && verdict.replayScore === winRun.game.score,
    "a played-to-win session verifies (matched: true)",
    JSON.stringify(verdict),
  );

  // …and the same log with a score that disagrees is still refused.
  const badScore = claimVerdict({
    difficultyName: easiest.name,
    seed: winRun.seed,
    bytes: winRun.bytes,
    claimScore: winRun.game.score + 1,
    park: state,
  });
  check(
    badScore.matched === false,
    "a claim whose score disagrees with its own log is refused",
    JSON.stringify(badScore),
  );

  // …and the same log replayed under a *different* seed — the shape of a
  // client that dealt its own traffic — produces a different run and
  // refuses.
  const wrongSeedPark = chunkedReplay({
    difficultyName: easiest.name,
    seed: (winRun.seed ^ 0x5a5a5a5a) >>> 0,
    bytes: winRun.bytes,
  }).state;
  const wrongSeedVerdict = claimVerdict({
    difficultyName: easiest.name,
    seed: (winRun.seed ^ 0x5a5a5a5a) >>> 0,
    bytes: winRun.bytes,
    claimScore: winRun.game.score,
    park: wrongSeedPark,
  });
  check(
    wrongSeedVerdict.matched === false,
    "a log replayed under a seed the run was not dealt is a different run, and is refused",
    JSON.stringify(wrongSeedVerdict),
  );

  // A claim that arrives with the park one window short: the binding refuses
  // it outright rather than re-simulating a log that cannot finish in-budget.
  const shortPark = {
    match: state.match,
    cursor: Math.max(0, state.cursor - CHUNK_TICKS),
    total: state.total - CHUNK_TICKS,
    inputs: state.inputs.slice(0, -CHUNK_TICKS),
  };
  const shortClaim = claimVerdict({
    difficultyName: easiest.name,
    seed: winRun.seed,
    bytes: winRun.bytes,
    claimScore: winRun.game.score,
    park: shortPark,
  });
  check(
    shortClaim.matched === null,
    "a claim whose park holds less log than it asserts is refused (binding)",
    JSON.stringify(shortClaim),
  );

  // The verdict must fit a Worker request per chunk — 25 ms is a loose
  // ceiling (CI machines vary); the point is catching an accidental
  // blow-up. GI's tick is heavier than Frogger's (a 55-goblin formation
  // scan per step), so this number is watched closely.
  check(
    worstChunkMs < 25,
    `every chunk request's stepping fits one request (worst ${worstChunkMs.toFixed(3)} ms < 25 ms)`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// D. Forgery, tampering
// ─────────────────────────────────────────────────────────────────────────────

if (winRun) {
  const { game, bytes } = winRun;
  const { state } = chunkedReplay({
    difficultyName: easiest.name,
    seed: winRun.seed,
    bytes,
  });

  // Truncated log: the claim's ticks no longer match the park — refused by
  // the binding, before any simulation decides anything.
  const truncated = claimVerdict({
    difficultyName: easiest.name,
    seed: winRun.seed,
    bytes: bytes.slice(0, -1),
    claimScore: game.score,
    park: state,
  });
  check(
    truncated.matched === null,
    "a truncated log is refused (the park's binding fails)",
    JSON.stringify(truncated),
  );

  // Spliced tail: the run's final stretch replaced with an *earlier*
  // stretch of its own input — the player replays their opening moves at the
  // end of the run, from ship positions they were never in. The replay
  // diverges: it either dies short of the claim's score or keeps climbing
  // past it, and both are refusals.
  const spliceLen = Math.min(600, Math.floor(bytes.length / 3));
  const spliced = [
    ...bytes.slice(0, -spliceLen),
    ...bytes.slice(0, spliceLen),
  ];
  const splicedPark = chunkedReplay({
    difficultyName: easiest.name,
    seed: winRun.seed,
    bytes: spliced,
  }).state;
  const splicedVerdict = claimVerdict({
    difficultyName: easiest.name,
    seed: winRun.seed,
    bytes: spliced,
    claimScore: game.score,
    park: splicedPark,
  });
  check(
    splicedVerdict.matched === false,
    "a log whose winning final steps are spliced away is refused",
    JSON.stringify(splicedVerdict),
  );

  // Steps after the win are no-ops: padding a winning log cannot inflate
  // the score the worker pays.
  const padded = [...bytes, ...new Array(500).fill(0)];
  const paddedPark = chunkedReplay({
    difficultyName: easiest.name,
    seed: winRun.seed,
    bytes: padded,
  }).state;
  const paddedVerdict = claimVerdict({
    difficultyName: easiest.name,
    seed: winRun.seed,
    bytes: padded,
    claimScore: game.score,
    park: paddedPark,
  });
  check(
    paddedVerdict.matched === true && paddedVerdict.replayScore === game.score,
    "post-win padding cannot change the score the replay produces",
    JSON.stringify(paddedVerdict),
  );
}

// A finished session the player did not win — replays perfectly, pays
// nothing. The loss bot never fires and never moves: the formation walks
// down and takes the line (or the stray shots take the lives) — either way
// an honest end the worker replays to `reachedFinale: false`.
{
  let lossRun = null;
  for (let i = 0; i < 10 && !lossRun; i++) {
    const seed = (31_337 + i * 104_729) >>> 0;
    const run = playSession(easiest, seed, makeBot({ fires: false }), {
      stepCap: 45_000,
    });
    if (run.game.gameOver && !run.game.won && run.bytes.length < 45_000) {
      lossRun = { seed, ...run };
    }
  }
  check(lossRun !== null, "found a session that honestly ends in a loss");

  if (lossRun) {
    const park = chunkedReplay({
      difficultyName: easiest.name,
      seed: lossRun.seed,
      bytes: lossRun.bytes,
    }).state;
    const verdict = claimVerdict({
      difficultyName: easiest.name,
      seed: lossRun.seed,
      bytes: lossRun.bytes,
      claimScore: lossRun.game.score,
      park,
    });
    check(
      verdict.matched === false,
      "a finished session the player did not win is refused",
      JSON.stringify(verdict),
    );
    check(
      verdict.outcome.reachedFinale === false,
      "the loss replay reports reachedFinale: false",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// E. Determinism, JSON survivability, and the engine's exactness
// ─────────────────────────────────────────────────────────────────────────────

{
  const source = readFileSync(ENGINE, "utf8");
  // Strip comments first, so prose *about* determinism cannot satisfy a scan
  // meant to find code doing the opposite.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  check(!/Math\.random\(/.test(code), "engine.ts has no Math.random()");
  check(!/Date\.now\(/.test(code), "engine.ts has no Date.now()");
  check(!/performance\.now\(/.test(code), "engine.ts has no performance.now()");
  check(!/new Date\(/.test(code), "engine.ts constructs no Date");
  // The exact-ops invariant: transcendentals are implementation-defined to
  // the last ulp, and movement compounding over thousands of ticks amplifies
  // that into a different death and a different score on a different engine.
  // `Math.sqrt` is exempt — IEEE 754 specifies it exactly, like `+ - * /`
  // and the integer ops.
  check(
    !/Math\.(sin|cos|tan|asin|acos|atan|atan2|hypot|pow|exp|log|cbrt|expm1|log1p|log10|sinh|cosh|tanh)\(/.test(code),
    "engine.ts uses no transcendental (exact ops only: + - * / sqrt, imul)",
  );
  check(FIXED_STEP_MS === 16, "the shared step is 16 ms");

  // Step purity: the same (runtime, input) twice is the same runtime —
  // including the RNG stream, which advances on the runtime.
  const seed = 424242;
  const base = createRuntime(today, seed);
  const stepInput = { dir: 1, fire: true, scrub: null };
  const a = tick(base, FIXED_STEP_MS, stepInput);
  const b = tick(base, FIXED_STEP_MS, stepInput);
  check(
    JSON.stringify(a) === JSON.stringify(b),
    "tick is pure: same inputs, identical result",
  );

  // A step that rolls (an enemy firing — the source-column pick) is just as
  // pure: 400 steps is past the first fire interval on every difficulty.
  const busy = (() => {
    let g = base;
    for (let i = 0; i < 400; i++) g = tick(g, FIXED_STEP_MS, stepInput);
    return g;
  })();
  const busy1 = tick(busy, FIXED_STEP_MS, stepInput);
  const busy2 = tick(busy, FIXED_STEP_MS, stepInput);
  check(
    JSON.stringify(busy1) === JSON.stringify(busy2),
    "a step that rolls the stream is pure too (rngState on the runtime)",
  );
  check(
    busy.rngState !== base.rngState,
    "the stream actually advanced during those steps (the engine has live RNG)",
  );

  // The difficulty and seed ride on the runtime and survive the park's JSON:
  // a round-tripped runtime steps identically to a live one.
  const roundTripped = JSON.parse(JSON.stringify(busy));
  check(
    roundTripped.difficulty.name === today.name &&
      roundTripped.difficulty.targetScore === today.targetScore &&
      roundTripped.seed === seed,
    "the baked difficulty and seed survive a JSON park round trip",
  );
  const c = tick(roundTripped, FIXED_STEP_MS, stepInput);
  check(
    JSON.stringify(c) === JSON.stringify(busy1),
    "a JSON-round-tripped runtime steps identically to a live one",
  );

  // Replaying the same log twice reaches the same run.
  if (winRun) {
    const first = chunkedReplay({
      difficultyName: easiest.name,
      seed: winRun.seed,
      bytes: winRun.bytes,
    }).state;
    const second = chunkedReplay({
      difficultyName: easiest.name,
      seed: winRun.seed,
      bytes: winRun.bytes,
    }).state;
    check(
      first.match.score === second.match.score &&
        first.cursor === second.cursor,
      "streaming the same log twice reaches the same run",
    );
  }

  // Start-from-scratch, as a claim with no park would: same log, same run.
  if (winRun) {
    const fresh = startGoblinInvadersReplay(
      {
        difficulty: easiest.name,
        ticks: winRun.bytes.length,
        inputs: bytesToWire(winRun.bytes),
      },
      winRun.seed,
    );
    stepGoblinInvadersReplay(fresh, Number.MAX_SAFE_INTEGER);
    const outcome = goblinInvadersOutcome(fresh);
    check(
      outcome.score === winRun.game.score && outcome.reachedFinale === true,
      "a whole-log replay from tick zero reaches the same win",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const total = passes.length + failures.length;
console.log(`\n${passes.length}/${total} checks passed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log("goblin invaders replay harness: all checks passed");
