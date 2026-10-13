/**
 * Tetris's verifier — the worker's re-simulation of a claimed run.
 *
 * ## What the proof is
 *
 * `{ difficulty, ticks, inputs }`. There is no seed field and there is not one
 * to have: the piece bag is generated from the *day* the run was opened on
 * (`getTetrisDaySeed`), which the worker re-derives from its own clock and
 * accepts only as today's or yesterday's. A client-chosen bag seed could not be
 * checked at all, so every honest run would be refused — the coin would cost a
 * ticket and never pay.
 *
 * The input log is one byte per fixed 16 ms step: a bitfield of the keys held
 * (`LEFT`, `RIGHT`, `SOFT_DROP`) and pressed that step (`ROTATE_CW`,
 * `ROTATE_CCW`, `HOLD`, `HARD_DROP`). Both ends run the same `tick`, so a run
 * this long is verified by stepping it, not by pattern-matching a summary.
 *
 * ## Why this module holds its own copy of the engine
 *
 * `engine.ts` is TypeScript and the worker is not, so bundling it is not an
 * option. The copy below is therefore a duplicate, and the two are kept honest
 * the only way they can be: `scripts/tetrisReplayTest.mjs` plays real sessions
 * through *this* module and asserts they reach the state the client reached,
 * step for step. A divergence in the rules shows up there as a failed replay
 * parity check rather than as a refused coin on a live run.
 *
 * ## What the park holds
 *
 * `state.match` is the whole runtime, JSON — board, active piece, the queue, the
 * hold, the level and score, and crucially `difficulty` and `rngState`. Both
 * travel in the park because both are what makes this game *this* game: a park
 * resumed after a chunk boundary (or after UTC midnight) has to keep dealing
 * from the same bag and scoring against the same target.
 */

import { CHUNK_TICKS, ReplayInputError } from "./replay.js";
import { decodeInputLog } from "@nightshade/shared/inputLog";

// ── Protocol ──────────────────────────────────────────────────────────────────

const FIXED_STEP_MS = 16;
const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 20;
const MAX_LEVEL = 12;
const LINES_PER_LEVEL = 10;
const SOFT_DROP_MULTIPLIER = 5;

/** The tick ceiling the worker accepts, and the one `replay.js` enforces. */
const MAX_REPLAY_TICKS = 64_000;

const INPUT_LEFT = 1 << 0;
const INPUT_RIGHT = 1 << 1;
const INPUT_SOFT_DROP = 1 << 2;
const INPUT_ROTATE_CW = 1 << 3;
const INPUT_ROTATE_CCW = 1 << 4;
const INPUT_HOLD = 1 << 5;
const INPUT_HARD_DROP = 1 << 6;

/** Bits above this are not a player input. A log that sets one was not typed. */
const INPUT_MASK =
  INPUT_LEFT |
  INPUT_RIGHT |
  INPUT_SOFT_DROP |
  INPUT_ROTATE_CW |
  INPUT_ROTATE_CCW |
  INPUT_HOLD |
  INPUT_HARD_DROP;

// ── Difficulty (mirrors `tetris/session.ts`) ──────────────────────────────────

const TETRIS_DIFFICULTIES = [
  {
    name: "easy",
    label: "Easy",
    targetScore: 12000,
    startLevel: 1,
    weight: 3,
  },
  {
    name: "medium",
    label: "Medium",
    targetScore: 35000,
    startLevel: 3,
    weight: 3,
  },
  {
    name: "hard",
    label: "Hard",
    targetScore: 80000,
    startLevel: 5,
    weight: 2,
  },
];

const todayKeyOf = (now) => {
  const d = new Date(now);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
};

/**
 * The day's seed — the difficulty pick *and* the bag.
 *
 * One hash for both on purpose. A run is one reproducible thing; splitting the
 * day into "the seed that picked the target" and "the seed that dealt the
 * pieces" would be two things to agree on, and disagreement is exactly what a
 * replay is looking for.
 */
const daySeedOf = (now) =>
  todayKeyOf(now)
    .split("")
    .reduce((accumulator, character) => {
      return Math.imul(accumulator, 31) + character.charCodeAt(0);
    }, 131) >>> 0;

/** Which difficulty the UTC clock says today is. */
function resolveTetrisDifficulty(now = Date.now()) {
  const totalWeight = TETRIS_DIFFICULTIES.reduce(
    (sum, difficulty) => sum + difficulty.weight,
    0,
  );
  const normalizedSeed = daySeedOf(now) % totalWeight;

  let threshold = 0;
  for (const difficulty of TETRIS_DIFFICULTIES) {
    threshold += difficulty.weight;
    if (normalizedSeed < threshold) return difficulty;
  }

  return TETRIS_DIFFICULTIES[TETRIS_DIFFICULTIES.length - 1];
}

