import { TetrisDifficulty } from "./session";

export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 20;
export const FIXED_STEP_MS = 16;
export const MAX_LEVEL = 12;
export const LINES_PER_LEVEL = 10;
export const SOFT_DROP_MULTIPLIER = 5;

export type TetrominoKind = "I" | "O" | "T" | "S" | "Z" | "J" | "L";
export type Cell = TetrominoKind | null;
export type Board = Cell[][];
export type Position = { x: number; y: number };
export type Piece = { kind: TetrominoKind; rotation: number; x: number; y: number };

export type TetrisRuntime = {
  board: Board;
  active: Piece;
  queue: TetrominoKind[];
  hold: TetrominoKind | null;
  holdUsed: boolean;
  level: number;
  score: number;
  linesCleared: number;
  dropAccumulatorMs: number;
  gameOver: boolean;
  won: boolean;
  reason?: string;
  /**
   * The daily difficulty this run was opened under, baked in at run-open.
   *
   * It rides *on* the runtime rather than being re-derived from the date at
   * step time because the park round-trips through D1 as JSON between chunk
   * requests: a resumed replay's steps must use the difficulty the park was
   * opened with, even if the UTC date rolled over in between. A run that
   * straddles midnight is still verified against the difficulty it started on.
   */
  difficulty: TetrisDifficulty;
  /**
   * The LCG state for the piece bag, advanced by every shuffle.
   *
   * Carried on the runtime for the same reason as `difficulty`, and because a
   * reseeded-per-step generator would deal the same bag every step — the piece
   * sequence is as much a part of the proof as the inputs are.
   */
  rngState: number;
};

/**
 * Input byte, one per tick: a bitfield of what the player was doing.
 *
 * Every bit here is a *press* sampled on exactly one tick, except
 * `INPUT_SOFT_DROP`, which the player keeps set for as long as they hold it —
 * it accelerates the fall rather than nudging the piece, so its duration is the
 * intent. The rest are consumed by the step they landed on and never persist,
 * because "a rotation happened" with no tick attached would be a claim about
 * *when*, and checking the claim is the whole job.
 *
 * `INPUT_LEFT` and `INPUT_RIGHT` are presses and not held states on purpose: one
 * keydown moves the piece one cell, and a key held down slides only because the
 * player (or the OS, on auto-repeat) presses it again. Recorded as held, the
 * step function would slide one cell per step for the duration of the tap, and
 * a press would travel several columns instead of one.
 */
export const INPUT_LEFT = 1 << 0;
export const INPUT_RIGHT = 1 << 1;
export const INPUT_SOFT_DROP = 1 << 2;
export const INPUT_ROTATE_CW = 1 << 3;
export const INPUT_ROTATE_CCW = 1 << 4;
export const INPUT_HOLD = 1 << 5;
export const INPUT_HARD_DROP = 1 << 6;

/** Every bit a client may set. Anything above this is a forged or corrupt log. */
export const INPUT_MASK =
  INPUT_LEFT |
  INPUT_RIGHT |
  INPUT_SOFT_DROP |
  INPUT_ROTATE_CW |
  INPUT_ROTATE_CCW |
  INPUT_HOLD |
  INPUT_HARD_DROP;

const PIECE_ORDER: TetrominoKind[] = ["I", "O", "T", "S", "Z", "J", "L"];

