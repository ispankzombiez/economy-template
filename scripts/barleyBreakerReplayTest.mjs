#!/usr/bin/env node
/**
 * Barley Breaker replay harness — proves `(difficulty, inputs) => the same run`.
 *
 * ## Why this file exists
 *
 * The worker mints a Raven Coin only if its own re-run of the claimed session
 * ends `gameOver && won` at the score the claim asserts. That guarantee rests
 * on three properties, and this harness fails loudly the moment any breaks:
 *
 *   1. **Determinism.** The step function has no `Math.random()` and no clock:
 *      the drop rolls and strong-brick layouts are an integer hash of
 *      `(wave, row, col, salt)`, and the difficulty is baked into the runtime
 *      at run-open. So `(difficulty, inputs)` fixes the run on any machine.
 *   2. **Parity.** The log the component's loop produces — one input byte per
 *      16ms step, sampled *before* the step — is exactly the log the worker's
 *      replay driver consumes, through the same `tick` both ends import. A
 *      divergence here would refuse honest players for a difference nobody
 *      can see.
 *   3. **Streamability.** A run is thousands of steps, far past one Worker's
 *      10 ms CPU budget, so it is replayed in `CHUNK_TICKS` windows with the
 *      match parked between them. The park goes through D1 as JSON, so the
 *      runtime must survive a JSON round trip at every boundary unchanged —
 *      the reason the difficulty rides *on* the runtime rather than being
 *      looked up from the date at step time.
 *
 * ## What it checks
 *
 *   - **The input codec round trips** — keyboard bytes (direction, launch)
 *     and scrub bytes (bit 7 + 7 bits of position) through base64 and JSON;
 *     a byte the client could never produce does not decode.
 *   - **Difficulty is the worker's, not the claim's** — today's and
 *     yesterday's names validate (a run may straddle UTC midnight); any other
 *     is refused before a single step ("always claim easy" buys nothing).
 *   - **Malformed submissions are refused** — missing replay, missing/garbage
 *     inputs, `ticks` disagreeing with the byte count, an empty log, a
 *     fractional/negative/over-ceiling tick count, a byte outside the encoding.
 *   - **A real win pays** — a bot-played session replays step-for-step to an
 *     identical final runtime, through the chunked park/continue pipeline with
 *     a JSON round trip per window, and its verdict matches.
 *   - **Forgery is refused** — a score that disagrees with its own log, a
 *     truncated log (the park's binding refuses it), spliced final steps (the
 *     run diverges, so the replay never reaches the target), a finished
 *     session the player did not win.
 *   - **Post-win bytes cannot inflate** — steps after `gameOver` are no-ops,
 *     so padding a winning log with junk changes nothing the worker pays.
 *   - **The engine is exact-ops only** — source scan: no RNG, no clock, and no
 *     transcendental (`Math.sin`/`cos`/`atan2`/`hypot`/`pow`/…), whose
 *     last-ulp freedom is implementation-defined and would diverge a chaotic
 *     bounce between the browser that played the run and the isolate that
 *     replays it.
 *   - **Budget** — every chunk request's stepping fits a Workers Free request
 *     (loosely, 25 ms), and a real run needs more than one chunk.
 *
 * ## How it runs
 *
 * Node cannot import TypeScript, and the worker imports the engine with one
 * spelling of `@nightshade/shared` while the client uses another — so,
 * exactly like `pacmanReplayTest.mjs`, everything is bundled by esbuild with a
 * resolve plugin answering both spellings *from the same directory*, which is
 * the entire point of the shared package: one file, two ends.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(ROOT, "src/features/arcade/games/barleybreaker/engine.ts");
const SESSION = path.join(ROOT, "src/features/arcade/games/barleybreaker/session.ts");
const WORKER_REPLAY = path.join(ROOT, "worker/src/barleyBreakerReplay.js");
// `ReplayInputError` and `CHUNK_TICKS` live in the brawler's module — the
// shared plumbing every streamed cabinet throws and budgets against.
const SHARED_STREAM = path.join(ROOT, "worker/src/replay.js");
const SHARED = path.join(ROOT, "shared/anticheat");

const CACHE = path.join(ROOT, "node_modules/.cache/anticheat");
const ENTRY = path.join(CACHE, "barley-entry.mjs");
const BUNDLE = path.join(CACHE, "barley.bundle.mjs");

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
      // `shared/package.json`'s `exports` map. Neither spelling resolves on its
      // own under a single alias, so both are answered here — from the same
      // directory, which is the entire point of the package: one file, two ends.
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
  // Session (difficulty derivation, shared with the worker)
  BARLEY_BREAKER_DIFFICULTIES,
  getBarleyBreakerDifficulty,
  // Worker verifier
  validateBarleyBreakerReplay,
  startBarleyBreakerReplay,
  openBarleyBreakerChunkReplay,
  stepBarleyBreakerReplay,
  barleyBreakerOutcome,
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
// It steers the paddle by what a player can see — the live balls and the
// bricks still on the board — and no clock. Its only randomness is an LCG
// seeded per attempt, which lives in the *bot*, never in the engine. The
// strategy is the one a person discovers in ten seconds of breakout: catch the
// falling ball off-centre, on whichever side sends it back toward the bricks
// that remain, so every return trip sweeps a diagonal instead of stalling in a
// cleared column.
// ─────────────────────────────────────────────────────────────────────────────

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 4_294_967_296;
  };
}

const IDLE = encodeTick({ dir: 0, launch: false, scrub: null });

/**
 * Play a whole session the way the component's loop does: sample the input,
 * log its byte, step, repeat — and stop when the run settles.
 */