/**
 * The difficulty *object* for a claim, by the name the claim sent.
 *
 * Today's or yesterday's only. The reason is the same as every other daily
 * cabinet: the difficulty sets the target score, so accepting whatever name
 * arrives would make "always claim easy" free money. Yesterday is accepted
 * because a run can start before the UTC date rolls over and finish after it,
 * and refusing that would refuse an honestly won coin.
 */
function difficultyForClaim(name) {
  const today = resolveTetrisDifficulty();
  if (name === today.name) return { difficulty: today, now: Date.now() };

  const yesterday = resolveTetrisDifficulty(Date.now() - 86_400_000);
  if (name === yesterday.name) return { difficulty: yesterday, now: Date.now() - 86_400_000 };

  throw new ReplayInputError(
    `Difficulty "${name}" is neither today's nor yesterday's.`,
  );
}

// ── Engine (mirrors `tetris/engine.ts`) ───────────────────────────────────────

const PIECE_ORDER = ["I", "O", "T", "S", "Z", "J", "L"];

const SHAPES = {
  I: [
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }],
    [{ x: 2, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 2, y: 3 }],
    [{ x: 0, y: 2 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 3, y: 2 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 1, y: 3 }],
  ],
  O: [
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
  ],
  T: [
    [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }],
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }],
    [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
  ],
  S: [
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
    [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
  ],
  Z: [
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 2, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 2 }],
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }],
    [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 0, y: 2 }],
  ],
  J: [
    [{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 2 }],
  ],
  L: [
    [{ x: 2, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }],
    [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }],
    [{ x: 0, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }, { x: 0, y: 2 }],
    [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 2 }],
  ],
};

/**
 * One step of the bag generator: the draw, and the state to draw from next.
 *
 * Explicit state-in/state-out rather than a closure over a mutable variable,
 * because the state lives on the runtime and has to survive the park's JSON
 * round trip. A closure would reseed from scratch on every resumed chunk and
 * deal the same seven pieces again.
 */
const nextRandom = (state) => {
  const next = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return { value: next / 4294967296, state: next };
};

const shuffledBag = (rngState) => {
  const bag = PIECE_ORDER.slice();
  let state = rngState;

  for (let index = bag.length - 1; index > 0; index--) {
    const drawn = nextRandom(state);
    state = drawn.state;
    const swapIndex = Math.floor(drawn.value * (index + 1));
    const temp = bag[index];
    bag[index] = bag[swapIndex];
    bag[swapIndex] = temp;
  }

  return { bag, rngState: state };
};

const QUEUE_TARGET = 7;

const ensureQueue = (queue, rngState) => {
  if (queue.length >= QUEUE_TARGET) return { queue, rngState };
  const drawn = shuffledBag(rngState);
  return { queue: queue.concat(drawn.bag), rngState: drawn.rngState };
};

const popNextPiece = (queue, rngState) => {
  const prepared = ensureQueue(queue, rngState);
  const nextKind = prepared.queue[0];
  const remaining = prepared.queue.slice(1);
  const topped = ensureQueue(remaining, prepared.rngState);
  return { nextKind, queue: topped.queue, rngState: topped.rngState };
};

const createBoard = () =>
  Array.from({ length: BOARD_HEIGHT }, () => Array(BOARD_WIDTH).fill(null));

const spawnPiece = (kind) => ({ kind, rotation: 0, x: 3, y: 0 });

const getCells = (piece) =>
  SHAPES[piece.kind][piece.rotation].map((c) => ({
    x: piece.x + c.x,
    y: piece.y + c.y,
  }));

const isValid = (board, piece) =>
  getCells(piece).every((cell) => {
    if (cell.x < 0 || cell.x >= BOARD_WIDTH) return false;
    if (cell.y < 0 || cell.y >= BOARD_HEIGHT) return false;
    return board[cell.y][cell.x] === null;
  });

const mergePiece = (board, piece) => {
  const next = board.map((row) => row.slice());
  for (const cell of getCells(piece)) {
    if (
      cell.y >= 0 &&
      cell.y < BOARD_HEIGHT &&
      cell.x >= 0 &&
      cell.x < BOARD_WIDTH
    ) {
      next[cell.y][cell.x] = piece.kind;
    }
  }
  return next;
};

