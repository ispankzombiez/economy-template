/**
 * Frogger's simulation: the bumpkin, the goblins, the logs, and the step that
 * moves all three.
 *
 * ## Why this file exists (and used to be inline in `FroggerGame.tsx`)
 *
 * Frogger is a tick-simulated cabinet — its score falls out of re-running the
 * exact per-step inputs, which is the only proof of a run worth paying for (see
 * the headers of `worker/src/replay.js` and `worker/src/froggerReplay.js` for
 * the argument). A proof the *server* re-runs needs the server's copy of the
 * rules to be the same copy the client played with: two implementations of one
 * ruleset will disagree, and a cheater plays whichever one is more lenient. So
 * the step function lives here, imported by both ends, rather than being
 * written once in the component and once in the worker — Pac-Man's and Barley
 * Breaker's `engine.ts` are the precedents.
 *
 * ## What makes a run replayable: an issued seed, a fixed step, and exact ops
 *
 * Unlike Pac-Man's and Barley Breaker's engines, this one has genuine runtime
 * RNG — it is the heaviest of the seeded cabinets:
 *
 *  - every time a goblin wraps back in from off-screen it re-rolls its *elite*
 *    status and its elite speed boost (two rolls, continuously, all run);
 *  - every time a fragile log respawns it re-rolls whether it is fragile;
 *  - every time the player steps onto a fresh fragile log its sink timer is
 *    rolled (1–2 seconds).
 *
 * plus the opening layouts (`buildGoblins`/`buildLogs`), which roll per-lane
 * density boosts, position jitter, per-entity speed variance and fragility.
 * That is precisely the shape that must be *issued* rather than chosen: a seed
 * the client picked is a layout the client could shop for. The run's seed
 * comes from `active_runs.seed` at run-open (`run-seed`), the worker reads the
 * same column at chunk-0 and at the claim, and nothing else feeds the RNG. See
 * `advanceRng` for the generator itself — a mulberry32 stream, integer ops
 * only, bit-identical on every engine.
 *
 * The stricter half of the guarantee is *which arithmetic* the step uses. IEEE
 * 754 pins `+ - * /`, `sqrt` and the integer ops to bit-for-bit results on
 * every engine, but it does **not** pin the transcendentals: `Math.sin`,
 * `cos`, `atan2`, `hypot` and `pow` may differ in the last ulp between the
 * browser a run was played on and the workerd isolate that replays it. One ulp
 * is invisible live, but a crossing where every tick's carry and collision
 * compounds is chaos — minutes of movement amplify it into a different death
 * at a different moment and a different score, and the honest player who
 * submitted that score is refused. The original inline step's only
 * transcendental was the diagonal-normalisation `Math.sqrt(dx * dx + dy * dy)`
 * — `sqrt` is exact-IEEE, so it stays — and everything else here is `+ - * /`
 * and integer ops.
 *
 * The harness (`scripts/froggerReplayTest.mjs`) scans this file's source and
 * fails the moment any of that regresses: no `Math.random`, no clock, and no
 * transcendental.
 *
 * ## Why the difficulty rides on the runtime
 *
 * The same reason as Pac-Man's and Barley Breaker's: the replay parks its match
 * in D1 between chunks, possibly across UTC midnight, and the win check inside
 * `tick` must use the target the run was *played* under. `createRuntime` bakes
 * it in; the worker validates the claimed difficulty *name* (today's or
 * yesterday's) before building the runtime, so "always claim easy" buys
 * nothing.
 *
 * ## The input byte: one per 16 ms step
 *
 * Frogger's input is the *held key set*, polled every step — up to four keys
 * at once, because the diagonal normalisation means a held Down still changes
 * the step even though downward travel is clamped away afterwards (Down+Right
 * moves right at full speed, not at 0.707 of it). So the byte is the four
 * keys as a bitmask:
 *
 *  - bit 0 — Left (ArrowLeft / KeyA)
 *  - bit 1 — Right (ArrowRight / KeyD)
 *  - bit 2 — Up (ArrowUp / KeyW)
 *  - bit 3 — Down (ArrowDown / KeyS)
 *
 * Values `0..15` are all producible; anything above 15 is refused by
 * `decodeTick` as protocol garbage.
 *
 * ## Step rate
 *
 * `FIXED_STEP_MS = 16` — the closest whole millisecond to the ~16.7 ms frame
 * the old variable-`dt` loop ran at on a 60 Hz display, so the game plays at
 * its old pace, and unlike the old loop it now plays at *the same* pace on 60,
 * 120 or 144 Hz hardware. At 62.5 steps/second a run fits comfortably inside
 * the shared `MAX_REPLAY_TICKS` ceiling (64,000 ≈ 17 minutes of continuous
 * play).
 */