function playSession(difficulty, seed, { stepCap = 40_000 } = {}) {
  const rng = makeRng(seed);
  let game = createRuntime(difficulty);
  const bytes = [];
  let sinceJitter = 0;
  let jitterSign = rng() < 0.5 ? -1 : 1;

  while (!game.gameOver && bytes.length < stepCap) {
    // Launch anything stuck — the engine no-ops once nothing is.
    const launch = game.balls.some((ball) => ball.stuck);

    // Whichever live ball is closest to the paddle gets tracked; among equals
    // the first, which is stable.
    const live = game.balls.filter((ball) => !ball.stuck);
    const tracked =
      live.reduce(
        (best, ball) => (best === null || ball.y > best.y ? ball : best),
        null,
      ) ?? null;

    let dir = 0;
    if (tracked !== null) {
      // Where are the bricks that remain, relative to the ball? The paddle
      // goes *opposite*: landing the ball on the paddle's right half sends it
      // right (positive vx), so to aim right the paddle center sits left of
      // the ball.
      let remainingX = 0;
      let remaining = 0;
      for (const brick of game.bricks) {
        if (!brick.alive) continue;
        remainingX += brick.x + brick.width / 2;
        remaining += 1;
      }
      const centroidX = remaining > 0 ? remainingX / remaining : tracked.x;

      // Occasional jitter so different seeds play differently — a bot that is
      // *too* deterministic finds the same unreachable corner every time.
      if (sinceJitter <= 0) {
        jitterSign = rng() < 0.15 ? -jitterSign : jitterSign;
        sinceJitter = 20 + Math.floor(rng() * 40);
      }
      sinceJitter -= 1;

      const ballCenter = tracked.x + 9; // BALL_SIZE / 2
      const towardRemaining = centroidX >= ballCenter ? -1 : 1;
      const offset = jitterSign * towardRemaining * 26;
      const targetX = ballCenter + offset;

      const paddleCenter = game.paddleX + 48; // PADDLE_WIDTH / 2
      dir = targetX > paddleCenter ? 1 : targetX < paddleCenter - 6 ? -1 : 0;
    }

    const input = { dir, launch, scrub: null };
    bytes.push(encodeTick(input));
    game = tick(game, FIXED_STEP_MS, input);
  }

  return { game, bytes };
}