const clearLines = (board) => {
  const remaining = board.filter((row) => row.some((cell) => cell === null));
  const cleared = BOARD_HEIGHT - remaining.length;
  const padding = Array.from({ length: cleared }, () =>
    Array(BOARD_WIDTH).fill(null),
  );
  return { board: padding.concat(remaining), cleared };
};

const scoreForLines = (lines, level) => {
  if (lines <= 0) return 0;
  const base = lines === 1 ? 100 : lines === 2 ? 300 : lines === 3 ? 500 : 800;
  return base * level;
};

const getGuidelineFallIntervalMs = (level) => {
  const capped = Math.min(level, MAX_LEVEL);
  return Math.pow(0.8 - (capped - 1) * 0.007, capped - 1) * 1000;
};

const withLockedPiece = (runtime) => {
  const merged = mergePiece(runtime.board, runtime.active);
  const { board, cleared } = clearLines(merged);
  const newLinesCleared = runtime.linesCleared + cleared;
  const newLevel = Math.min(
    runtime.difficulty.startLevel +
      Math.floor(newLinesCleared / LINES_PER_LEVEL),
    MAX_LEVEL,
  );
  const score = runtime.score + scoreForLines(cleared, newLevel);

  if (score >= runtime.difficulty.targetScore) {
    return {
      ...runtime,
      board,
      score,
      level: newLevel,
      linesCleared: newLinesCleared,
      gameOver: true,
      won: true,
      reason: "Target score reached",
    };
  }

  const drawn = popNextPiece(runtime.queue, runtime.rngState);
  const active = spawnPiece(drawn.nextKind);

  if (!isValid(board, active)) {
    return {
      ...runtime,
      board,
      score,
      level: newLevel,
      linesCleared: newLinesCleared,
      queue: drawn.queue,
      rngState: drawn.rngState,
      active,
      gameOver: true,
      won: false,
      reason: "Board overflow",
    };
  }

  return {
    ...runtime,
    board,
    score,
    level: newLevel,
    linesCleared: newLinesCleared,
    queue: drawn.queue,
    rngState: drawn.rngState,
    active,
    holdUsed: false,
    dropAccumulatorMs: 0,
  };
};

const movePiece = (runtime, dx, dy) => {
  const moved = {
    ...runtime.active,
    x: runtime.active.x + dx,
    y: runtime.active.y + dy,
  };
  if (!isValid(runtime.board, moved)) return null;
  return { ...runtime, active: moved };
};

const rotatePiece = (runtime, direction) => {
  const rotated = {
    ...runtime.active,
    rotation: (runtime.active.rotation + direction + 4) % 4,
  };

  for (const kick of [0, -1, 1, -2, 2]) {
    const candidate = { ...rotated, x: rotated.x + kick };
    if (isValid(runtime.board, candidate)) {
      return { ...runtime, active: candidate };
    }
  }

  return runtime;
};

const hardDrop = (runtime) => {
  let dropped = runtime;
  let distance = 0;

  for (let step = 0; step < BOARD_HEIGHT; step++) {
    const moved = movePiece(dropped, 0, 1);
    if (!moved) break;
    dropped = moved;
    distance += 1;
  }

  return withLockedPiece({ ...dropped, score: dropped.score + distance * 2 });
};

const holdPiece = (runtime) => {
  if (runtime.holdUsed) return runtime;

  const banking = runtime.active.kind;

  if (runtime.hold === null) {
    const drawn = popNextPiece(runtime.queue, runtime.rngState);
    const active = spawnPiece(drawn.nextKind);

    if (!isValid(runtime.board, active)) {
      return { ...runtime, gameOver: true, reason: "Board overflow" };
    }

    return {
      ...runtime,
      hold: banking,
      queue: drawn.queue,
      rngState: drawn.rngState,
      active,
      holdUsed: true,
    };
  }

  const swapped = spawnPiece(runtime.hold);
  if (!isValid(runtime.board, swapped)) {
    return { ...runtime, gameOver: true, reason: "Board overflow" };
  }

  return { ...runtime, hold: banking, active: swapped, holdUsed: true };
};

/**
 * The simulation, as one pure step — the same order as `engine.ts`, and the
 * order is protocol rather than style: player moves, then gravity, then the
 * lock gravity may have triggered. A hard drop short-circuits because it is a
 * commit, not a nudge.
 */