import { FroggerDifficulty } from "./session";

// ─────────────────────────────────────────────────────────────────────────────
// World layout (also imported by the component for drawing — one constant,
// one meaning)
// ─────────────────────────────────────────────────────────────────────────────
export const COLS = 14;
export const CELL = 54; // px per tile
export const PLAYER_SIZE = 42; // collision box (kept as-is; gameplay is tuned to it)
export const VIEWPORT_ROWS = 11; // rows visible at once
export const WORLD_ROWS = 30; // total world rows (row 0 = home, row 29 = start)

export const ARENA_W = COLS * CELL; // 756 px
export const ARENA_H = VIEWPORT_ROWS * CELL; // 594 px

/**
 * The step the simulation advances by, in milliseconds — shared by the
 * component's frame loop and the worker's replay driver.
 */
export const FIXED_STEP_MS = 16;

// Player movement speed (pixels per second) — feels like "regular area"
const PLAYER_SPEED = 130;
const DIFFICULTY_SCORE_STEP = 1200;
const FRAGILE_LOG_BASE_CHANCE = 0.3;
const FRAGILE_LOG_RESPAWN_MS = 2300;
const ELITE_GOBLIN_BASE_CHANCE = 0.05;

// Scoring
const POINTS_PER_ROW = 10; // per newly-crossed row
const CHECKPOINT_BONUS = 100; // reaching row 17 (mid-safe) for first time per phase
const HOME_BONUS = 500; // reaching row 0 during each loop band
const DEATH_PAUSE_MS = 1800;

// Row type lookup — row 0 = top (home), row 29 = bottom (start)
export type RowType = "home" | "safe" | "road" | "river" | "checkpoint";
const ROW_TYPES: RowType[] = [
  "home", // 0
  "road",
  "road",
  "road",
  "road", // 1-4  (upper hard road)
  "safe", // 5
  "river",
  "river",
  "river",
  "river",
  "river", // 6-10
  "safe", // 11
  "road",
  "road",
  "road",
  "road",
  "road", // 12-16
  "checkpoint", // 17  (mid safe — bonus checkpoint)
  "river",
  "river",
  "river",
  "river",
  "river", // 18-22
  "safe", // 23
  "road",
  "road",
  "road",
  "road",
  "road", // 24-28
  "safe", // 29 (start)
];

export const HOME_ROW = 0;
export const START_ROW = 29;
const CHECKPOINT_ROW = 17;

// ─────────────────────────────────────────────────────────────────────────────
// Entity types
// ─────────────────────────────────────────────────────────────────────────────
export type GoblinEntity = {
  id: number;
  worldRow: number;
  x: number; // pixel left edge, can be negative/> ARENA_W (wrap handled at render)
  width: number;
  dir: 1 | -1;
  speed: number; // effective px/s (includes elite boost)
  baseSpeed: number; // px/s without elite boost, used to re-roll on wrap
  kind: "normal" | "elite";
};

export type LogEntity = {
  id: number;
  worldRow: number;
  x: number;
  width: number;
  dir: 1 | -1;
  speed: number; // base px/s
  kind: "stable" | "fragile";
  sinkAtMs?: number;
  respawnAtMs?: number;
};

