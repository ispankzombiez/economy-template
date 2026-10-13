#!/usr/bin/env node
/**
 * Tetris replay harness — proves `(difficulty, inputs) => the same board`.
 *
 * ## Why this file exists
 *
 * The worker mints a Raven Coin only if its own re-run of the claimed session
 * ends `won` at the score the claim asserts. That guarantee rests on three
 * properties, and this harness fails loudly the moment any breaks:
 *
 *   1. **Parity.** `worker/src/tetrisReplay.js` holds its own copy of the engine
 *      because the worker cannot import TypeScript. That duplicate is the whole
 *      risk in this cabinet: two implementations of the same rules that are
 *      *supposed* to agree and are checked by nothing but review. Every check
 *      here that says "the worker's replay reaches the state the client reached"
 *      is a check on that duplication — the rule most likely to drift silently
 *      is the bag generator, because nothing else in the game depends on it.
 *   2. **Determinism.** No `Math.random()`, no clock, anywhere in `engine.ts`.
 *      The bag is a seeded LCG whose state rides on the runtime, so it advances
 *      across the park's JSON round trip instead of restarting.
 *   3. **Streamability.** A run is tens of thousands of steps, so it is
 *      replayed in `CHUNK_TICKS` windows with the match parked between them
 *      through JSON — which is also what proves `difficulty` and `rngState`
 *      survive being written to D1.
 *
 * ## What it checks
 *
 *   - **The bag is a bag.** Seven pieces, each exactly once, per shuffle; and
 *     the *sequence* advances rather than restarting (the regression that a
 *     reseeded-per-step generator produces: the same seven pieces forever).
 *   - **Parity, step for step.** A bot session is stepped by the client's
 *     engine and by the worker's, one step at a time, and the two states are
 *     compared at every single step — not only at the end, because a divergence
 *     that cancels out by the end is still a divergence.
 *   - **Parity across the park.** The same log replayed in 600-tick windows
 *     with JSON round trips at every boundary reaches the identical state.
 *   - **A real win pays** — the bot clears lines to the target, the streamed
 *     pipeline reports `matched: true`, and the score is the live score.
 *   - **Forgery is refused** — a score that disagrees with its own log, a log
 *     truncated away from its park, a log spliced at the end, a finished
 *     session the player did not win, an unknown difficulty, a difficulty that
 *     is neither today nor yesterday, bytes that disagree with `ticks`, a byte
 *     with a bit no key produces.
 *   - **Budget** — every chunk request's stepping fits a Workers Free request.
 *
 * ## How it runs
 *
 * Node cannot import TypeScript, and the two spellings of `@nightshade/shared`
 * resolve to different directories, so — exactly like `pacmanReplayTest.mjs` —
 * everything is bundled by esbuild with a resolve plugin answering both from
 * the same directory, which is the entire point of the shared package: one
 * file, two ends.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(ROOT, "src/features/arcade/games/tetris/engine.ts");
const SESSION = path.join(ROOT, "src/features/arcade/games/tetris/session.ts");
const WORKER_REPLAY = path.join(ROOT, "worker/src/tetrisReplay.js");
// `ReplayInputError` and `CHUNK_TICKS` live in the brawler's module — the
// shared plumbing every streamed cabinet throws and budgets against.
const SHARED_STREAM = path.join(ROOT, "worker/src/replay.js");
const SHARED = path.join(ROOT, "shared/anticheat");

const CACHE = path.join(ROOT, "node_modules/.cache/anticheat");
const ENTRY = path.join(CACHE, "tetris-entry.mjs");
const BUNDLE = path.join(CACHE, "tetris.bundle.mjs");

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
    `export * from ${JSON.stringify(toUrl(path.join(SHARED, "replayBudget.js")))};`,
  ].join("\n"),
);

await build({
  entryPoints: [ENTRY],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: BUNDLE,
  // The brawler's module rides along (ReplayInputError, CHUNK_TICKS), and its
  // engine imports art assets; none of that executes here, so the files are
  // stubbed empty exactly as `pacmanReplayTest.mjs` stubs them.
  loader: {
    ".png": "empty",
    ".webp": "empty",
    ".gif": "empty",
    ".mp3": "empty",
  },
  plugins: [
    {
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
  // Engine (client)
  BOARD_WIDTH,
  BOARD_HEIGHT,
  FIXED_STEP_MS,
  SHAPES,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_SOFT_DROP,
  INPUT_ROTATE_CW,
  INPUT_ROTATE_CCW,
  INPUT_HOLD,
  INPUT_HARD_DROP,
  INPUT_MASK,
  createRuntime,
  tick,
  encodeInputLog,
  decodeInputLog,
  getCells,
  // Session (difficulty + day seed, shared with the worker)
  TETRIS_DIFFICULTIES,
  getTetrisDifficulty,
  getTetrisDaySeed,
  // Worker verifier
  validateTetrisReplay,
  startTetrisReplay,
  openTetrisChunkReplay,
  stepTetrisReplay,
  tetrisOutcome,
  resolveTetrisDifficulty,
  daySeedOf,
  // Shared streamed plumbing (the brawler's module)
  ReplayInputError,
  CHUNK_TICKS,
  MAX_REPLAY_TICKS,
} = mod;

const bytesToWire = (bytes) => encodeInputLog(Uint8Array.from(bytes));

// ─────────────────────────────────────────────────────────────────────────────
// A. The bag: a bag, and a sequence that advances
// ─────────────────────────────────────────────────────────────────────────────

{
  // Every bag is a permutation of the seven kinds — no duplicates, no losses.
  //
  // Read the *tail* seven, not the first seven: the runtime's queue has already
  // had one piece dealt off its front (that is the active piece) and been topped
  // back up to 7, so the run opens holding the last seven of a shuffled bag plus
  // the remainder of the previous one. The last seven are the whole bag.
  const seenBags = new Set();
  let state = 0;
  let allPermutations = true;

  for (let bagIndex = 0; bagIndex < 200; bagIndex++) {
    const runtime = createRuntime(TETRIS_DIFFICULTIES[0], bagIndex * 2654435761);
    const bag = runtime.queue.slice(-7);
    const key = bag.join("");
    seenBags.add(key);
    if (new Set(bag).size !== 7) allPermutations = false;
    state += runtime.rngState;
  }

  check(allPermutations, "every opening bag holds each of the seven kinds once");
  check(seenBags.size > 150, `opening bags vary across seeds (${seenBags.size} distinct in 200)`);
  check(state !== 0, "the bag generator advances its state");

  // The regression this cabinet's design is most exposed to: a generator that
  // reseeds from the day's hash every step would deal the *same* bag forever, so
  // the piece after N locks would not depend on N. Sampling one runtime's first
  // three active pieces proves the sequence moves.
  const runtime = createRuntime(TETRIS_DIFFICULTIES[0], getTetrisDaySeed());
  const firstThree = [];
  let working = runtime;
  for (let i = 0; i < 3; i++) {
    firstThree.push(working.active.kind);
    // Lock the piece by hard-dropping it, which is what advances the bag.
    working = tick(working, FIXED_STEP_MS, INPUT_HARD_DROP);
  }
  check(
    new Set(firstThree).size >= 2,
    "the piece sequence advances as the run goes on",
    firstThree.join(","),
  );

  // And it must be reproducible: same seed, same three pieces.
  const repeat = createRuntime(TETRIS_DIFFICULTIES[0], getTetrisDaySeed());
  let repeatWorking = repeat;
  const repeatThree = [];
  for (let i = 0; i < 3; i++) {
    repeatThree.push(repeatWorking.active.kind);
    repeatWorking = tick(repeatWorking, FIXED_STEP_MS, INPUT_HARD_DROP);
  }
  check(
    repeatThree.join(",") === firstThree.join(","),
    "the same seed deals the same opening pieces",
  );

  // `rngState` must survive the park's JSON round trip, or a resumed chunk
  // would restart the bag and every long run would be refused.
  const parked = JSON.parse(JSON.stringify(runtime));
  check(
    parked.rngState === runtime.rngState && parked.difficulty.name === runtime.difficulty.name,
    "rngState and difficulty survive the park's JSON round trip",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B. Parity: the worker's engine, step for step
// ─────────────────────────────────────────────────────────────────────────────

/** Would this piece be legal where it is? The engine's own rule, re-used. */
function fits(board, piece) {
  return getCells(piece).every((c) => {
    if (c.x < 0 || c.x >= BOARD_WIDTH) return false;
    if (c.y < 0 || c.y >= BOARD_HEIGHT) return false;
    return board[c.y][c.x] === null;
  });
}

