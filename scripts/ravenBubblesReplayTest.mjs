#!/usr/bin/env node
/**
 * Raven Bubbles replay harness — proves `(difficulty, seed, inputs) => the
 * same run`.
 *
 * ## Why this file exists
 *
 * The worker mints a Raven Coin only if its own re-run of the claimed session
 * ends `gameOver && won` at the score the claim asserts. That guarantee rests
 * on three properties, and this harness fails loudly the moment any breaks:
 *
 *   1. **Determinism.** The step function has no `Math.random()` and no clock:
 *      every roll — the opening deal and every screen refill in `createBoard`
 *      (colour, clump size, placement), and every queue deal in
 *      `pickNextColor` — draws from a mulberry32 stream seeded by the
 *      server-issued run seed, and the difficulty is baked into the runtime at
 *      run-open. So `(difficulty, seed, inputs)` fixes the run on any machine.
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
 *   - **The input codec round trips** — all 128 aim levels, fire and no-fire,
 *     through encode and decode; a raw pointer angle surviving within half a
 *     level of itself; and the guard `decodeTick` keeps for values that are
 *     not bytes at all (every byte 0..255 is a legal input in this layout).
 *   - **The baked trig tables** — the engine contains no `Math.sin`/`Math.cos`
 *     at all (see its header); this harness re-derives every entry of
 *     `SIN_TABLE`, `COS_TABLE`, `RAY_SIN` and `RAY_COS` from its own
 *     `Math.sin`/`Math.cos` of the exact angles and fails if a literal has
 *     drifted from them.
 *   - **The seed is the worker's, not the claim's** — the ledger seed is
 *     required (`assertRunSeed` refuses a missing one with no fallback), the
 *     same seed twice builds the same opening rolls, and a different seed
 *     builds a different run that no log can paper over.
 *   - **Difficulty is the worker's, not the claim's** — today's and
 *     yesterday's names validate (a run may straddle UTC midnight); any other
 *     is refused before a single step ("always claim easy" buys nothing).
 *   - **Malformed submissions are refused** — missing replay, missing/garbage
 *     inputs, `ticks` disagreeing with the byte count, an empty log, a
 *     fractional/negative/over-ceiling tick count.
 *   - **A real win pays** — a bot-played session replays step-for-step to an
 *     identical final runtime, through the chunked park/continue pipeline
 *     with a JSON round trip per window, and its verdict matches.
 *   - **Forgery is refused** — a score that disagrees with its own log, a
 *     truncated log (the park's binding refuses it), a spliced tail (the run
 *     diverges), a finished session the player did not win, a log replayed
 *     under a seed the run was not dealt.
 *   - **Post-win bytes cannot inflate** — steps after `gameOver` are no-ops,
 *     so padding a winning log with junk changes nothing the worker pays.
 *   - **The clock lives in the step** — 1 875 whole steps carry the ceiling
 *     clock to zero exactly, the expiry drops the ceiling while aiming, and a
 *     mid-flight expiry resets the clock and *skips* the drop (the original's
 *     quirk, transcribed).
 *   - **The engine is exact-ops only** — source scan: no RNG, no clock, and
 *     no transcendental (`Math.sin`/`cos`/`atan2`/`hypot`/`pow`/…), whose
 *     last-ulp freedom is implementation-defined; `sqrt` (IEEE 754 specifies
 *     it exactly) is exempt.
 *   - **Budget** — every chunk request's stepping fits a Worker request
 *     (loosely, 25 ms), and a real run needs more than one chunk.
 *
 * ## How the bot plays
 *
 * Raven Bubbles' input is one byte: the aim as one of 128 levels, plus a fire
 * press. The bot is *stateful* only in the small (it thinks for a beat between
 * shots, the way a player does — which also keeps a chunk window's resolve
 * count honest); the worker replays the log the bot wrote, never the policy.
 *
 *   - **Win bot** — trace all 128 aim levels through the engine's own
 *     geometry (`touchesBubble`, `nearestEmptyCell`), and for each cell the
 *     shot could land in, score the placement: a landing that pops
 *     (`cluster >= 3`, plus whatever that leaves floating) is worth its points
 *     outright; otherwise prefer landings that reach the most same-colour
 *     neighbours (building the triple the queue is biased toward handing out)
 *     and, ties aside, play high — nearer the ceiling, further from the line.
 *   - **Loss bot** — the mirror: never pop (any landing whose cluster would
 *     reach three is rejected outright), and grow *downward* — the highest
 *     landing cell each time — until the ceiling drops and the cluster reach
 *     row 11 honestly.
 *
 * ## How it runs
 *
 * Node cannot import TypeScript, and the worker imports the engine with one
 * spelling of `@nightshade/shared` while the client uses another — so,
 * exactly like `goblinInvadersReplayTest.mjs`, everything is bundled by esbuild
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
  "src/features/arcade/games/ravenbubbles/engine.ts",
);
const SESSION = path.join(
  ROOT,
  "src/features/arcade/games/ravenbubbles/session.ts",
);
const WORKER_REPLAY = path.join(ROOT, "worker/src/ravenBubblesReplay.js");
// `ReplayInputError` and `CHUNK_TICKS` live in the brawler's module — the
// shared plumbing every streamed cabinet throws and budgets against.
const SHARED_STREAM = path.join(ROOT, "worker/src/replay.js");
const SHARED = path.join(ROOT, "shared/anticheat");

const CACHE = path.join(ROOT, "node_modules/.cache/anticheat");
const ENTRY = path.join(CACHE, "ravenbubbles-entry.mjs");
const BUNDLE = path.join(CACHE, "ravenbubbles.bundle.mjs");

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
  quantizeAim,
  levelToAim,
  clusterOf,
  floatingCells,
  nearestEmptyCell,
  touchesBubble,
  ceilingLimitY,
  MIN_CLUSTER,
  CEILING_MS,
  CEILING_SECONDS,
  SHOTS_PER_DROP,
  SHOOTER_X,
  SHOOTER_Y,
  RADIUS,
  PLAYFIELD_WIDTH,
  // Session (difficulty derivation, shared with the worker)
  RAVEN_BUBBLES_DIFFICULTIES,
  getRavenBubblesDifficulty,
  POINTS_PER_POP,
  POINTS_PER_DROP,
  // Worker verifier
  validateRavenBubblesReplay,
  startRavenBubblesReplay,
  openRavenBubblesChunkReplay,
  stepRavenBubblesReplay,
  ravenBubblesOutcome,
  // Shared streamed plumbing (the brawler's module)
  ReplayInputError,
  CHUNK_TICKS,
  // Codec
  encodeInputLog,
  decodeInputLog,
} = mod;

const MAX_REPLAY_TICKS = 64_000; // shared/anticheat/replayBudget.js

const bytesToWire = (bytes) => encodeInputLog(Uint8Array.from(bytes));

/** The aim grid's spacing: `[-1.15, 1.15]` over 127 divisions. */
const AIM_STEP = (1.15 - -1.15) / 127;