/** A hopeless player, for producing an honest *loss* quickly. */
function playDrunk(difficulty, seed, { stepCap = 12_000 } = {}) {
  const rng = makeRng(seed);
  let game = createRuntime(difficulty);
  const bytes = [];
  let desired = 0;
  let sinceDecide = 999;

  while (!game.gameOver && bytes.length < stepCap) {
    if (sinceDecide >= 12 || (desired !== 0 && rng() < 0.08)) {
      desired = [-1, 0, 1][Math.floor(rng() * 3)];
      sinceDecide = 0;
    }
    sinceDecide += 1;

    const launch = game.balls.some((ball) => ball.stuck);
    const input = { dir: desired, launch, scrub: null };
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
 * between requests **through JSON** (that is what D1 stores), the claim
 * resuming the park and stepping only the tail.
 */
function chunkedReplay({ difficultyName, bytes, chunkTicks = CHUNK_TICKS }) {
  let state = null;
  let worstChunkMs = 0;

  for (let start = 0; start < bytes.length; start += chunkTicks) {
    const window = Uint8Array.from(bytes.slice(start, start + chunkTicks));
    if (start === 0) {
      state = openBarleyBreakerChunkReplay({ difficulty: difficultyName, inputs: window });
    } else {
      // The park grows by exactly the ticks it receives — see appendChunkInputs.
      state.inputs = Uint8Array.from([...state.inputs, ...window]);
      state.total = state.inputs.length;
    }

    const t0 = performance.now();
    stepBarleyBreakerReplay(state, chunkTicks);
    worstChunkMs = Math.max(worstChunkMs, performance.now() - t0);

    // Park through D1's representation.
    state.match = JSON.parse(JSON.stringify(state.match));
  }

  return { state, worstChunkMs };
}

/** The claim's own request: validate, resume the park, step the tail, judge. */
function claimVerdict({ difficultyName, bytes, claimScore, park }) {
  const validated = validateBarleyBreakerReplay({
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
  stepBarleyBreakerReplay(resumed, CHUNK_TICKS); // the tail — usually zero steps

  if (resumed.cursor !== resumed.total) {
    return { matched: null, reason: "replay in progress" };
  }

  const outcome = barleyBreakerOutcome(resumed);
  const matched = outcome.score === claimScore && outcome.reachedFinale === true;
  return { matched, replayScore: outcome.score, outcome };
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The input codec
// ─────────────────────────────────────────────────────────────────────────────

{
  // Keyboard bytes: direction (bits 0-1) and launch (bit 2).
  for (const [input, expected] of [
    [{ dir: -1, launch: false, scrub: null }, 0],
    [{ dir: 0, launch: false, scrub: null }, 1],
    [{ dir: 1, launch: false, scrub: null }, 2],
    [{ dir: -1, launch: true, scrub: null }, 4],
    [{ dir: 0, launch: true, scrub: null }, 5],
    [{ dir: 1, launch: true, scrub: null }, 6],
  ]) {
    const code = encodeTick(input);
    check(code === expected, `keyboard byte: ${JSON.stringify(input)} → ${code}`, `expected ${expected}`);
    const back = decodeTick(code);
    check(
      back !== null && back.dir === input.dir && back.launch === input.launch && back.scrub === null,
      `keyboard round trip: ${JSON.stringify(input)}`,
    );
  }

  // Scrub bytes: bit 7 set, bits 0-6 the finger's position quantised to 127.
  for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
    const code = encodeTick({ dir: 0, launch: false, scrub: ratio });
    check((code & 0x80) !== 0, `scrub byte ${ratio} carries the scrub flag (${code})`);
    const back = decodeTick(code);
    const decoded = back?.scrub ?? null;
    check(
      decoded !== null && Math.abs(decoded - ratio) <= 1 / 127,
      `scrub round trip: ${ratio} → ${code} → ${decoded?.toFixed(4)}`,
    );
  }
  check(decodeTick(0x80)?.scrub === 0, "scrub byte 0x80 decodes to position 0");
  check(decodeTick(0xff)?.scrub === 1, "scrub byte 0xff decodes to position 1");

  // Bytes the client could never have written.
  for (const bad of [3, 7, 8, 40, 127]) {
    check(decodeTick(bad) === null, `byte ${bad} is not an input the client can produce`);
  }

  // The claim's journey: bytes → base64 → JSON → decoded bytes.
  const sample = [0, 1, 2, 4, 5, 6, 0x80, 0xbf, 0xff];
  const wire = JSON.parse(JSON.stringify({ inputs: bytesToWire(sample) }));
  const back = decodeInputLog(wire.inputs);
  check(
    Array.from(back).join(",") === sample.join(","),
    "log round trips through base64 and JSON",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B. The worker's validation: difficulty is derived, not believed
// ─────────────────────────────────────────────────────────────────────────────

const today = getBarleyBreakerDifficulty();
const yesterday = getBarleyBreakerDifficulty(Date.now() - 86_400_000);

{
  const dummy = { difficulty: today.name, ticks: 1, inputs: bytesToWire([1]) };

  const expectInputError = (payload, label) => {
    try {
      validateBarleyBreakerReplay(payload);
      check(false, label, "did not throw");
    } catch (error) {
      check(
        error instanceof ReplayInputError,
        label,
        `wrong error type: ${error}`,
      );
    }
  };

  const todayValidated = validateBarleyBreakerReplay(dummy);
  check(
    todayValidated.difficulty.name === today.name && todayValidated.total === 1,
    "today's difficulty validates with the worker's own parameters",
  );

  validateBarleyBreakerReplay({ ...dummy, difficulty: yesterday.name });
  check(true, "yesterday's difficulty validates (UTC-midnight-straddling runs)");

  const other = BARLEY_BREAKER_DIFFICULTIES.find(
    (d) => d.name !== today.name && d.name !== yesterday.name,
  );
  if (other) {
    expectInputError(
      { ...dummy, difficulty: other.name },
      `difficulty ${other.name} (not today/yesterday) is refused`,
    );
  }
  expectInputError({ ...dummy, difficulty: "impossible" }, "an unknown difficulty is refused");
  expectInputError(undefined, "a missing replay is refused");
  expectInputError({ difficulty: today.name }, "a replay without inputs is refused");
  expectInputError({ ...dummy, inputs: "!!! not base64 !!!" }, "garbage base64 is refused");
  expectInputError({ ...dummy, ticks: 2 }, "a ticks/byte-count mismatch (short) is refused");
  expectInputError({ ...dummy, ticks: 0, inputs: bytesToWire([]) }, "an empty log is refused");
  expectInputError({ ...dummy, ticks: -1 }, "a negative tick count is refused");
  expectInputError({ ...dummy, ticks: 1.5 }, "a fractional tick count is refused");
  expectInputError(
    { ...dummy, ticks: MAX_REPLAY_TICKS + 1, inputs: bytesToWire(new Array(MAX_REPLAY_TICKS + 1).fill(1)) },
    "a log over the shared ceiling is refused",
  );
  expectInputError(
    { ...dummy, ticks: 2, inputs: bytesToWire([1, 7]) },
    "a byte outside the encoding is refused (the client cannot produce it)",
  );
  expectInputError(
    { ...dummy, ticks: 3, inputs: bytesToWire([1, 127, 1]) },
    "byte 127 — a keyboard byte wider than the layout allows — is refused",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// C. A real win — a bot-played session pays, through the streamed pipeline
// ─────────────────────────────────────────────────────────────────────────────

// Play under whichever of today's/yesterday's difficulties is easiest to win
// (both are accepted, so the harness stays robust however the date hash falls).
console.log(
  `  [debug] today: ${today.name} (target ${today.targetScore}), yesterday: ${yesterday.name} (target ${yesterday.targetScore})`,
);
const easiest = [today, yesterday].reduce((a, b) => (a.targetScore <= b.targetScore ? a : b));

let winRun = null;
{
  let wins = 0;
  let bestScore = 0;
  for (let i = 0; i < 60 && !winRun; i++) {
    const seed = (20_261_016 + i * 7_919) >>> 0;
    const run = playSession(easiest, seed, { stepCap: 40_000 });
    if (run.game.score > bestScore) bestScore = run.game.score;
    if (run.game.won) wins += 1;
    if (run.game.won && !winRun) winRun = { seed, ...run };
  }

  if (!winRun) {
    console.log(`  [debug] bot search failed; trying extended search...`);
    for (let i = 60; i < 400 && !winRun; i++) {
      const seed = (20_261_016 + i * 7_919) >>> 0;
      const run = playSession(easiest, seed, { stepCap: 40_000 });
      if (run.game.score > bestScore) bestScore = run.game.score;
      if (run.game.won) wins += 1;
      if (run.game.won && !winRun) winRun = { seed, ...run };
    }
  }

  if (!winRun) {
    console.log(
      `  [debug] best score achieved on ${easiest.name}: ${bestScore} (target ${easiest.targetScore})`,
    );
  }
  check(winRun !== null, `the bot wins a ${easiest.name} session (target ${easiest.targetScore})`);
  check(wins > 0, "at least one honest winning session exists in the seeded search");
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
  // at every boundary — the D1 representation.
  const { state, worstChunkMs } = chunkedReplay({
    difficultyName: easiest.name,
    bytes: winRun.bytes,
  });
  check(state.cursor === state.total, "every window stepped; the park is complete");
  check(
    JSON.stringify(state.match) === JSON.stringify(winRun.game),
    "the streamed replay's final runtime is identical to the state the bot played to",
  );

  // The claim: resumes the fully-stepped park, steps only the tail.
  const verdict = claimVerdict({
    difficultyName: easiest.name,
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
    bytes: winRun.bytes,
    claimScore: winRun.game.score + 1,
    park: state,
  });
  check(
    badScore.matched === false,
    "a claim whose score disagrees with its own log is refused",
    JSON.stringify(badScore),
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
    bytes: winRun.bytes,
    claimScore: winRun.game.score,
    park: shortPark,
  });
  check(
    shortClaim.matched === null,
    "a claim whose park holds less log than it asserts is refused (binding)",
    JSON.stringify(shortClaim),
  );

  // The verdict must fit a Workers Free request per chunk — 25 ms is a loose
  // ceiling (CI machines vary); the point is catching an accidental blow-up.
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
  const { state } = chunkedReplay({ difficultyName: easiest.name, bytes });

  // Truncated log: the claim's ticks no longer match the park — refused by
  // the binding, before any simulation decides anything.
  const truncated = claimVerdict({
    difficultyName: easiest.name,
    bytes: bytes.slice(0, -1),
    claimScore: game.score,
    park: state,
  });
  check(
    truncated.matched === null,
    "a truncated log is refused (the park's binding fails)",
    JSON.stringify(truncated),
  );

  // Spliced final steps: the last stretch of input replaced with idles, so
  // the replay's paddle stops steering from that point and the run diverges —
  // it may still finish (out of lives, or a lower score), but it cannot
  // finish at the claimed score *as a win*.
  const spliceLen = Math.min(400, bytes.length - 1);
  const spliced = [...bytes.slice(0, -spliceLen), ...new Array(spliceLen).fill(IDLE)];
  const splicedPark = chunkedReplay({ difficultyName: easiest.name, bytes: spliced }).state;
  const splicedVerdict = claimVerdict({
    difficultyName: easiest.name,
    bytes: spliced,
    claimScore: game.score,
    park: splicedPark,
  });
  check(
    splicedVerdict.matched === false,
    "a log whose winning final steps are spliced away is refused",
    JSON.stringify(splicedVerdict),
  );

  // Steps after the win are no-ops: padding a winning log cannot inflate the
  // score the worker pays.
  const padded = [...bytes, ...new Array(500).fill(IDLE)];
  const paddedPark = chunkedReplay({ difficultyName: easiest.name, bytes: padded }).state;
  const paddedVerdict = claimVerdict({
    difficultyName: easiest.name,
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

// A finished session the player did not win — replays perfectly, pays nothing.
{
  let lossRun = null;
  for (let i = 0; i < 40 && !lossRun; i++) {
    const seed = (31_337 + i * 104_729) >>> 0;
    const run = playDrunk(easiest, seed);
    if (run.game.gameOver && !run.game.won && run.bytes.length < 12_000) lossRun = run;
  }
  check(lossRun !== null, "found a session that honestly ends in a loss");

  if (lossRun) {
    const park = chunkedReplay({ difficultyName: easiest.name, bytes: lossRun.bytes }).state;
    const verdict = claimVerdict({
      difficultyName: easiest.name,
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
  // the last ulp, and a breakout's chaos amplifies that into a different run
  // on a different engine. `Math.sqrt` is exempt — IEEE 754 specifies it
  // exactly, like `+ - * /` and the integer ops.
  check(
    !/Math\.(sin|cos|tan|asin|acos|atan|atan2|hypot|pow|exp|log|cbrt|expm1|log1p|log10|sinh|cosh|tanh)\(/.test(code),
    "engine.ts uses no transcendental (exact ops only: + - * / sqrt, imul)",
  );

  // Step purity: the same (runtime, input) twice is the same runtime.
  const base = createRuntime(today);
  const stepInput = { dir: 1, launch: true, scrub: null };
  const a = tick(base, FIXED_STEP_MS, stepInput);
  const b = tick(base, FIXED_STEP_MS, stepInput);
  check(JSON.stringify(a) === JSON.stringify(b), "tick is pure: same inputs, identical result");

  // The difficulty rides on the runtime and survives the park's JSON:
  // a round-tripped runtime steps identically to a live one.
  const roundTripped = JSON.parse(JSON.stringify(base));
  check(
    roundTripped.difficulty.name === today.name &&
      roundTripped.difficulty.targetScore === today.targetScore,
    "the baked difficulty survives a JSON park round trip",
  );
  const c = tick(roundTripped, FIXED_STEP_MS, stepInput);
  check(
    JSON.stringify(c) === JSON.stringify(a),
    "a JSON-round-tripped runtime steps identically to a live one",
  );

  // Scrub steps are just as pure — the absolute-position path lands on the
  // same paddle (and therefore the same bounces) every time.
  const scrubInput = { dir: 0, launch: false, scrub: 0.37 };
  const s1 = tick(base, FIXED_STEP_MS, scrubInput);
  const s2 = tick(base, FIXED_STEP_MS, scrubInput);
  check(JSON.stringify(s1) === JSON.stringify(s2), "a scrub step is pure too");

  // Replaying the same log twice reaches the same run.
  if (winRun) {
    const first = chunkedReplay({ difficultyName: easiest.name, bytes: winRun.bytes }).state;
    const second = chunkedReplay({ difficultyName: easiest.name, bytes: winRun.bytes }).state;
    check(
      first.match.score === second.match.score && first.cursor === second.cursor,
      "streaming the same log twice reaches the same run",
    );
  }

  // Start-from-scratch, as a claim with no park would: same log, same run.
  if (winRun) {
    const fresh = startBarleyBreakerReplay({
      difficulty: easiest.name,
      ticks: winRun.bytes.length,
      inputs: bytesToWire(winRun.bytes),
    });
    stepBarleyBreakerReplay(fresh, Number.MAX_SAFE_INTEGER);
    const outcome = barleyBreakerOutcome(fresh);
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
console.log("barley-breaker replay harness: all checks passed");