export const SHAPES: Record<TetrominoKind, Position[][]> = {
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
 * One step of the bag generator, returning the draw and the next state.
 *
 * Written as an explicit state-in/state-out step rather than a closure over a
 * mutable variable, because the state has to live on the runtime: the park
 * round-trips it through D1 as JSON between chunks, and a generator that
 * closed over its own variable would restart from the seed every time the
 * replay was resumed. The constants are the Numerical Recipes LCG — the same
 * choice as the other cabinets, so one stream means the same thing everywhere.
 */
const nextRandom = (state: number): { value: number; state: number } => {
  const next = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
  return { value: next / 4_294_967_296, state: next };
};

/** Fisher-Yates over the seven kinds, threading the generator state through. */
const shuffledBag = (rngState: number): { bag: TetrominoKind[]; rngState: number } => {
  const bag = [...PIECE_ORDER];
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

const ensureQueue = (
  queue: TetrominoKind[],
  rngState: number,
): { queue: TetrominoKind[]; rngState: number } => {
  if (queue.length >= QUEUE_TARGET) return { queue, rngState };
  const drawn = shuffledBag(rngState);
  return { queue: [...queue, ...drawn.bag], rngState: drawn.rngState };
};

const popNextPiece = (
  queue: TetrominoKind[],
  rngState: number,
): { nextKind: TetrominoKind; queue: TetrominoKind[]; rngState: number } => {
  const prepared = ensureQueue(queue, rngState);
  const nextKind = prepared.queue[0];
  const remaining = prepared.queue.slice(1);
  const topped = ensureQueue(remaining, prepared.rngState);
  return { nextKind, queue: topped.queue, rngState: topped.rngState };
};

const createBoard = (): Board =>
  Array.from({ length: BOARD_HEIGHT }, () =>
    Array<Cell>(BOARD_WIDTH).fill(null),
  );

const spawnPiece = (kind: TetrominoKind): Piece => ({
  kind,
  rotation: 0,
  x: 3,
  y: 0,
});

export const getCells = (piece: Piece) =>
  SHAPES[piece.kind][piece.rotation].map((c) => ({
    x: piece.x + c.x,
    y: piece.y + c.y,
  }));

const isValid = (board: Board, piece: Piece) =>
  getCells(piece).every((cell) => {
    if (cell.x < 0 || cell.x >= BOARD_WIDTH) return false;
    if (cell.y < 0 || cell.y >= BOARD_HEIGHT) return false;
    return board[cell.y][cell.x] === null;
  });

const mergePiece = (board: Board, piece: Piece): Board => {
  const next = board.map((row) => [...row]);

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

const clearLines = (board: Board) => {
  const remaining = board.filter((row) => row.some((cell) => cell === null));
  const cleared = BOARD_HEIGHT - remaining.length;
  const padding = Array.from({ length: cleared }, () =>
    Array<Cell>(BOARD_WIDTH).fill(null),
  );

  return { board: [...padding, ...remaining], cleared };
};

const scoreForLines = (lines: number, level: number) => {
  if (lines <= 0) return 0;
  const base = lines === 1 ? 100 : lines === 2 ? 300 : lines === 3 ? 500 : 800;
  return base * level;
};

const getGuidelineFallIntervalMs = (level: number): number => {
  const capped = Math.min(level, MAX_LEVEL);
  return Math.pow(0.8 - (capped - 1) * 0.007, capped - 1) * 1000;
};

/**
 * Land the active piece: merge it, clear any lines, score them, and deal the
 * next one.
 *
 * The win check lives *here* rather than in the caller so the step that reaches
 * the target is the step that ends the run — the claim's score and the run's
 * final state are then read from one state of the game rather than from a
 * frame later, which is what makes "the score the worker computes" and "the
 * score the player saw" the same number.
 */
const withLockedPiece = (runtime: TetrisRuntime): TetrisRuntime => {
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

const movePiece = (runtime: TetrisRuntime, dx: number, dy: number) => {
  const moved: Piece = {
    ...runtime.active,
    x: runtime.active.x + dx,
    y: runtime.active.y + dy,
  };

  if (!isValid(runtime.board, moved)) return null;

  return { ...runtime, active: moved };
};

/**
 * Rotate with the five-point kick the original cabinet used: no kick at all,
 * then one left, one right, two left, two right.
 *
 * Deliberately not the modern SRS table — the kicks are part of the run's
 * shape, and a replay that rotated differently would diverge on a piece the
 * player had every right to spin.
 */
const rotatePiece = (
  runtime: TetrisRuntime,
  direction: 1 | -1,
): TetrisRuntime => {
  const rotated: Piece = {
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

const hardDrop = (runtime: TetrisRuntime): TetrisRuntime => {
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

/**
 * Bank the active piece and deal the queue's head, or swap with the hold.
 *
 * The overflow checks return a run-over state rather than refusing the swap:
 * the original cabinet ended the run when a swap could not be placed, and a
 * replay that refused instead would let a player who had already topped out
 * keep playing.
 */
const holdPiece = (runtime: TetrisRuntime): TetrisRuntime => {
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

  return {
    ...runtime,
    hold: banking,
    active: swapped,
    holdUsed: true,
  };
};

/**
 * A fresh run, opened under a given difficulty and bag seed.
 *
 * Both parameters are baked onto the runtime rather than passed per step,
 * because the park round-trips through D1 between chunk requests: a resumed
 * replay has to continue the *same* game, so everything that makes a game this
 * game rather than another game in the same difficulty has to survive the JSON
 * round trip on the state itself.
 */
export const createRuntime = (
  difficulty: TetrisDifficulty,
  seed: number,
): TetrisRuntime => {
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

/**
 * The simulation, as one pure step. Both ends run this and only this.
 *
 * The order within a tick is part of the protocol, not an implementation
 * detail: the player's moves are applied first, then gravity, then the lock
 * that gravity may have triggered. A replay that applied them in another order
 * would answer "what happened" differently on the inputs where a move and a
 * lock land on the same tick, which for a hard drop is *every* tick.
 *
 * Hard drop short-circuits because it is not a nudge — it is "put the piece
 * down now", and the tick it lands on is also the tick the next piece is dealt.
 * Applying the other moves first would let a held arrow key slide a piece that
 * the player had already committed to dropping.
 */
export const tick = (
  prev: TetrisRuntime,
  dtMs: number,
  inputByte: number,
): TetrisRuntime => {
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

  // Soft drop both accelerates the fall and pays a point for the cell it
  // bought, which is why it is scored here rather than in the gravity loop:
  // the loop can also spend the accumulator on rows the player never
  // triggered, and those must not pay.
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
    working = moved ?? withLockedPiece(working);
    if (working.gameOver) break;
  }

  return working;
};

/** Bytes → base64, through JSON-safe characters. The wire form of a run's log. */
export const encodeInputLog = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

/** The inverse. Throws on anything that is not base64, as the worker's must. */
export const decodeInputLog = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};