/**
 * Drop a candidate from the spawn row and hand back the board it would leave,
 * or `null` if it cannot be placed there at all.
 *
 * The search below is only as good as this, and this is only fair to the bot if
 * it models what the bot can *do*: turn the piece over at the top, slide it
 * across, then drop it. A simulation that lifts the piece above any overhang
 * would happily plan a drop the bot has no route to — and the bot, having no
 * route, would slide until it jammed and drop somewhere else entirely.
 */
function simulateDrop(board, piece, origin, rotation) {
  const candidate = { ...piece, x: origin, rotation, y: piece.y };
  if (!fits(board, candidate)) return null;

  let resting = candidate;
  while (fits(board, { ...resting, y: resting.y + 1 })) {
    resting = { ...resting, y: resting.y + 1 };
  }

  const merged = board.map((row) => row.slice());
  for (const c of getCells(resting)) {
    if (c.y < 0 || c.y >= BOARD_HEIGHT || c.x < 0 || c.x >= BOARD_WIDTH) return null;
    merged[c.y][c.x] = piece.kind;
  }

  // Clear completed rows the way the engine does, so the heuristic scores the
  // board the player would really be left with. Scoring the transient board —
  // one with a freshly finished row still lying in it — reads that row as extra
  // height, so completing a line looks like a mistake and the bot learns never
  // to do it. That single omission is the difference between a bot that tops
  // out at a few hundred points and one that reaches the target.
  const kept = merged.filter((row) => row.some((cell) => cell === null));
  const cleared = BOARD_HEIGHT - kept.length;
  const padding = Array.from({ length: cleared }, () =>
    new Array(BOARD_WIDTH).fill(null),
  );

  return [...padding, ...kept];
}