export type FroggerRuntime = {
  /** Baked at run-open so a park resumed days later still plays to its target. */
  difficulty: FroggerDifficulty;
  /** The seed this run's layouts and rolls derive from — issued, never chosen. */
  seed: number;
  /** The RNG stream's position — advanced by `advanceRng`, never a clock. */
  rngState: number;

  // player center in world-pixel coordinates
  playerCX: number;
  /** Which way the player's bumpkin portrait faces, so it can turn. */
  playerFacing: "left" | "right";
  playerCY: number;

  goblins: GoblinEntity[];
  logs: LogEntity[];

  cameraY: number; // top of viewport in world pixels

  score: number;
  lives: number;
  loopLevel: number;
  elapsedMs: number;

  highestProgressVirtualRow: number;
  checkpointLoopToken: number;
  homeLoopToken: number;

  gameOver: boolean;
  won: boolean;
  deathPauseMs: number;
  reason?: string;
};

/**
 * What one step consumes. The component samples this from its key refs,
 * encodes it into the log, and feeds it to `tick`; the worker decodes the
 * log's byte and feeds the same object to the same `tick`.
 */
export type TickInput = {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
};

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

export const mod = (value: number, size: number) =>
  ((value % size) + size) % size;

export const getRowType = (virtualRow: number): RowType =>
  ROW_TYPES[mod(virtualRow, WORLD_ROWS)];

const isRoad = (virtualRow: number) => getRowType(virtualRow) === "road";
const isRiver = (virtualRow: number) => getRowType(virtualRow) === "river";

const getWrapSpan = (width: number) => ARENA_W + width * 2;

const wrapX = (x: number, width: number) => {
  const span = getWrapSpan(width);
  return mod(x + width, span) - width;
};

export const getWrappedCopies = (x: number, width: number): number[] => {
  const span = getWrapSpan(width);
  const copies = [x];
  if (x < 0) copies.push(x + span);
  if (x + width > ARENA_W) copies.push(x - span);
  return copies;
};

const isPointOnWrappedEntity = (pointX: number, x: number, width: number) =>
  getWrappedCopies(x, width).some(
    (copyX) => pointX >= copyX && pointX <= copyX + width,
  );

export const isLogSunk = (log: LogEntity, nowMs: number) =>
  log.respawnAtMs !== undefined && nowMs < log.respawnAtMs;

const getLoopBand = (virtualRow: number) =>
  Math.floor((HOME_ROW - virtualRow) / WORLD_ROWS);

const getEliteGoblinChance = (score: number, loopLevel: number): number => {
  const pressureSteps = Math.floor(score / DIFFICULTY_SCORE_STEP);
  const scoreBoost = pressureSteps * 0.04;
  const loopBoost = loopLevel * 0.03;
  return clamp(ELITE_GOBLIN_BASE_CHANCE + scoreBoost + loopBoost, 0, 0.4);
};

const getFragileChance = (
  difficulty: FroggerDifficulty,
  loopLevel: number,
  score: number,
) => {
  const difficultyBoost =
    difficulty.name === "hard"
      ? 0.18
      : difficulty.name === "medium"
        ? 0.1
        : 0.04;
  const loopBoost = Math.min(0.2, loopLevel * 0.02);
  const scoreBoost = Math.min(
    0.22,
    Math.floor(score / DIFFICULTY_SCORE_STEP) * 0.02,
  );
  return clamp(
    FRAGILE_LOG_BASE_CHANCE + difficultyBoost + loopBoost + scoreBoost,
    0.18,
    0.72,
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// The RNG stream
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One step of the run's RNG stream: a mulberry32 advance.
 *
 * Integer ops throughout (imul, xor, shift, or, + — all pinned bit-for-bit by
 * IEEE 754 / ECMAScript on every engine), with the single `/ 2^32` that turns
 * the mixed word into `[0, 1)`. The state travels on the runtime like
 * `nextId` does in Barley Breaker's engine, so a JSON park round trip resumes
 * the stream exactly where the client left it.
 *
 * The original inline code rolled `Math.random()` at each of the call sites
 * documented in the header; same call sites, same `[0, 1)` range, same
 * distribution class — an engine-independent stream instead of a
 * library-dependent one.
 */
const advanceRng = (
  state: number,
): { value: number; state: number } => {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = Math.imul(next ^ (next >>> 15), next | 1);
  t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) | 0)) | 0;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: next };
};