// ─────────────────────────────────────────────────────────────────────────────
// The client's half: a bot that plays the way a player does.
//
// The policy traces the *engine's* geometry (wall bounces, ceiling, bubble
// reach, nearest-cell snap) at every one of the 128 aim levels, so what it
// evaluates is the landing the step will actually take — the same helpers the
// render's aim guide uses. Random lives only in the harness's seed search,
// never in the engine.
// ─────────────────────────────────────────────────────────────────────────────

const IDLE_AIM = levelToAim(quantizeAim(0));

/**
 * Where a shot fired at this aim level would come to rest, or null.
 *
 * A harness-side trace with `Math.sin` — deliberately *not* the engine's
 * baked tables: this code only ever writes input bytes, never anything the
 * worker replays, and an independent trace is a second opinion on the
 * geometry rather than the engine grading its own homework.
 */
function traceLanding(grid, ceilingRow, level) {
  const angle = levelToAim(level);
  let x = SHOOTER_X;
  let y = SHOOTER_Y;
  let dx = Math.sin(angle);
  let dy = -Math.cos(angle);

  for (let step = 0; step < 400; step++) {
    x += dx * 4;
    y += dy * 4;

    if (x < RADIUS) {
      x = RADIUS;
      dx = -dx;
    } else if (x > PLAYFIELD_WIDTH - RADIUS) {
      x = PLAYFIELD_WIDTH - RADIUS;
      dx = -dx;
    }

    const hitCeiling = y - RADIUS <= ceilingLimitY(ceilingRow);
    const hitBubble = !hitCeiling && touchesBubble(grid, x, y, ceilingRow);
    if (hitCeiling || hitBubble) {
      return nearestEmptyCell(grid, x, y, ceilingRow);
    }
  }
  return null;
}