/**
 * How good a board looks. Lower is better.
 *
 * Completed lines dominate, then buried holes, then peak height, then
 * bumpiness. The weights are the usual Tetris ordering and the ordering is the
 * point: a bot that only minimises height will happily fill a board with
 * unreachable gaps and top out without ever completing a row.
 */
function scoreBoard(board) {
  const height = new Array(BOARD_WIDTH).fill(0);
  let holes = 0;
  let lines = 0;

  for (let x = 0; x < BOARD_WIDTH; x++) {
    // A hole is an *empty* cell with something above it — so the walk runs from
    // the floor upward, remembering that it has passed empty space. Counting
    // filled cells that sit on other filled cells instead (the obvious wrong
    // way round) makes "holes" a second, 90×-weighted copy of stack height, and
    // the whole evaluation collapses into "put the piece flat and low" — which
    // spreads every piece across the floor and never completes a row.
    let seenEmpty = false;
    for (let y = BOARD_HEIGHT - 1; y >= 0; y--) {
      if (board[y][x] === null) {
        seenEmpty = true;
      } else {
        if (seenEmpty) holes += 1;
        height[x] += 1;
      }
    }
  }

  for (let y = 0; y < BOARD_HEIGHT; y++) {
    if (board[y].every((cell) => cell !== null)) lines += 1;
  }

  let bumpiness = 0;
  for (let x = 1; x < BOARD_WIDTH; x++) {
    bumpiness += Math.abs(height[x] - height[x - 1]);
  }

  // Filled/empty boundaries inside each row: a flat outline built out of steps
  // still leaves the next piece nowhere to go, and this is what notices.
  let roughness = 0;
  for (let y = 0; y < BOARD_HEIGHT; y++) {
    for (let x = 1; x < BOARD_WIDTH; x++) {
      if ((board[y][x] === null) !== (board[y][x - 1] === null)) roughness += 1;
    }
  }

  // Weights, in the order the terms matter to a player. **Lower is better**, so
  // the sign is the whole ballgame: lines are sought and therefore *subtract*,
  // while holes, height and roughness are avoided and therefore *add*. Getting
  // the hole sign backwards turns the bot into a hole-filler — it scores a
  // placement with two buried gaps *below* a clean one and takes it, every time.
  //
  // Holes outrank everything else numerically: height and roughness can only
  // add a few hundred at their extreme, so a hole weight below ~200 lets a
  // placement buy its way out of an overhang.
  //
  // `roughness` is both the column-height differences and the filled/empty
  // boundaries inside each row. The second half is what stops the bot from
  // building a board that is technically flat in outline and full of steps —
  // which it will happily do, and which no following piece can use.
  return (
    -lines * 9_000 +
    holes * 400 +
    Math.max(...height) * 12 +
    bumpiness * 4 +
    roughness * 4
  );
}

/** The best score any placement of `piece` can reach on `board`. */
function bestPlacementScore(board, piece) {
  let best = Infinity;
  for (let rotation = 0; rotation < 4; rotation++) {
    for (let origin = 0; origin < BOARD_WIDTH; origin++) {
      const next = simulateDrop(board, piece, origin, rotation);
      if (next === null) continue;
      const score = scoreBoard(next);
      if (score < best) best = score;
    }
  }
  return best;
}