// ─────────────────────────────────────────────────────────────────────────────
// Entity builders
// ─────────────────────────────────────────────────────────────────────────────

type LaneCfg = {
  dir: 1 | -1;
  baseSpeed: number;
  count: number;
  width: number; // % of CELL width
};

const ROAD_CONFIGS: Record<number, LaneCfg> = {
  1: { dir: 1, baseSpeed: 110, count: 2, width: 2 },
  2: { dir: -1, baseSpeed: 140, count: 3, width: 2 },
  3: { dir: 1, baseSpeed: 120, count: 2, width: 2 },
  4: { dir: -1, baseSpeed: 150, count: 3, width: 2 },
  12: { dir: 1, baseSpeed: 85, count: 2, width: 2 },
  13: { dir: -1, baseSpeed: 105, count: 3, width: 2 },
  14: { dir: 1, baseSpeed: 90, count: 2, width: 2 },
  15: { dir: -1, baseSpeed: 115, count: 2, width: 2 },
  16: { dir: 1, baseSpeed: 80, count: 2, width: 2 },
  24: { dir: 1, baseSpeed: 65, count: 2, width: 2 },
  25: { dir: -1, baseSpeed: 80, count: 2, width: 2 },
  26: { dir: 1, baseSpeed: 70, count: 2, width: 2 },
  27: { dir: -1, baseSpeed: 85, count: 3, width: 2 },
  28: { dir: 1, baseSpeed: 60, count: 2, width: 2 },
};

type RiverCfg = {
  dir: 1 | -1;
  baseSpeed: number;
  count: number;
  logCells: number; // log width in cells
};

const RIVER_CONFIGS: Record<number, RiverCfg> = {
  6: { dir: 1, baseSpeed: 42, count: 3, logCells: 3 },
  7: { dir: -1, baseSpeed: 52, count: 2, logCells: 4 },
  8: { dir: 1, baseSpeed: 38, count: 3, logCells: 3 },
  9: { dir: -1, baseSpeed: 58, count: 2, logCells: 4 },
  10: { dir: 1, baseSpeed: 46, count: 3, logCells: 3 },
  18: { dir: 1, baseSpeed: 34, count: 3, logCells: 3 },
  19: { dir: -1, baseSpeed: 44, count: 2, logCells: 4 },
  20: { dir: 1, baseSpeed: 30, count: 3, logCells: 3 },
  21: { dir: -1, baseSpeed: 48, count: 2, logCells: 4 },
  22: { dir: 1, baseSpeed: 36, count: 3, logCells: 3 },
};

/**
 * Build the road hazards. `roll` is the run's RNG stream — the original read
 * `Math.random()` here, and every one of those rolls (per-lane density boost,
 * per-goblin jitter, speed variance, elite status, elite boost) now comes from
 * the issued seed's stream instead.
 */
const buildGoblins = (
  difficulty: FroggerDifficulty,
  loopLevel: number,
  score: number,
  roll: () => number,
): GoblinEntity[] => {
  const pressureSteps = Math.floor(score / DIFFICULTY_SCORE_STEP);
  const speedMult =
    difficulty.laneSpeedMultiplier *
    (1 + loopLevel * 0.08 + pressureSteps * 0.03);
  const densityMult =
    difficulty.hazardDensity + loopLevel * 0.03 + pressureSteps * 0.015;
  const eliteChance = getEliteGoblinChance(score, loopLevel);
  const entities: GoblinEntity[] = [];
  let id = 0;

  Object.entries(ROAD_CONFIGS).forEach(([rowStr, cfg]) => {
    const row = Number(rowStr);
    const laneRandomBoost = roll() < 0.55 ? 1 : 0;
    const count = Math.max(
      2,
      Math.round(cfg.count * densityMult) + laneRandomBoost,
    );
    const goblinW = cfg.width * CELL;
    const spacing = getWrapSpan(goblinW) / count;

    for (let i = 0; i < count; i++) {
      const offsetJitter = (roll() - 0.5) * spacing * 0.55;
      const speedVariance = 0.85 + roll() * 0.4;
      const isElite = roll() < eliteChance;
      const eliteSpeedBoost = isElite ? 1.5 + roll() * 0.5 : 1; // 1.5–2.0× (50–100% faster)
      const goblinBaseSpeed = cfg.baseSpeed * speedMult * speedVariance;
      entities.push({
        id: id++,
        worldRow: row,
        x: wrapX(
          i * spacing + offsetJitter + (cfg.dir === -1 ? ARENA_W * 0.35 : 0),
          goblinW,
        ),
        width: goblinW,
        dir: cfg.dir,
        baseSpeed: goblinBaseSpeed,
        speed: goblinBaseSpeed * eliteSpeedBoost,
        kind: isElite ? "elite" : "normal",
      });
    }
  });

  return entities;
};