/**
 * Score one candidate landing: what the run gains, and how connected the
 * placed bubble is.
 *
 * `gained` mirrors `resolveShot` exactly — `POINTS_PER_POP` per popped bubble,
 * `POINTS_PER_DROP` per bubble that pop leaves floating. `reach` is the size
 * of the cluster the placement makes (1 = isolated, 2 = against one neighbour
 * — the pair the next shot completes).
 */
function scoreLanding(grid, ceilingRow, level, color) {
  const cell = traceLanding(grid, ceilingRow, level);
  if (cell === null) return null;
  const [row, col] = cell;

  const scratch = grid.map((line) => [...line]);
  scratch[row][col] = color;
  const cluster = clusterOf(scratch, row, col, ceilingRow);

  let gained = 0;
  if (cluster.length >= MIN_CLUSTER) {
    for (const [r, c] of cluster) scratch[r][c] = null;
    gained += cluster.length * POINTS_PER_POP;
    const floating = floatingCells(scratch, ceilingRow);
    gained += floating.length * POINTS_PER_DROP;
  }

  return { level, row, reach: cluster.length, gained };
}

/** The win bot's ranking: points first, then connection, then height. */
function betterWin(a, b) {
  if (a.gained !== b.gained) return a.gained > b.gained;
  if (a.reach !== b.reach) return a.reach > b.reach;
  // Higher on the board = further from the line, and ties break to the first
  // level found so the policy is deterministic.
  if (a.row !== b.row) return a.row < b.row;
  return false;
}

/**
 * The bot's per-tick decision.
 *
 * @param {{ win: boolean }} opts `win: false` is the loss bot: never pop,
 *   grow downward, let the ceiling take the run honestly.
 */
function makeBot({ win = true } = {}) {
  // Think a beat between shots — a player lines the shot up, and the pause
  // also keeps a chunk window's resolve count to something a Worker can
  // re-simulate. While a shot is in flight the cooldown refills.
  const THINK_TICKS = win ? 32 : 8;
  let cooldown = 0;

  return function choose(g) {
    if (g.gameOver) return { aim: IDLE_AIM, fire: false };

    if (g.shot !== null) {
      cooldown = THINK_TICKS;
      return { aim: levelToAim(g.aimLevel), fire: false };
    }

    if (cooldown > 0) {
      cooldown -= 1;
      return { aim: levelToAim(g.aimLevel), fire: false };
    }

    let best = null;
    const seen = new Set();
    for (let level = 0; level <= 127; level++) {
      const candidate = scoreLanding(
        g.grid,
        g.ceilingRow,
        level,
        g.current,
      );
      if (candidate === null) continue;

      // Many levels trace to the same cell — evaluate each cell once.
      const cellKey = `${candidate.row}:${candidate.reach}:${candidate.gained}`;
      if (seen.has(cellKey)) continue;
      seen.add(cellKey);

      if (win) {
        if (best === null || betterWin(candidate, best)) best = candidate;
      } else {
        // Never pop: a landing that reaches three would hand the run points
        // it is trying not to score, and often refill the board besides.
        if (candidate.reach >= MIN_CLUSTER) continue;
        if (
          best === null ||
          candidate.row > best.row ||
          (candidate.row === best.row && candidate.reach > best.reach)
        ) {
          best = candidate;
        }
      }
    }

    if (best === null) {
      return { aim: levelToAim(g.aimLevel), fire: false };
    }
    return { aim: levelToAim(best.level), fire: true };
  };
}