const tick = (prev, dtMs, inputByte) => {
  if (prev.gameOver) return prev;

  let working = prev;

  if (inputByte & INPUT_HARD_DROP) {
    return hardDrop(working);
  }

  if (inputByte & INPUT_ROTATE_CW) {
    working = rotatePiece(working, 1);
  } else if (inputByte & INPUT_ROTATE_CCW) {
    working = rotatePiece(working, -1);
  }

  if (inputByte & INPUT_HOLD) {
    working = holdPiece(working);
    if (working.gameOver) return working;
  }

  if (inputByte & INPUT_LEFT) {
    const moved = movePiece(working, -1, 0);
    if (moved) working = moved;
  }
  if (inputByte & INPUT_RIGHT) {
    const moved = movePiece(working, 1, 0);
    if (moved) working = moved;
  }

  const softDropping = (inputByte & INPUT_SOFT_DROP) !== 0;
  if (softDropping) {
    const moved = movePiece(working, 0, 1);
    if (moved) working = { ...moved, score: moved.score + 1 };
  }

  const baseDropInterval = getGuidelineFallIntervalMs(working.level);
  const dropInterval = softDropping
    ? baseDropInterval / SOFT_DROP_MULTIPLIER
    : baseDropInterval;

  working = {
    ...working,
    dropAccumulatorMs: working.dropAccumulatorMs + dtMs,
  };

  while (working.dropAccumulatorMs >= dropInterval) {
    working = {
      ...working,
      dropAccumulatorMs: working.dropAccumulatorMs - dropInterval,
    };

    const moved = movePiece(working, 0, 1);
    working = moved || withLockedPiece(working);
    if (working.gameOver) break;
  }

  return working;
};

const createRuntime = (difficulty, seed) => {
  const rngState = seed >>> 0;
  const drawn = popNextPiece([], rngState);

  return {
    board: createBoard(),
    active: spawnPiece(drawn.nextKind),
    queue: drawn.queue,
    hold: null,
    holdUsed: false,
    level: difficulty.startLevel,
    score: 0,
    linesCleared: 0,
    dropAccumulatorMs: 0,
    gameOver: false,
    won: false,
    difficulty,
    rngState: drawn.rngState,
  };
};

// ── The five exports the worker's `TICK_ENGINES` table uses ───────────────────

/**
 * Validate the claim's shape and bind it to a difficulty the worker derives.
 *
 * Every rejection here is a `ReplayInputError`, which `runReplayVerification`
 * turns into a `matched: null` verdict rather than a mismatch — a malformed
 * submission is not evidence of cheating, it is evidence of a client and a
 * worker disagreeing about the protocol, and counting those as mismatches
 * would drown the signal.
 */
function validateTetrisReplay(replay) {
  if (!replay || typeof replay !== "object") {
    throw new ReplayInputError("Replay missing or not an object.");
  }

  if (typeof replay.difficulty !== "string") {
    throw new ReplayInputError("Replay has no difficulty name.");
  }

  const { difficulty } = difficultyForClaim(replay.difficulty);

  if (typeof replay.ticks !== "number" || !Number.isInteger(replay.ticks)) {
    throw new ReplayInputError("Replay tick count is not an integer.");
  }
  if (replay.ticks <= 0) {
    throw new ReplayInputError("Replay is empty.");
  }
  if (replay.ticks > MAX_REPLAY_TICKS) {
    throw new ReplayInputError(
      `Replay is longer than ${MAX_REPLAY_TICKS} ticks.`,
    );
  }

  if (typeof replay.inputs !== "string") {
    throw new ReplayInputError("Replay has no input log.");
  }

  let inputs;
  try {
    inputs = decodeInputLog(replay.inputs);
  } catch {
    throw new ReplayInputError("Input log is not decodable.");
  }

  if (inputs.length !== replay.ticks) {
    throw new ReplayInputError(
      `Input log holds ${inputs.length} bytes but claims ${replay.ticks} ticks.`,
    );
  }

  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i] & ~INPUT_MASK) {
      throw new ReplayInputError(
        `Input byte ${i} sets a bit no player key produces.`,
      );
    }
  }

  return { difficulty, inputs };
}

/** A replay begun from tick zero — a claim with no park to resume. */
function startTetrisReplay(validated) {
  const state = createRuntime(validated.difficulty, daySeedOf(Date.now()));
  return {
    match: state,
    inputs: validated.inputs,
    cursor: 0,
    total: validated.inputs.length,
  };
}