/** Build the river logs — same bargain as `buildGoblins`, rolls and all. */
const buildLogs = (
  difficulty: FroggerDifficulty,
  loopLevel: number,
  score: number,
  roll: () => number,
): LogEntity[] => {
  const pressureSteps = Math.floor(score / DIFFICULTY_SCORE_STEP);
  const speedMult =
    difficulty.laneSpeedMultiplier *
    (1 + loopLevel * 0.06 + pressureSteps * 0.025);
  const fragileChance = getFragileChance(difficulty, loopLevel, score);
  const entities: LogEntity[] = [];
  let id = 2000;

  Object.entries(RIVER_CONFIGS).forEach(([rowStr, cfg]) => {
    const row = Number(rowStr);
    const logW = cfg.logCells * CELL;
    const spacing = getWrapSpan(logW) / cfg.count;

    for (let i = 0; i < cfg.count; i++) {
      const isFragile = roll() < fragileChance;
      entities.push({
        id: id++,
        worldRow: row,
        x: wrapX(
          i * spacing +
            (roll() - 0.5) * spacing * 0.35 +
            (cfg.dir === -1 ? ARENA_W * 0.28 : 0),
          logW,
        ),
        width: logW,
        dir: cfg.dir,
        speed: cfg.baseSpeed * speedMult,
        kind: isFragile ? "fragile" : "stable",
      });
    }
  });

  return entities;
};

const startPlayerCY = () => (HOME_ROW + 0.5) * CELL;
const startPlayerCX = () => (COLS / 2) * CELL;

const startCameraY = (playerCY: number) => playerCY - (ARENA_H - CELL * 0.5);

/**
 * Build a fresh run at `difficulty`, dealing its layouts from `seed`.
 *
 * The same call the component makes at run-open and the worker's replay makes
 * at claim: the difficulty is copied onto the runtime, the seed both ends read
 * from `active_runs` seeds one shared stream, and every id the run will ever
 * mint comes from fixed counters rather than `Date.now() + Math.random()` — so
 * two ends that never see each other's clocks still produce the same goblins
 * and the same logs.
 */