/**
 * Plan a placement: the `(origin, rotation)` whose drop leaves the best board
 * once the *next* piece has also been answered.
 *
 * Every origin is a candidate, not just the columns the piece happens to
 * straddle where it spawned — scored over the spawn footprint, a piece starting
 * at column 3 can only ever consider columns 3–6, so the right of the board
 * stays empty forever and every piece piles into the same few columns until the
 * run tops out.
 *
 * The lookahead is what turns this from "places each piece on its own merits"
 * into a player. Judged one piece at a time, a flat I-piece laid across a low
 * gap looks ideal and leaves a board the next piece cannot use; seen one piece
 * later, it is obviously wrong. Without it the bot clears a handful of lines and
 * tops out well short of the target.
 *
 * Only the shortlist is looked ahead on: all forty candidates at full depth is
 * forty times the work for a difference in decision quality that only shows up a
 * dozen pieces later, and the first few candidates are the ones worth the time.
 */
function choosePlacement(runtime, rng) {
  const candidates = [];

  for (let rotation = 0; rotation < 4; rotation++) {
    for (let origin = 0; origin < BOARD_WIDTH; origin++) {
      const board = simulateDrop(runtime.board, runtime.active, origin, rotation);
      if (board === null) continue;
      candidates.push({ origin, rotation, board, score: scoreBoard(board) });
    }
  }

  if (candidates.length === 0) {
    return { origin: runtime.active.x, rotation: runtime.active.rotation };
  }

  candidates.sort((a, b) => a.score - b.score);
  const shortlist = candidates.slice(0, 6);

  const nextKind = runtime.queue[0];
  const nextPiece = nextKind ? { kind: nextKind, rotation: 0, x: 3, y: 0 } : null;

  const scored = shortlist.map((candidate) => ({
    origin: candidate.origin,
    rotation: candidate.rotation,
    depth: nextPiece
      ? bestPlacementScore(candidate.board, nextPiece)
      : candidate.score,
  }));

  const bestDepth = Math.min(...scored.map((c) => c.depth));

  // Exact ties only. A near-tie margin was tried and is a trap: enough placements
  // score within a whisker of the best that sampling among them compounds into
  // materially worse play, and the run tops out well short of the target. Equal
  // scores are genuinely equivalent placements, so choosing among them is play
  // rather than noise — and it is what gives the search more than one run to
  // check a replay against without making the bot worse at the game.
  const good = scored.filter((c) => c.depth === bestDepth);
  return good[Math.floor(rng() * good.length)];
}

/**
 * A bot that plays the way a player does: it *plans* a placement, turns the
 * piece until it is the right way up, holds the arrow key across as many ticks
 * as the slide takes, and only lets go to hard-drop once it is there.
 *
 * The plan lives in the bot rather than being recomputed per tick, and that is
 * not a shortcut — it is what makes the log's *held* bits meaningful. A bot that
 * re-decided every tick would emit a one-tick `LEFT` followed by a one-tick
 * `RIGHT`, and the worker's replay would faithfully slide a piece nowhere.
 */
function playSession(difficulty, seed, { stepCap = 200_000 } = {}) {
  // The bag is the *day's*, not `seed`.
  //
  // This is the one thing the bot is not free to choose. The worker re-derives
  // the bag from the UTC date and cannot be told a seed, so a bot opening on any
  // other seed produces a run the worker is structurally unable to reproduce —
  // the replay diverges on the first piece that matters and every check below
  // fails for a reason that has nothing to do with the code under test.
  //
  // `seed` therefore drives only the bot's *choices* (tie-breaks and pacing),
  // which is the honest way to get more than one candidate run out of a bag
  // that is fixed for the day.
  const runtime = createRuntime(difficulty, getTetrisDaySeed());
  let working = runtime;
  const bytes = [];

  let rngState = (seed >>> 0) || 1;
  const rng = () => {
    rngState = (Math.imul(rngState, 1_664_525) + 1_013_904_223) >>> 0;
    return rngState / 4_294_967_296;
  };

  let plan = null;
  let patience = 0;
  let stuckTicks = 0;
  let lastMoved = true;

  while (!working.gameOver && bytes.length < stepCap) {
    if (plan === null) {
      plan = choosePlacement(working, rng);
      // 4–18 ticks: a fraction of a second to a second, which is the range a
      // person actually takes to commit a piece they have just slid into place.
      patience = 4 + Math.floor(rng() * 15);
      stuckTicks = 0;
      lastMoved = true;
    }

    const turns = (plan.rotation - working.active.rotation + 4) % 4;
    const arrived = turns === 0 && working.active.x === plan.origin;

    let input = 0;
    if (turns > 0) input = INPUT_ROTATE_CW;
    else if (working.active.x < plan.origin) input = INPUT_RIGHT;
    else if (working.active.x > plan.origin) input = INPUT_LEFT;
    else if (patience > 0) patience -= 1;
    else input = INPUT_HARD_DROP;

    // A key held against a wall changes nothing, and a rotation the kick table
    // cannot accommodate changes nothing either — so "nothing moved on the last
    // step" has to cover both, or the bot holds the key down to the end of the
    // log and never drops. It has to be a flag carried across the step rather
    // than an x comparison: reading both x's out of the same post-step state
    // compares the piece with itself and always answers "did not move".
    stuckTicks = !lastMoved && input !== INPUT_HARD_DROP ? stuckTicks + 1 : 0;
    if (stuckTicks >= 8) input = INPUT_HARD_DROP;

    bytes.push(input);
    const before = { x: working.active.x, r: working.active.rotation };
    working = tick(working, FIXED_STEP_MS, input);
    lastMoved = working.active.x !== before.x || working.active.rotation !== before.r;

    if (input === INPUT_HARD_DROP) plan = null;
  }

  return { game: working, bytes };
}