/**
 * Reject any byte that is not a combination of the seven key bits.
 *
 * Called on the first window and again on every step, because a parked log is
 * re-decoded from D1 on each continuation: an unknown byte mid-run throws rather
 * than silently stepping as "no input", which would re-simulate a *different*
 * run and blame the player for the divergence.
 */
function assertInputBytes(inputs, what) {
  for (let i = 0; i < inputs.length; i++) {
    if (inputs[i] & ~INPUT_MASK) {
      throw new ReplayInputError(
        `${what} byte ${i} sets a bit no player key produces.`,
      );
    }
  }
}

/**
 * Open a park on the first window.
 *
 * The bag seed comes from the *day the difficulty belongs to*, not from now —
 * a first chunk for yesterday's difficulty must deal yesterday's bag, or a run
 * that started before midnight would be checked against today's pieces.
 *
 * `inputs instanceof Uint8Array`, not `Array.isArray`: the chunk arrives from
 * `decodeInputLog`, which returns a typed array, and `Array.isArray` answers
 * `false` for one. That check would refuse every real window — and a refusal
 * here is silent, because the client sees only a broken stream and retries.
 */
function openTetrisChunkReplay({ difficulty, inputs }) {
  if (typeof difficulty !== "string") {
    throw new ReplayInputError("First chunk carries no difficulty.");
  }
  if (!(inputs instanceof Uint8Array) || inputs.length === 0) {
    throw new ReplayInputError("First chunk carries no inputs.");
  }
  if (inputs.length > CHUNK_TICKS) {
    throw new ReplayInputError(
      `A window may not exceed ${CHUNK_TICKS} ticks.`,
    );
  }
  assertInputBytes(inputs, "The first chunk's");

  const resolved = difficultyForClaim(difficulty);
  const state = createRuntime(
    resolved.difficulty,
    daySeedOf(resolved.now),
  );

  return {
    match: state,
    inputs,
    cursor: 0,
    total: inputs.length,
  };
}

/**
 * Step the park forward by at most `maxTicks`, **mutating `state`**.
 *
 * Mutation is the contract, not a style choice. The park plumbing shared by
 * every streamed cabinet — `runReplayVerification`, `intentVerifyChunk`,
 * `intentContinueVerification` — calls `engine.step(state, CHUNK_TICKS)` and
 * ignores what comes back, because the brawler's engine advances the state in
 * place. An engine that returns a *new* park and leaves its argument alone is
 * therefore stepped from zero on every request: the cursor never moves, every
 * claim ends in "replay in progress", and nothing is ever verified. The same
 * shape as `stepPacmanReplay`.
 *
 * Bounded rather than "step everything", because a Tetris run to the 35,000
 * target is tens of thousands of steps and Workers Free allows 10 ms of CPU per
 * request: stepping the whole log in one call would exceed the budget and the
 * run would never verify.
 *
 * @returns the number of steps this call consumed.
 */
function stepTetrisReplay(state, maxTicks = CHUNK_TICKS) {
  if (state.cursor >= state.inputs.length) return 0;
  if (state.match.gameOver) return 0;

  // Re-checked on every step, not only when the log was accepted: the park is
  // re-decoded from D1 on each continuation.
  assertInputBytes(state.inputs, "The parked log's");

  const start = state.cursor;
  const end = Math.min(start + maxTicks, state.inputs.length);
  let working = state.match;

  for (let i = start; i < end; i++) {
    working = tick(working, FIXED_STEP_MS, state.inputs[i]);
    if (working.gameOver) break;
  }

  state.match = working;
  // A run that ended mid-window still *consumed* the window — the park has to
  // account for every byte it was sent, or the cursor would stall on the same
  // position forever and the next window's bytes would be re-stepped.
  state.cursor = end;

  return end - start;
}

/**
 * The final outcome, read from the worker's own simulation.
 *
 * `reachedFinale` is the win flag on its own, deliberately *not* combined with
 * "the log ended here". A run that topped out stops consuming steps, so a log
 * with steps past the end is legal and normal — the client stops logging when
 * the run settles, but the park may have been fed a whole final window before
 * the freeze reached it, and those bytes are part of the proof.
 */
function tetrisOutcome(state) {
  return {
    score: state.match.score,
    linesCleared: state.match.linesCleared,
    level: state.match.level,
    reachedFinale: state.match.gameOver === true && state.match.won === true,
  };
}

export {
  validateTetrisReplay,
  startTetrisReplay,
  openTetrisChunkReplay,
  stepTetrisReplay,
  tetrisOutcome,
  resolveTetrisDifficulty,
  daySeedOf,
};