/**
 * Play a whole session the way the component's loop does: sample the input,
 * log its byte, step, repeat — and stop when the run settles.
 */
function playSession(difficulty, seed, choose, { stepCap = 60_000 } = {}) {
  let game = createRuntime(difficulty, seed);
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
function chunkedReplay({ difficultyName, seed, bytes, chunkTicks = CHUNK_TICKS }) {
  let state = null;
  let worstChunkMs = 0;

  for (let start = 0; start < bytes.length; start += chunkTicks) {
    const window = Uint8Array.from(bytes.slice(start, start + chunkTicks));
    if (start === 0) {
      state = openRavenBubblesChunkReplay({
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
    stepRavenBubblesReplay(state, chunkTicks);
    const windowMs = performance.now() - t0;
    if (process.env.RB_TRACE_CHUNKS && windowMs > 10) {
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
  const validated = validateRavenBubblesReplay({
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
  stepRavenBubblesReplay(resumed, CHUNK_TICKS); // the tail — usually zero steps

  if (resumed.cursor !== resumed.total) {
    return { matched: null, reason: "replay in progress" };
  }

  const outcome = ravenBubblesOutcome(resumed);
  const matched =
    outcome.score === claimScore && outcome.reachedFinale === true;
  return { matched, replayScore: outcome.score, outcome };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The input codec
// ─────────────────────────────────────────────────────────────────────────────

{
  // Every aim level round trips: the byte is `fire | level`, and the decoded
  // aim is the exact angle of that level — so encode(decode) is a fixed point
  // and the step's own quantisation can never disagree with the byte.
  for (let level = 0; level <= 127; level++) {
    const angle = levelToAim(level);
    for (const fire of [false, true]) {
      const code = encodeTick({ aim: angle, fire });
      check(
        code === ((fire ? 0x80 : 0) | level),
        `(${angle.toFixed(6)}, fire=${fire}) encodes to ${(fire ? 0x80 : 0) | level} (${code})`,
      );
      const back = decodeTick(code);
      check(
        back !== null && back.aim === angle && back.fire === fire,
        `round trip: level ${level}, fire ${fire}`,
      );
    }
  }

  // Spot checks of the layout.
  check(
    encodeTick({ aim: levelToAim(0), fire: false }) === 0,
    "level 0 without fire is byte 0",
  );
  check(
    encodeTick({ aim: levelToAim(127), fire: false }) === 127,
    "level 127 without fire is byte 127",
  );
  check(
    encodeTick({ aim: levelToAim(0), fire: true }) === 0x80,
    "fire is bit 7 (0x80)",
  );
  check(
    encodeTick({ aim: levelToAim(64), fire: true }) === 0x80 | 64,
    "fire and the aim share the byte without overlap",
  );

  // A raw (unquantised) pointer angle survives within half a level of itself
  // — the shot goes where the player pointed, to the precision the byte can
  // carry.
  const rawAngle = 0.5;
  const raw = decodeTick(encodeTick({ aim: rawAngle, fire: false }));
  check(
    raw !== null && Math.abs(raw.aim - rawAngle) <= AIM_STEP / 2,
    "an unquantised aim angle survives within half a level",
    raw ? `drifted ${Math.abs(raw.aim - rawAngle)}` : "did not decode",
  );

  // The engine re-quantises inside `tick`, so client and replay always take
  // the same step under a raw angle — the property the parity rests on.
  check(
    quantizeAim(rawAngle) === quantizeAim(decodeTick(encodeTick({ aim: rawAngle, fire: false })).aim),
    "quantising a raw angle and its decoded round trip agree",
  );

  // The guard: every byte 0..255 is legal (this layout has no reserved
  // region), but values that are not bytes at all are refused.
  let allDecode = true;
  for (let byte = 0; byte <= 255; byte++) {
    if (decodeTick(byte) === null) allDecode = false;
  }
  check(allDecode, "every byte 0..255 decodes to an input");
  for (const bad of [-1, 256, 1.5, NaN, Infinity]) {
    check(
      decodeTick(bad) === null,
      `decodeTick(${String(bad)}) is refused (not a byte)`,
    );
  }

  // The claim's journey: bytes → base64 → JSON → decoded bytes.
  const sample = [0, 1, 64, 127, 128, 192, 254, 255, 1, 0];
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

const today = getRavenBubblesDifficulty();
const yesterday = getRavenBubblesDifficulty(Date.now() - 86_400_000);

{
  const dummy = { difficulty: today.name, ticks: 1, inputs: bytesToWire([1]) };

  const expectInputError = (payload, label) => {
    try {
      validateRavenBubblesReplay(payload);
      check(false, label, "did not throw");
    } catch (error) {
      check(
        error instanceof ReplayInputError,
        label,
        `wrong error type: ${error}`,
      );
    }
  };

  const todayValidated = validateRavenBubblesReplay(dummy);
  check(
    todayValidated.difficulty.name === today.name &&
      todayValidated.total === 1,
    "today's difficulty validates with the worker's own parameters",
  );

  validateRavenBubblesReplay({ ...dummy, difficulty: yesterday.name });
  check(
    true,
    "yesterday's difficulty validates (UTC-midnight-straddling runs)",
  );

  const other = RAVEN_BUBBLES_DIFFICULTIES.find(
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
      () => startRavenBubblesReplay(payload, bad),
      `a claim over a run with seed ${String(bad)} is refused (issued only)`,
    );
    expectSeedError(
      () =>
        openRavenBubblesChunkReplay({
          seed: bad,
          difficulty: today.name,
          inputs: Uint8Array.from([4]),
        }),
      `a first chunk for a run with seed ${String(bad)} is refused (issued only)`,
    );
  }

  // The same seed builds the same opening rolls; a different seed builds a
  // different run — which is the entire reason the column is issued rather
  // than chosen. The opening deal and both queue deals all come from the
  // stream, so the whole opening position is the seed's product.
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
    a1.seed === seedA && a1.rngState !== undefined && a1.ceilingMs === CEILING_MS,
    "the seed, the stream state and the clock ride the runtime",
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
  const SEARCH = 30;
  for (let i = 0; i < SEARCH && !winRun; i++) {
    const seed = (42_071 + i * 6_151) >>> 0;
    const run = playSession(easiest, seed, makeBot({ win: true }), {
      stepCap: 60_000,
    });
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
  // client that dealt its own board — produces a different run and refuses.
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
  // blow-up. This engine's weight is in each shot's resolve (`pickNextColor`
  // twice, whose `landingCells` ray-trace the memo halves), so the number is
  // watched closely.
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
  // stretch of its own input — the player replays their opening shots at the
  // end of the run, against a board that has already grown. The replay
  // diverges: it either ends short of the claim's score or keeps climbing
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
// nothing. The loss bot never pops: it grows the cluster downward until the
// ceiling drops carry row 4 past the line — an honest end the worker replays
// to `reachedFinale: false`.
{
  let lossRun = null;
  for (let i = 0; i < 10 && !lossRun; i++) {
    const seed = (31_337 + i * 104_729) >>> 0;
    const run = playSession(easiest, seed, makeBot({ win: false }), {
      stepCap: 45_000,
    });
    if (
      run.game.gameOver &&
      !run.game.won &&
      run.bytes.length < 45_000 &&
      run.game.score < easiest.targetScore
    ) {
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
// E. Determinism, JSON survivability, the clock, and the engine's exactness
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
  // the last ulp, and a shot compounding over dozens of substeps amplifies
  // that into a different landing cell, a different cluster and a different
  // score on a different engine. The trig this game needs instead lives in
  // baked literal tables — verified against a live `Math.sin` two checks
  // below. `Math.sqrt` is exempt — IEEE 754 specifies it exactly.
  check(
    !/Math\.(sin|cos|tan|asin|acos|atan|atan2|hypot|pow|exp|log|cbrt|expm1|log1p|log10|sinh|cosh|tanh)\(/.test(code),
    "engine.ts uses no transcendental (exact ops only: + - * / sqrt, imul)",
  );
  check(FIXED_STEP_MS === 16, "the shared step is 16 ms");

  // The baked tables, re-derived: every literal must be the value
  // `Math.sin`/`Math.cos` returns for the exact angle it serves, or the
  // engine and the browser's old live trig would disagree — which is the
  // thing the tables exist to prevent.
  const extractTable = (name) => {
    const match = source.match(
      new RegExp(`const ${name}: number\\[\\] = \\[([\\s\\S]*?)\\];`),
    );
    if (!match) return null;
    return (match[1].match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g) || []).map(Number);
  };

  const sinTable = extractTable("SIN_TABLE");
  const cosTable = extractTable("COS_TABLE");
  const raySin = extractTable("RAY_SIN");
  const rayCos = extractTable("RAY_COS");

  check(
    sinTable?.length === 128 && cosTable?.length === 128,
    "SIN_TABLE and COS_TABLE hold all 128 aim levels",
    `got ${sinTable?.length}/${cosTable?.length}`,
  );
  check(
    raySin?.length === 45 && rayCos?.length === 45,
    "RAY_SIN and RAY_COS hold all 45 landing rays",
    `got ${raySin?.length}/${rayCos?.length}`,
  );

  if (sinTable && cosTable && raySin && rayCos) {
    // Tolerance: a few ulp (1e-15 is ~4.5 ulp for doubles near 1) — the
    // generation used this machine's `Math.sin`, and a difference beyond
    // that would mean the table and the angle's own trig have genuinely
    // drifted apart, not that double rounding moved a hair.
    const TOL = 1e-15;
    let worstSin = 0;
    let worstCos = 0;
    for (let level = 0; level <= 127; level++) {
      const angle = levelToAim(level);
      worstSin = Math.max(worstSin, Math.abs(sinTable[level] - Math.sin(angle)));
      worstCos = Math.max(worstCos, Math.abs(cosTable[level] - Math.cos(angle)));
    }
    check(
      worstSin <= TOL,
      `SIN_TABLE matches Math.sin of every aim level (worst ${worstSin})`,
    );
    check(
      worstCos <= TOL,
      `COS_TABLE matches Math.cos of every aim level (worst ${worstCos})`,
    );

    let worstRaySin = 0;
    let worstRayCos = 0;
    for (let ray = 0; ray <= 44; ray++) {
      const angle = -1.15 + (ray / 44) * (1.15 * 2);
      worstRaySin = Math.max(worstRaySin, Math.abs(raySin[ray] - Math.sin(angle)));
      worstRayCos = Math.max(worstRayCos, Math.abs(rayCos[ray] - Math.cos(angle)));
    }
    check(
      worstRaySin <= TOL,
      `RAY_SIN matches Math.sin of every ray angle (worst ${worstRaySin})`,
    );
    check(
      worstRayCos <= TOL,
      `RAY_COS matches Math.cos of every ray angle (worst ${worstRayCos})`,
    );
  }

  // Step purity: the same (runtime, input) twice is the same runtime —
  // including the RNG stream, which advances on the runtime.
  const seed = 424242;
  const base = createRuntime(today, seed);
  const stepInput = { aim: 0.4, fire: true };
  const a = tick(base, FIXED_STEP_MS, stepInput);
  const b = tick(base, FIXED_STEP_MS, stepInput);
  check(
    JSON.stringify(a) === JSON.stringify(b),
    "tick is pure: same inputs, identical result",
  );

  // A step that rolls (a shot settling — the queue's deals) is just as pure:
  // 600 fire-always steps is many shot resolutions past the start.
  const busy = (() => {
    let g = base;
    for (let i = 0; i < 600; i++) g = tick(g, FIXED_STEP_MS, stepInput);
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
  check(
    roundTripped.shot === null || typeof roundTripped.shot.x === "number",
    "the shot field (or its null) survives the JSON park",
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
    const fresh = startRavenBubblesReplay(
      {
        difficulty: easiest.name,
        ticks: winRun.bytes.length,
        inputs: bytesToWire(winRun.bytes),
      },
      winRun.seed,
    );
    stepRavenBubblesReplay(fresh, Number.MAX_SAFE_INTEGER);
    const outcome = ravenBubblesOutcome(fresh);
    check(
      outcome.score === winRun.game.score && outcome.reachedFinale === true,
      "a whole-log replay from tick zero reaches the same win",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// F. The ceiling clock — wall time, made into step time
// ─────────────────────────────────────────────────────────────────────────────

{
  const idle = { aim: 0, fire: false };

  // 30 000 ms / 16 ms = 1 875 steps exactly: the clock lands on zero on the
  // same tick on both ends with no drift, which is why the wall-clock
  // `setInterval` could move into the step at all.
  let g = createRuntime(today, 987654321);
  for (let i = 0; i < 1874; i++) g = tick(g, FIXED_STEP_MS, idle);
  check(
    g.ceilingMs === 16,
    "the clock counts down in whole steps (1 874 × 16 ms leaves 16 ms)",
    `left ${g.ceilingMs}`,
  );
  g = tick(g, FIXED_STEP_MS, idle);
  check(
    g.ceilingMs === CEILING_MS && g.ceilingRow === 1,
    "clock expiry resets the clock and drops the ceiling a row while aiming",
    `ms ${g.ceilingMs}, row ${g.ceilingRow}`,
  );
  check(
    g.shotsLeft === SHOTS_PER_DROP,
    "the clock drop also refills the shot counter",
  );

  // The original's quirk: an expiry that finds the player mid-flight resets
  // the countdown and *skips* the drop rather than deferring it — the shot
  // would otherwise slide out from under the cluster mid-air.
  let h = createRuntime(today, 987654321);
  for (let i = 0; i < 1873; i++) h = tick(h, FIXED_STEP_MS, idle); // 32 ms left
  h = tick(h, FIXED_STEP_MS, { aim: 0, fire: true }); // fire; 16 ms left
  check(h.shot !== null, "the shot is still in flight as the clock expires");
  h = tick(h, FIXED_STEP_MS, idle); // expiry under the flight
  check(
    h.ceilingMs === CEILING_MS && h.ceilingRow === 0,
    "an expiry mid-flight resets the clock and skips the drop",
    `ms ${h.ceilingMs}, row ${h.ceilingRow}`,
  );
  check(h.shot !== null, "the in-flight shot is untouched by the skipped drop");

  // The display number the cabinet shows: ceil of seconds remaining, 30..1.
  const secondsLeft = (run) => Math.ceil(run.ceilingMs / 1000);
  check(secondsLeft(g) >= 1 && secondsLeft(g) <= CEILING_SECONDS,
    "the clock's seconds display stays inside 1..30");
}

// ─────────────────────────────────────────────────────────────────────────────

const total = passes.length + failures.length;
console.log(`\n${passes.length}/${total} checks passed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log("raven bubbles replay harness: all checks passed");