// The claim's own request: validate, resume the park, step the tail, judge.
function claimVerdict({ difficultyName, bytes, claimScore, park }) {
  const validated = validateTetrisReplay({
    difficulty: difficultyName,
    ticks: bytes.length,
    inputs: bytesToWire(bytes),
  });

  // The binding a claim must satisfy: the park holds exactly this log.
  if (park.total !== validated.inputs.length) {
    return { matched: null, reason: "park/claim length binding failed" };
  }

  const resumed = {
    match: park.match,
    inputs: validated.inputs,
    cursor: park.cursor,
    total: park.total,
  };
  stepTetrisReplay(resumed, CHUNK_TICKS); // the tail — usually zero steps

  if (resumed.cursor !== resumed.total) {
    return { matched: null, reason: "replay in progress" };
  }

  const outcome = tetrisOutcome(resumed);
  return {
    matched: outcome.score === claimScore && outcome.reachedFinale === true,
    replayScore: outcome.score,
    outcome,
  };
}

const today = getTetrisDifficulty();
const yesterday = getTetrisDifficulty(Date.now() - 86_400_000);

{
  // Difficulty is the worker's to derive, not the claim's to assert.
  check(
    resolveTetrisDifficulty().name === today.name,
    "the worker's difficulty matches the client's for today",
  );
  check(
    daySeedOf(Date.now()) === getTetrisDaySeed(),
    "the worker's day seed matches the client's",
  );
  check(
    resolveTetrisDifficulty(Date.now() - 86_400_000).name === yesterday.name,
    "the worker's difficulty matches the client's for yesterday",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// C. A real win, and the parity that makes it meaningful
// ─────────────────────────────────────────────────────────────────────────────

// Play under whichever of today's/yesterday's difficulties is easiest to win
// (both are accepted, so the harness stays robust however the date hash falls).
const easiest = [today, yesterday].reduce((a, b) =>
  a.targetScore <= b.targetScore ? a : b,
);

let winRun = null;
{
  let bestScore = 0;
  let wins = 0;

  for (let i = 0; i < 24 && !winRun; i++) {
    const run = playSession(easiest, i * 7919 + 13);
    if (run.game.score > bestScore) bestScore = run.game.score;
    if (run.game.won) wins += 1;
    if (run.game.won && !winRun) winRun = { attempt: i, ...run };
  }

  check(
    winRun !== null,
    `the bot wins a ${easiest.name} session (target ${easiest.targetScore})`,
    `best score ${bestScore} over 24 attempts`,
  );
  check(wins > 0, "at least one honest winning session exists in the search");
}

if (winRun) {
  const { game, bytes } = winRun;

  check(
    bytes.length > CHUNK_TICKS,
    `the winning run (${bytes.length} steps) needs more than one chunk`,
  );
  check(
    bytes.length <= MAX_REPLAY_TICKS,
    "the winning run fits the shared tick ceiling",
  );

  // ── The parity check: the worker's engine, against the client's, every step.
  //
  // This is the check that exists because `tetrisReplay.js` is a duplicate of
  // `engine.ts`. It compares *intermediate* states, not just the ending: two
  // engines that diverge at step 40 and agree again by step 4,000 would pass an
  // end-only check while being wrong for four thousand ticks — and the refusal
  // that misbehaves in production is the one that only shows up on runs long
  // enough to have cancelled the divergence out.
  let parityChecked = 0;
  let parityFailure = null;

  const clientState = startTetrisReplay(
    validateTetrisReplay({
      difficulty: easiest.name,
      ticks: bytes.length,
      inputs: bytesToWire(bytes),
    }),
  );
  stepTetrisReplay(clientState, Number.MAX_SAFE_INTEGER);
  const workFinal = clientState.match;

  // Re-step both engines side by side.
  let clientSide = createRuntime(easiest, getTetrisDaySeed());
  let workerSide = createRuntime(easiest, getTetrisDaySeed());
  for (let i = 0; i < bytes.length && !parityFailure; i++) {
    clientSide = tick(clientSide, FIXED_STEP_MS, bytes[i]);
    // The verifier's contract is in-place mutation, so the park is advanced by
    // calling it — reading a return value here would be testing a shape the
    // worker does not have.
    const park = {
      match: workerSide,
      inputs: Uint8Array.from(bytes),
      cursor: i,
      total: bytes.length,
    };
    stepTetrisReplay(park, 1);
    workerSide = park.match;
    parityChecked++;
    if (JSON.stringify(clientSide) !== JSON.stringify(workerSide)) {
      parityFailure = `diverged at step ${i}`;
    }
  }

  check(
    parityFailure === null,
    `the worker's engine matches the client's on every one of ${parityChecked} steps`,
    parityFailure ?? "",
  );
  check(
    JSON.stringify(workerSide) === JSON.stringify(clientSide),
    "the two engines agree on the final board, bag, hold, level and score",
  );
  check(
    JSON.stringify(workFinal) === JSON.stringify(game),
    "the worker's whole-log replay lands on the state the client played to",
  );

  // ── The streamed pipeline, with the park JSON round-tripped at every boundary.
  let state = null;
  let worstChunkMs = 0;

  for (let start = 0; start < bytes.length; start += CHUNK_TICKS) {
    const window = Uint8Array.from(bytes.slice(start, start + CHUNK_TICKS));
    if (start === 0) {
      state = openTetrisChunkReplay({ difficulty: easiest.name, inputs: window });
    } else {
      // The park grows by exactly the ticks it receives — see appendChunkInputs.
      state.inputs = Uint8Array.from([...state.inputs, ...window]);
      state.total = state.inputs.length;
    }

    const t0 = performance.now();
    stepTetrisReplay(state, CHUNK_TICKS);
    worstChunkMs = Math.max(worstChunkMs, performance.now() - t0);

    // Park through D1's representation.
    state.match = JSON.parse(JSON.stringify(state.match));
  }

  check(state.cursor === state.total, "every window stepped; the park is complete");
  check(
    JSON.stringify(state.match) === JSON.stringify(game),
    "the streamed replay's final runtime is identical to the state the client played to",
    "the bag or the difficulty did not survive the park's JSON round trip",
  );

  const verdict = claimVerdict({
    difficultyName: easiest.name,
    bytes,
    claimScore: game.score,
    park: state,
  });
  check(
    verdict.matched === true && verdict.replayScore === game.score,
    "a played-to-win session verifies (matched: true)",
    JSON.stringify(verdict),
  );

  // …and the same log with a score that disagrees is still refused.
  const badScore = claimVerdict({
    difficultyName: easiest.name,
    bytes,
    claimScore: game.score + 1,
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
    bytes,
    claimScore: game.score,
    park: shortPark,
  });
  check(
    shortClaim.matched === null,
    "a claim whose park holds less log than it asserts is refused (binding)",
    JSON.stringify(shortClaim),
  );

  // Every chunk request's stepping has to fit a Workers Free request. 25 ms is
  // a loose ceiling (CI machines vary); the point is catching a blow-up.
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

  // Truncated log: the claim's ticks no longer match the park — refused by
  // the binding, before any simulation decides anything.
  const truncated = claimVerdict({
    difficultyName: easiest.name,
    bytes: bytes.slice(0, -1),
    claimScore: game.score,
    park: {
      match: JSON.parse(JSON.stringify(game)),
      cursor: bytes.length,
      total: bytes.length,
      inputs: Uint8Array.from(bytes),
    },
  });
  check(
    truncated.matched === null,
    "a truncated log is refused (the park's binding fails)",
    JSON.stringify(truncated),
  );

  // The last few steps are where the win is reached, so cutting them off leaves
  // the replay short of the target: a completed replay that never wins.
  //
  // Replayed from tick zero rather than through a park, because the point is the
  // *log* — a shorter log that no longer reaches the target — and stepping it
  // whole says that directly without also testing the binding, which the
  // truncated-log case above already covers.
  const cutBack = Math.min(40, bytes.length - 1);
  const cut = bytes.slice(0, -cutBack);
  const cutState = startTetrisReplay(
    validateTetrisReplay({
      difficulty: easiest.name,
      ticks: cut.length,
      inputs: bytesToWire(cut),
    }),
  );
  stepTetrisReplay(cutState, Number.MAX_SAFE_INTEGER);
  const cutOutcome = tetrisOutcome(cutState);
  check(
    cutOutcome.reachedFinale === false,
    "a log cut just short of the win does not reach the target",
    JSON.stringify(cutOutcome),
  );

  // Steps after the win are no-ops: padding a winning log cannot inflate the
  // score the worker pays.
  const padded = [...bytes, ...new Array(500).fill(0)];
  const paddedState = startTetrisReplay(
    validateTetrisReplay({
      difficulty: easiest.name,
      ticks: padded.length,
      inputs: bytesToWire(padded),
    }),
  );
  stepTetrisReplay(paddedState, Number.MAX_SAFE_INTEGER);
  check(
    paddedState.match.score === game.score && paddedState.match.won === true,
    "post-win padding cannot change the score the replay produces",
    `score ${paddedState.match.score} vs ${game.score}`,
  );
}

// A finished session the player did not win — replays perfectly, pays nothing.
{
  let lossRun = null;
  for (let i = 0; i < 12 && !lossRun; i++) {
    // Nothing but hard drops: the board fills, the run ends, nobody wins.
    const runtime = createRuntime(easiest, getTetrisDaySeed());
    let working = runtime;
    const bytes = [];
    while (!working.gameOver && bytes.length < 40_000) {
      bytes.push(INPUT_HARD_DROP);
      working = tick(working, FIXED_STEP_MS, INPUT_HARD_DROP);
    }
    if (working.gameOver && !working.won) {
      lossRun = { game: working, bytes };
    }
  }
  check(lossRun !== null, "found a session that honestly ends in a loss");

  if (lossRun) {
    const state = startTetrisReplay(
      validateTetrisReplay({
        difficulty: easiest.name,
        ticks: lossRun.bytes.length,
        inputs: bytesToWire(lossRun.bytes),
      }),
    );
    stepTetrisReplay(state, Number.MAX_SAFE_INTEGER);
    const outcome = tetrisOutcome(state);
    check(
      outcome.reachedFinale === false,
      "the loss replay reports reachedFinale: false",
      JSON.stringify(outcome),
    );
    check(
      outcome.score === lossRun.game.score,
      "the loss replay reproduces the loss score exactly",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// E. Validation: everything that is not a well-formed submission
// ─────────────────────────────────────────────────────────────────────────────

{
  const dummy = { difficulty: today.name, ticks: 1, inputs: bytesToWire([0]) };

  const expectInputError = (payload, label) => {
    try {
      validateTetrisReplay(payload);
      check(false, label, "did not throw");
    } catch (error) {
      check(
        error instanceof ReplayInputError,
        label,
        `wrong error type: ${error}`,
      );
    }
  };

  const validated = validateTetrisReplay(dummy);
  check(
    validated.difficulty.name === today.name && validated.inputs.length === 1,
    "today's difficulty validates with the worker's own parameters",
  );

  validateTetrisReplay({ ...dummy, difficulty: yesterday.name });
  check(true, "yesterday's difficulty validates (UTC-midnight-straddling runs)");

  const other = TETRIS_DIFFICULTIES.find(
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
    {
      ...dummy,
      ticks: MAX_REPLAY_TICKS + 1,
      inputs: bytesToWire(new Array(MAX_REPLAY_TICKS + 1).fill(0)),
    },
    "a log over the shared ceiling is refused",
  );
  expectInputError(
    { ...dummy, ticks: 2, inputs: bytesToWire([0, 0x80]) },
    "a byte with a bit no key produces is refused",
  );

  // First-chunk validation is the same rule, since it is the same field.
  const chunkError = (payload, label) => {
    try {
      openTetrisChunkReplay(payload);
      check(false, label, "did not throw");
    } catch (error) {
      check(error instanceof ReplayInputError, label, `wrong error type: ${error}`);
    }
  };
  chunkError({ inputs: Uint8Array.from([0]) }, "a first chunk with no difficulty is refused");
  chunkError({ difficulty: today.name, inputs: Uint8Array.from([]) }, "an empty first chunk is refused");
  chunkError({ difficulty: "impossible", inputs: Uint8Array.from([0]) }, "a first chunk with an unknown difficulty is refused");
  chunkError(
    { difficulty: today.name, inputs: Uint8Array.from(new Array(CHUNK_TICKS + 1).fill(0)) },
    `a first chunk over ${CHUNK_TICKS} ticks is refused`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// F. Determinism and the engine's purity
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

  // Step purity: the same (runtime, input) twice is the same runtime.
  const base = createRuntime(today, 12345);
  const a = tick(base, FIXED_STEP_MS, INPUT_HARD_DROP);
  const b = tick(base, FIXED_STEP_MS, INPUT_HARD_DROP);
  check(JSON.stringify(a) === JSON.stringify(b), "tick is pure: same inputs, identical result");

  // Steps after the run ends are a no-op, which is what makes post-win padding
  // harmless rather than fatal. Drive to a real ending first — one hard drop
  // does not end a run, so a step applied to a *live* board would move the
  // board and the check would prove nothing.
  const toSettled = createRuntime(easiest, getTetrisDaySeed());
  let settled = toSettled;
  let settleSteps = 0;
  while (!settled.gameOver && settleSteps < 4_000) {
    settled = tick(settled, FIXED_STEP_MS, INPUT_HARD_DROP);
    settleSteps += 1;
  }
  check(settled.gameOver === true, `a run of hard drops ends (${settleSteps} steps)`);
  if (settled.gameOver) {
    check(
      JSON.stringify(tick(settled, FIXED_STEP_MS, INPUT_HARD_DROP)) ===
        JSON.stringify(settled),
      "a step after the run has settled changes nothing",
    );
  }

  // Streaming the same log twice reaches the same run.
  if (winRun) {
    const once = startTetrisReplay(
      validateTetrisReplay({
        difficulty: easiest.name,
        ticks: winRun.bytes.length,
        inputs: bytesToWire(winRun.bytes),
      }),
    );
    const twice = startTetrisReplay(
      validateTetrisReplay({
        difficulty: easiest.name,
        ticks: winRun.bytes.length,
        inputs: bytesToWire(winRun.bytes),
      }),
    );
    stepTetrisReplay(once, Number.MAX_SAFE_INTEGER);
    stepTetrisReplay(twice, Number.MAX_SAFE_INTEGER);
    check(
      JSON.stringify(once.match) === JSON.stringify(twice.match),
      "streaming the same log twice reaches the same run",
    );
  }

  // One press, one cell.
  //
  // This is the regression the first conversion of this cabinet shipped: LEFT
  // was recorded as a *held* bit, so the step function slid one cell per 16 ms
  // tick for as long as the bit survived, and an ordinary 100 ms tap shunted the
  // piece six columns. The log still replayed perfectly — it is the same bytes
  // either way — so nothing about verification caught it. Only a check that asks
  // what a press *does* will.
  {
    const fresh = createRuntime(today, 4242);

    const leftOnce = tick(fresh, FIXED_STEP_MS, INPUT_LEFT);
    check(
      leftOnce.active.x === fresh.active.x - 1,
      "a single LEFT press moves the piece exactly one cell",
      `moved ${fresh.active.x - leftOnce.active.x}`,
    );

    const rightOnce = tick(fresh, FIXED_STEP_MS, INPUT_RIGHT);
    check(
      rightOnce.active.x === fresh.active.x + 1,
      "a single RIGHT press moves the piece exactly one cell",
      `moved ${rightOnce.active.x - fresh.active.x}`,
    );

    const twice = tick(leftOnce, FIXED_STEP_MS, INPUT_LEFT);
    check(
      twice.active.x === fresh.active.x - 2,
      "two presses in two ticks move it two cells",
      `moved ${fresh.active.x - twice.active.x}`,
    );

    // An idle tick must not drift sideways: holding is the *player's* business,
    // expressed as more presses, never the step function's.
    const idle = tick(fresh, FIXED_STEP_MS, 0);
    check(
      idle.active.x === fresh.active.x,
      "an idle tick does not move the piece sideways",
    );

    // And a press does not rotate, or bank, or drop.
    check(
      idle.active.rotation === fresh.active.rotation &&
        idle.hold === fresh.hold &&
        idle.gameOver === fresh.gameOver,
      "an idle tick does not rotate, bank or drop",
    );
  }

  // The input byte is a bitfield, and every bit a client may set is one a key
  // produces: the mask is exactly the seven inputs.
  check(
    INPUT_MASK ===
      (INPUT_LEFT | INPUT_RIGHT | INPUT_SOFT_DROP | INPUT_ROTATE_CW |
        INPUT_ROTATE_CCW | INPUT_HOLD | INPUT_HARD_DROP),
    "the accepted input mask is exactly the seven key bits",
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const total = passes.length + failures.length;
console.log(`\n${passes.length}/${total} checks passed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log("tetris replay harness: all checks passed");