export const createRuntime = (
  difficulty: FroggerDifficulty,
  seed: number,
): FroggerRuntime => {
  let rngState = seed >>> 0;
  const roll = () => {
    const next = advanceRng(rngState);
    rngState = next.state;
    return next.value;
  };

  const cx = startPlayerCX();
  const cy = startPlayerCY();
  const startVirtualRow = Math.floor(cy / CELL);
  return {
    difficulty,
    seed: seed >>> 0,
    rngState,
    playerCX: cx,
    playerFacing: "right",
    playerCY: cy,
    goblins: buildGoblins(difficulty, 0, 0, roll),
    logs: buildLogs(difficulty, 0, 0, roll),
    cameraY: startCameraY(cy),
    score: 0,
    lives: difficulty.startingLives,
    loopLevel: 0,
    elapsedMs: 0,
    highestProgressVirtualRow: startVirtualRow,
    checkpointLoopToken: -1,
    homeLoopToken: 0,
    gameOver: false,
    won: false,
    deathPauseMs: 0,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// The input byte
// ─────────────────────────────────────────────────────────────────────────────
const LEFT_BIT = 0x01;
const RIGHT_BIT = 0x02;
const UP_BIT = 0x04;
const DOWN_BIT = 0x08;
/** A keyboard byte at most this wide is the largest four-key mask can make. */
const KEYBOARD_MAX = LEFT_BIT | RIGHT_BIT | UP_BIT | DOWN_BIT; // 15

/**
 * Pack one step's input into its log byte. See the header for the layout.
 */
export const encodeTick = (input: TickInput): number => {
  return (
    (input.left ? LEFT_BIT : 0) |
    (input.right ? RIGHT_BIT : 0) |
    (input.up ? UP_BIT : 0) |
    (input.down ? DOWN_BIT : 0)
  );
};

/**
 * Decode one log byte, or `null` for a byte the client could never have
 * written — every value `0..15` is a real held-key combination, anything above
 * sets a bit no key produces.
 *
 * This is the worker's protocol check: the validator scans the whole log
 * through it before stepping, so a byte outside the encoding is refused as
 * protocol garbage rather than replayed as some invented input.
 */
export const decodeTick = (byte: number): TickInput | null => {
  if (byte > KEYBOARD_MAX) return null;
  return {
    left: (byte & LEFT_BIT) !== 0,
    right: (byte & RIGHT_BIT) !== 0,
    up: (byte & UP_BIT) !== 0,
    down: (byte & DOWN_BIT) !== 0,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// The step
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Advance the simulation by exactly `dtMs`, consuming one step's input.
 *
 * Pure: same `(runtime, dtMs, input)` twice is the same runtime, bit for bit —
 * the property the replay rests on, and the reason a step takes its input as a
 * value rather than reading the component's refs.
 *
 * The body is the original inline `tick` transcribed in the same order, with
 * two substitutions: `activeDifficulty` (a component closure) became the
 * runtime's baked `difficulty`, and each `Math.random()` became a draw from
 * the runtime's stream — same call sites, same order, same everything else.
 */
export const tick = (
  prev: FroggerRuntime,
  dtMs: number,
  input: TickInput,
): FroggerRuntime => {
  if (prev.gameOver) return prev;

  const difficulty = prev.difficulty;
  const dt = dtMs / 1000;
  const nowMs = prev.elapsedMs + dtMs;
  const pressureSteps = Math.floor(prev.score / DIFFICULTY_SCORE_STEP);
  const pressureMult = 1 + prev.loopLevel * 0.08 + pressureSteps * 0.03;
  const fragileChance = getFragileChance(
    difficulty,
    prev.loopLevel,
    prev.score,
  );

  let rngState = prev.rngState;
  const roll = () => {
    const next = advanceRng(rngState);
    rngState = next.state;
    return next.value;
  };

  // ── Death pause ────────────────────────────────────────────────────────────
  if (prev.deathPauseMs > 0) {
    const rem = prev.deathPauseMs - dtMs;
    if (rem > 0) {
      return { ...prev, deathPauseMs: rem, elapsedMs: nowMs };
    }
    // Resume — player already reset
    return {
      ...prev,
      deathPauseMs: 0,
      cameraY: startCameraY(prev.playerCY),
      elapsedMs: nowMs,
    };
  }

  // ── Move goblins ───────────────────────────────────────────────────────────
  const eliteChanceNow = getEliteGoblinChance(prev.score, prev.loopLevel);
  const newGoblins: GoblinEntity[] = prev.goblins.map((g) => {
    const rawNext = g.x + g.dir * g.speed * pressureMult * dt;
    const nx = wrapX(rawNext, g.width);
    // Detect wrap: position jumped backward relative to travel direction
    const didWrap = g.dir === 1 ? nx < g.x : nx > g.x;
    if (didWrap) {
      // Re-roll elite status each time the goblin re-enters from off-screen
      const nowElite = roll() < eliteChanceNow;
      const eliteBoost = nowElite ? 1.5 + roll() * 0.5 : 1;
      return {
        ...g,
        x: nx,
        kind: nowElite ? "elite" : "normal",
        speed: g.baseSpeed * eliteBoost,
      };
    }
    return { ...g, x: nx };
  });

  // ── Move logs + carry player on river ──────────────────────────────────────
  let carriedDx = 0;
  const playerVirtualRow = Math.floor(prev.playerCY / CELL);
  const playerRowIndex = mod(playerVirtualRow, WORLD_ROWS);
  const sunkThisTick: Array<{
    rowIndex: number;
    x: number;
    width: number;
  }> = [];

  const newLogs: LogEntity[] = prev.logs.map((l) => {
    const nx = wrapX(
      l.x +
        l.dir *
          l.speed *
          (1 + prev.loopLevel * 0.05 + pressureSteps * 0.02) *
          dt,
      l.width,
    );
    let next: LogEntity = { ...l, x: nx };

    if (next.respawnAtMs !== undefined && nowMs >= next.respawnAtMs) {
      next = {
        ...next,
        respawnAtMs: undefined,
        kind: roll() < fragileChance ? "fragile" : "stable",
      };
    }

    const sunk = isLogSunk(next, nowMs);
    const playerOnThisRow = playerRowIndex === next.worldRow;
    const playerOnThisLog =
      !sunk &&
      playerOnThisRow &&
      isPointOnWrappedEntity(prev.playerCX, next.x, next.width);

    if (playerOnThisLog) {
      carriedDx += next.dir * next.speed * pressureMult * dt;
      if (next.kind === "fragile" && next.sinkAtMs === undefined) {
        next = {
          ...next,
          sinkAtMs: nowMs + 1000 + roll() * 1000,
        };
      }
    }

    if (next.sinkAtMs !== undefined && nowMs >= next.sinkAtMs) {
      sunkThisTick.push({
        rowIndex: next.worldRow,
        x: next.x,
        width: next.width,
      });
      next = {
        ...next,
        sinkAtMs: undefined,
        respawnAtMs: nowMs + FRAGILE_LOG_RESPAWN_MS,
      };
    }

    return next;
  });

  // ── Player movement (fluid / velocity-based) ───────────────────────────────
  let dx = 0;
  let dy = 0;
  if (input.left) dx -= 1;
  if (input.right) dx += 1;
  if (input.up) dy -= 1;
  if (input.down) dy += 1;

  // Normalize diagonal movement
  const moveLen = Math.sqrt(dx * dx + dy * dy);
  if (moveLen > 0) {
    dx /= moveLen;
    dy /= moveLen;
  }

  if (dy > 0) {
    // One-way movement: never allow moving backward down the track.
    dy = 0;
  }

  const newCX = clamp(
    prev.playerCX + dx * PLAYER_SPEED * dt + carriedDx,
    PLAYER_SIZE / 2,
    ARENA_W - PLAYER_SIZE / 2,
  );
  const newCY = prev.playerCY + dy * PLAYER_SPEED * dt;

  const newVirtualRow = Math.floor(newCY / CELL);
  const newRowIndex = mod(newVirtualRow, WORLD_ROWS);
  const newLoopBand = getLoopBand(newVirtualRow);

  // ── Score for advancing upward ─────────────────────────────────────────────
  let { score, highestProgressVirtualRow, checkpointLoopToken, homeLoopToken } =
    prev;
  const loopLevel = Math.max(prev.loopLevel, newLoopBand);

  if (newVirtualRow < highestProgressVirtualRow) {
    score += (highestProgressVirtualRow - newVirtualRow) * POINTS_PER_ROW;
    highestProgressVirtualRow = newVirtualRow;
  }

  if (newRowIndex <= CHECKPOINT_ROW && checkpointLoopToken < newLoopBand) {
    score += CHECKPOINT_BONUS;
    checkpointLoopToken = newLoopBand;
  }

  if (newRowIndex === HOME_ROW && homeLoopToken < newLoopBand) {
    score += HOME_BONUS;
    homeLoopToken = newLoopBand;
  }

  // ── Goblin collision (pixel hitbox) ────────────────────────────────────────
  const hitShrink = PLAYER_SIZE * 0.15;
  const pLeft = newCX - PLAYER_SIZE / 2 + hitShrink;
  const pRight = newCX + PLAYER_SIZE / 2 - hitShrink;
  const pTop = newCY - PLAYER_SIZE / 2 + hitShrink;
  const pBottom = newCY + PLAYER_SIZE / 2 - hitShrink;

  let killedBy: string | null = null;

  if (isRoad(newVirtualRow)) {
    for (const g of newGoblins) {
      if (g.worldRow !== newRowIndex) continue;
      const spriteH = CELL * 0.65; // goblin sprite occupies ~65% of cell height
      const goblinCenterY = (newVirtualRow + 0.5) * CELL;
      const gTop = goblinCenterY - spriteH / 2;
      const gBottom = goblinCenterY + spriteH / 2;
      const spriteW = CELL - 10;
      for (const ox of getWrappedCopies(g.x, g.width)) {
        const gLeft = ox + (g.width - spriteW) / 2 + 4;
        const gRight = gLeft + spriteW - 8;
        if (
          pRight > gLeft &&
          pLeft < gRight &&
          pBottom > gTop &&
          pTop < gBottom
        ) {
          killedBy = "Hit by a goblin!";
          break;
        }
      }
      if (killedBy) break;
    }
  }

  // ── River (water) collision ────────────────────────────────────────────────
  if (!killedBy && isRiver(newVirtualRow)) {
    const sunkUnderPlayer = sunkThisTick.some(
      (s) =>
        s.rowIndex === newRowIndex &&
        isPointOnWrappedEntity(newCX, s.x, s.width),
    );
    if (sunkUnderPlayer) {
      killedBy = "A fragile log sank under you!";
    } else {
      const onAnyLog = newLogs.some(
        (l) =>
          l.worldRow === newRowIndex &&
          !isLogSunk(l, nowMs) &&
          isPointOnWrappedEntity(newCX, l.x, l.width),
      );
      if (!onAnyLog) {
        killedBy = "Fell in the water!";
      }
    }
  }

  // ── Handle death ───────────────────────────────────────────────────────────
  if (killedBy) {
    const newLives = prev.lives - 1;
    const resetVirtualRow = newVirtualRow + (START_ROW - newRowIndex);
    const newCYReset = (resetVirtualRow + 0.5) * CELL;
    if (newLives <= 0) {
      return {
        ...prev,
        rngState,
        goblins: newGoblins,
        logs: newLogs,
        score,
        lives: 0,
        gameOver: true,
        won: score >= difficulty.targetScore,
        reason: killedBy,
        elapsedMs: nowMs,
      };
    }
    return {
      ...prev,
      rngState,
      playerCX: startPlayerCX(),
      playerCY: newCYReset,
      goblins: newGoblins,
      logs: newLogs,
      score,
      lives: newLives,
      highestProgressVirtualRow: resetVirtualRow,
      deathPauseMs: DEATH_PAUSE_MS,
      reason: killedBy,
      cameraY: startCameraY(newCYReset),
      loopLevel,
      checkpointLoopToken,
      homeLoopToken,
      elapsedMs: nowMs,
    };
  }

  // ── Smooth camera ──────────────────────────────────────────────────────────
  const targetCamY = newCY - (ARENA_H - CELL * 0.5);
  const newCamY = prev.cameraY + (targetCamY - prev.cameraY) * Math.min(1, dt * 8);

  return {
    ...prev,
    rngState,
    playerCX: newCX,
    playerCY: newCY,
    // Sticky: the portrait keeps facing the way the player last travelled
    // horizontally, instead of snapping back to centre when they stop. Being
    // carried along by a drifting log counts as travelling.
    playerFacing:
      newCX < prev.playerCX
        ? "left"
        : newCX > prev.playerCX
          ? "right"
          : prev.playerFacing,
    goblins: newGoblins,
    logs: newLogs,
    cameraY: newCamY,
    score,
    loopLevel,
    highestProgressVirtualRow,
    checkpointLoopToken,
    homeLoopToken,
    elapsedMs: nowMs,
  };
};
