/**
 * Goblin Invaders' simulation: the ship, the formation, the shots, and the
 * step that moves all of them.
 *
 * ## Why this file exists (and used to be inline in `GoblinInvadersGame.tsx`)
 *
 * Goblin Invaders is a tick-simulated cabinet — its score falls out of
 * re-running the exact per-step inputs, which is the only proof of a run worth
 * paying for (see the headers of `worker/src/replay.js` and
 * `worker/src/goblinInvadersReplay.js` for the argument). A proof the
 * *server* re-runs needs the server's copy of the rules to be the same copy
 * the client played with: two implementations of one ruleset will disagree,
 * and a cheater plays whichever one is more lenient. So the step function
 * lives here, imported by both ends, rather than being written once in the
 * component and once in the worker — Frogger's, Pac-Man's and Barley
 * Breaker's `engine.ts` are the precedents.
 *
 * ## What makes a run replayable: an issued seed, a fixed step, and exact ops
 *
 * This engine has genuine runtime RNG — four call sites, all live for the
 * whole run:
 *
 *  - the mystery ship's **respawn delay** (rolled on creation and on every
 *    respawn — 9–16 seconds),
 *  - the mystery ship's **direction** each time it re-enters,
 *  - the mystery ship's **points** when shot (50 / 100 / 150 / 300),
 *  - the **source column** each enemy shot is fired from (a bottom shooter
 *    picked from the surviving columns).
 *
 * plus shot ids, which used to be `Date.now() + Math.random()` and are now a
 * fixed counter on the runtime. That is precisely the shape that must be
 * *issued* rather than chosen: a seed the client picked is a run the client
 * could shop for (a respawning mystery ship that always arrives when the gun
 * is ready, columns that fire where the ship is not). The run's seed comes
 * from `active_runs.seed` at run-open (`run-seed`), the worker reads the same
 * column at chunk-0 and at the claim, and nothing else feeds the RNG. See
 * `advanceRng` for the generator itself — a mulberry32 stream, integer ops
 * only, bit-identical on every engine.
 *
 * The stricter half of the guarantee is *which arithmetic* the step uses. IEEE
 * 754 pins `+ - * /`, `sqrt` and the integer ops to bit-for-bit results on
 * every engine, but it does **not** pin the transcendentals: `Math.sin`,
 * `cos`, `atan2`, `hypot` and `pow` may differ in the last ulp between the
 * browser a run was played on and the workerd isolate that replays it. One ulp
 * is invisible live, but a formation step, a cooldown and a collision
 * compound over thousands of ticks — minutes of movement amplify it into a
 * different shot landing at a different moment and a different score, and the
 * honest player who submitted that score is refused. The original inline step
 * used only `+ - * /`, `Math.sign` (piecewise exact) and the integer ops, so
 * the transcription keeps exactly those.
 *
 * The harness (`scripts/goblinInvadersReplayTest.mjs`) scans this file's
 * source and fails the moment any of that regresses: no `Math.random`, no
 * clock, and no transcendental.
 *
 * ## Why the difficulty rides on the runtime
 *
 * The same reason as Frogger's and Barley Breaker's: the replay parks its
 * match in D1 between chunks, possibly across UTC midnight, and the win check
 * inside `tick` must use the target the run was *played* under. `createRuntime`
 * bakes it in; the worker validates the claimed difficulty *name* (today's or
 * yesterday's) before building the runtime, so "always claim easy" buys
 * nothing.
 *
 * ## The input byte: one per 16 ms step
 *
 * The cabinet has two input paths — keyboard (held direction + Space) and the
 * touch bar (absolute finger position + a FIRE button) — and both must fit in
 * the one-byte-per-step log the chunk machinery counts and slices
 * (`CHUNK_TICKS` bytes = one window, end to end). Bit 7 tags which path
 * produced the byte, exactly as Barley Breaker's does:
 *
 *  - `0b1_RRRRRRR` — a scrub tick: bits 0–6 are the finger's position across
 *    the arena, quantised to 128 levels of the ship's travel (~5.6px — the
 *    ship still parks under the finger, since the step *chases* the target at
 *    `PLAYER_SPEED` rather than teleporting, exactly as the live `onScrub`
 *    event did).
 *  - `0b0_0_F_dd` — a keyboard tick: bit 2 is the fire (Space / the FIRE
 *    button, consumed once per step), bits 0–1 are the held direction as
 *    `dir + 1` (−1 → 0, 0 → 1, +1 → 2; the value 3 was never produced).
 *
 * A fire that lands on a tick whose scrub bit is already set waits for the
 * next keyboard tick (the FIRE button dispatches the `Space` pair, so this
 * only ever comes up while a second finger is actively dragging) — and because
 * the log records the byte the step actually consumed, the replay reproduces
 * the deferral exactly.
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

import { GoblinInvadersDifficulty } from "./session";

// ─────────────────────────────────────────────────────────────────────────────
// Arena geometry (also imported by the component for drawing — one constant,
// one meaning)
// ─────────────────────────────────────────────────────────────────────────────
export const ARENA_WIDTH = 760;
export const ARENA_HEIGHT = 560;
export const PLAYER_Y = ARENA_HEIGHT - 48;
export const PLAYER_SPEED = 420;
export const PLAYER_SIZE = 42; // collision box (kept as-is; gameplay is tuned to it)

export const PLAYER_SHOT_SPEED = 620;
export const ENEMY_SHOT_SPEED = 260;
const ENEMY_ROWS = 5;
const ENEMY_COLS = 11;
export const ENEMY_WIDTH = 34;
export const ENEMY_HEIGHT = 34;

const ENEMY_POINTS_LOW = 10;
const ENEMY_POINTS_MID = 20;
const ENEMY_POINTS_TOP = 30;
const ENEMY_STEP_DISTANCE = 12;
const ENEMY_DROP_DISTANCE = 18;
const ENEMY_STEP_INTERVAL_MIN_MS = 70;
const ENEMY_MAX_ACTIVE_SHOTS = 3;
const SHIELD_COUNT = 4;
export const SHIELD_CELL_SIZE = 6;
const SHIELD_CELL_HP = 3;
/** The y-band the shield cells occupy — see the shield-band guard in `tick`. */
const SHIELD_TOP_Y = PLAYER_Y - 94;
const SHIELD_BOTTOM_Y = SHIELD_TOP_Y + 8 * SHIELD_CELL_SIZE;
export const MYSTERY_SHIP_WIDTH = 52;
export const MYSTERY_SHIP_HEIGHT = 30;
const MYSTERY_SHIP_SPEED = 110;
export const MYSTERY_SHIP_Y = 18;
const MYSTERY_SHIP_RESPAWN_MIN_MS = 9000;
const MYSTERY_SHIP_RESPAWN_MAX_MS = 16000;
const LIFE_LOSS_PAUSE_MS = 1800;

/**
 * The step the simulation advances by, in milliseconds — shared by the
 * component's frame loop and the worker's replay driver.
 */
export const FIXED_STEP_MS = 16;

// ─────────────────────────────────────────────────────────────────────────────
// Entity types
// ─────────────────────────────────────────────────────────────────────────────
export type Projectile = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

export type Enemy = {
  id: number;
  x: number;
  y: number;
  row: number;
  col: number;
  alive: boolean;
};

export type ShieldCell = {
  id: number;
  x: number;
  y: number;
  hp: number;
};

export type MysteryShip = {
  active: boolean;
  x: number;
  direction: 1 | -1;
  respawnMs: number;
};

export type GoblinInvadersRuntime = {
  /** Baked at run-open so a park resumed days later still plays to its target. */
  difficulty: GoblinInvadersDifficulty;
  /** The seed this run's rolls derive from — issued, never chosen. */
  seed: number;
  /** The RNG stream's position — advanced by `advanceRng`, never a clock. */
  rngState: number;
  /** The id counter every projectile is minted from (was `Date.now() + random`). */
  nextId: number;

  playerX: number;
  /**
   * Where the touch bar is asking the ship to be, chased by the step at
   * `PLAYER_SPEED` rather than applied outright. `null` when nothing is
   * chasing.
   */
  playerTargetX: number | null;
  /** Which way the player's bumpkin portrait faces, so it can turn. */
  playerFacing: "left" | "right";
  score: number;
  lives: number;
  wave: number;
  enemies: Enemy[];
  playerShots: Projectile[];
  enemyShots: Projectile[];
  shieldCells: ShieldCell[];
  mysteryShip: MysteryShip;
  enemyDirection: 1 | -1;
  enemyStepTimerMs: number;
  respawnPauseMs: number;
  enemyFireCooldownMs: number;
  shotCooldownMs: number;
  gameOver: boolean;
  won: boolean;
  reason?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
const clamp = (value: number, min: number, max: number) => {
  return Math.max(min, Math.min(max, value));
};

/**
 * The ship's travel, in arena pixels.
 *
 * One clamp for both input paths: the step below and the touch scrub both
 * land here, so a dragged finger and a held arrow key stop at the same two
 * walls rather than the touch path growing a second, looser range.
 */
const clampPlayerX = (x: number) => clamp(x, 0, ARENA_WIDTH - PLAYER_SIZE);

const getEnemyPoints = (row: number) => {
  if (row === 0) return ENEMY_POINTS_TOP;
  if (row <= 2) return ENEMY_POINTS_MID;
  return ENEMY_POINTS_LOW;
};

const getBottomShooters = (enemies: Enemy[]) => {
  const bottomByColumn = new Map<number, Enemy>();

  for (const enemy of enemies) {
    if (!enemy.alive) continue;

    const existing = bottomByColumn.get(enemy.col);
    if (!existing || enemy.row > existing.row) {
      bottomByColumn.set(enemy.col, enemy);
    }
  }

  return Array.from(bottomByColumn.values());
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
 * `rngState` does in Frogger's engine, so a JSON park round trip resumes the
 * stream exactly where the client left it.
 *
 * The original inline code rolled `Math.random()` at each of the call sites
 * documented in the header; same call sites, same `[0, 1)` range, same
 * distribution class — an engine-independent stream instead of a
 * library-dependent one.
 */
const advanceRng = (state: number): { value: number; state: number } => {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = Math.imul(next ^ (next >>> 15), next | 1);
  t = (t ^ ((t + Math.imul(t ^ (t >>> 7), t | 61)) | 0)) | 0;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: next };
};

// ─────────────────────────────────────────────────────────────────────────────
// Entity builders
// ─────────────────────────────────────────────────────────────────────────────

const createWaveEnemies = (wave: number): Enemy[] => {
  const xGap = 58;
  const yGap = 42;
  const formationWidth = ENEMY_WIDTH + (ENEMY_COLS - 1) * xGap;
  const xStart = Math.floor((ARENA_WIDTH - formationWidth) / 2);
  const yStart = 46 + Math.min(70, (wave - 1) * 10);
  let id = wave * 1000;

  const enemies: Enemy[] = [];

  for (let row = 0; row < ENEMY_ROWS; row++) {
    for (let col = 0; col < ENEMY_COLS; col++) {
      enemies.push({
        id: id++,
        x: xStart + col * xGap,
        y: yStart + row * yGap,
        row,
        col,
        alive: true,
      });
    }
  }

  return enemies;
};

const createShieldCells = (): ShieldCell[] => {
  const cells: ShieldCell[] = [];
  const shieldCols = 14;
  const shieldRows = 8;
  const shieldWidth = shieldCols * SHIELD_CELL_SIZE;
  const totalShieldWidth = SHIELD_COUNT * shieldWidth;
  const spacing = Math.floor(
    (ARENA_WIDTH - totalShieldWidth) / (SHIELD_COUNT + 1),
  );
  const top = SHIELD_TOP_Y;
  let id = 1;

  for (let shieldIndex = 0; shieldIndex < SHIELD_COUNT; shieldIndex++) {
    const left = spacing + shieldIndex * (shieldWidth + spacing);

    for (let row = 0; row < shieldRows; row++) {
      for (let col = 0; col < shieldCols; col++) {
        const outsideTopCorners =
          row === 0 && (col < 2 || col > shieldCols - 3);
        const notch = row >= shieldRows - 2 && col >= 5 && col <= 8;
        const thinBottomCorners =
          row === shieldRows - 1 && (col <= 2 || col >= 11);

        if (outsideTopCorners || notch || thinBottomCorners) {
          continue;
        }

        cells.push({
          id: id++,
          x: left + col * SHIELD_CELL_SIZE,
          y: top + row * SHIELD_CELL_SIZE,
          hp: SHIELD_CELL_HP,
        });
      }
    }
  }

  return cells;
};

/**
 * The mystery ship's respawn delay — a roll from the run's stream, where the
 * original read `Math.random()`. Range unchanged: 9–16 seconds.
 */
const getMysteryShipRespawnMs = (roll: () => number) => {
  return (
    MYSTERY_SHIP_RESPAWN_MIN_MS +
    Math.floor(
      roll() * (MYSTERY_SHIP_RESPAWN_MAX_MS - MYSTERY_SHIP_RESPAWN_MIN_MS),
    )
  );
};

/**
 * The mystery ship's points when shot — same four values as before
 * (50 / 100 / 150 / 300), drawn from the run's stream instead of
 * `Math.random()`.
 */
const getMysteryShipPoints = (roll: () => number) => {
  const values = [50, 100, 150, 300];
  return values[Math.floor(roll() * values.length)];
};

const createMysteryShip = (roll: () => number): MysteryShip => ({
  active: false,
  x: -MYSTERY_SHIP_WIDTH,
  direction: 1,
  respawnMs: getMysteryShipRespawnMs(roll),
});

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fresh run at `difficulty`, dealing its first rolls from `seed`.
 *
 * The same call the component makes at run-open and the worker's replay makes
 * at claim: the difficulty is copied onto the runtime, the seed both ends read
 * from `active_runs` seeds one shared stream, and every id the run will ever
 * mint comes from fixed counters rather than `Date.now() + Math.random()` — so
 * two ends that never see each other's clocks still produce the same shots.
 */
export const createRuntime = (
  difficulty: GoblinInvadersDifficulty,
  seed: number,
): GoblinInvadersRuntime => {
  let rngState = seed >>> 0;
  const roll = () => {
    const next = advanceRng(rngState);
    rngState = next.state;
    return next.value;
  };

  return {
    difficulty,
    seed: seed >>> 0,
    rngState,
    nextId: 1,
    playerX: ARENA_WIDTH / 2 - PLAYER_SIZE / 2,
    playerTargetX: null,
    playerFacing: "right",
    score: 0,
    lives: 3,
    wave: 1,
    enemies: createWaveEnemies(1),
    playerShots: [],
    enemyShots: [],
    shieldCells: createShieldCells(),
    mysteryShip: createMysteryShip(roll),
    enemyDirection: 1,
    enemyStepTimerMs: 0,
    respawnPauseMs: 0,
    enemyFireCooldownMs: 0,
    shotCooldownMs: 0,
    gameOver: false,
    won: false,
    // Present from the first tick so the runtime's key set never changes —
    // see the note on `reason` in `tick`.
    reason: "",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// The input byte
// ─────────────────────────────────────────────────────────────────────────────
const SCRUB_BIT = 0x80;
const FIRE_BIT = 0x04;
/** A keyboard byte at most this wide is the largest `dir + 1 | fire` can make. */
const KEYBOARD_MAX = 0x06;
/** Bits 0–6 of a scrub byte: the finger quantised to 128 levels of travel. */
const SCRUB_LEVELS = 127;

/**
 * Pack one step's input into its log byte. See the header for the layout.
 *
 * The scrub ratio is clamped to `[0, 1]` here — the original scrub handler
 * clamped the mapped position through `clampPlayerX` instead, and a ratio
 * outside the bar maps outside the travel to the same two walls.
 */
export const encodeTick = (input: TickInput): number => {
  if (input.scrub !== null) {
    const ratio = clamp(input.scrub, 0, 1);
    return SCRUB_BIT | Math.round(ratio * SCRUB_LEVELS);
  }
  return (input.dir + 1) | (input.fire ? FIRE_BIT : 0);
};

/**
 * Decode one log byte, or `null` for a byte the client could never have
 * written — a scrub byte (bit 7 set) is always decodable; a keyboard byte is
 * only real if it fits the layout (≤ `0b110`) and its direction bits are not
 * the reserved `0b11`.
 *
 * This is the worker's protocol check: the validator scans the whole log
 * through it before stepping, so a byte outside the encoding is refused as
 * protocol garbage rather than replayed as some invented input.
 */
export const decodeTick = (byte: number): TickInput | null => {
  if ((byte & SCRUB_BIT) !== 0) {
    return { dir: 0, fire: false, scrub: (byte & 0x7f) / SCRUB_LEVELS };
  }
  if (byte > KEYBOARD_MAX || (byte & 3) === 3) return null;
  return {
    dir: ((byte & 3) - 1) as -1 | 0 | 1,
    fire: (byte & FIRE_BIT) !== 0,
    scrub: null,
  };
};

export type TickInput = {
  /** Held direction: −1 left, 0 none, +1 right. Ignored while `scrub` is set. */
  dir: -1 | 0 | 1;
  /** Fire pressed this step (Space / the FIRE button), consumed once per step. */
  fire: boolean;
  /** Touch scrub: the finger's 0..1 position across the arena, else `null`. */
  scrub: number | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// The step
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Advance the simulation by exactly `dtMs`, consuming one step's input.
 *
 * Pure: same `(runtime, dtMs, input)` twice is the same runtime, bit for bit —
 * the property the replay rests on, and the reason a step takes its input as
 * a value rather than reading the component's refs.
 *
 * The body is the original inline `tick` transcribed in the same order, with
 * three substitutions: `activeDifficulty` (a component closure) became the
 * runtime's baked `difficulty`; the key poll and the touch `scrubPlayer`
 * event became the step's `input` (the scrub writes the same
 * `playerTargetX` the live event wrote, chased at `PLAYER_SPEED` exactly as
 * before); and `handleShoot` — a keydown event that fired outside the step —
 * became the `input.fire` check below, keeping its own rules (one shot in
 * flight, none during the recovery pause) so a press that would have been
 * ignored live is ignored identically here.
 */
export const tick = (
  prev: GoblinInvadersRuntime,
  dtMs: number,
  input: TickInput,
): GoblinInvadersRuntime => {
  if (prev.gameOver) return prev;

  if (prev.respawnPauseMs > 0) {
    return {
      ...prev,
      respawnPauseMs: Math.max(0, prev.respawnPauseMs - dtMs),
    };
  }

  const difficulty = prev.difficulty;
  const dt = dtMs / 1000;

  let rngState = prev.rngState;
  const roll = () => {
    const next = advanceRng(rngState);
    rngState = next.state;
    return next.value;
  };
  let nextId = prev.nextId;

  // ── Ship movement (was the key poll + the touch `scrubPlayer`) ────────────
  const leftPressed = input.dir === -1;
  const rightPressed = input.dir === 1;

  let playerX = prev.playerX;
  // Facing follows the last horizontal input and is sticky, so the portrait
  // keeps looking the way the player was last going instead of snapping back
  // to centre whenever the key is released.
  let playerFacing = prev.playerFacing;
  let playerTargetX = prev.playerTargetX;

  // A scrub sets *target*, not position: the step walks toward it at
  // `PLAYER_SPEED`, so the ship can still be parked under the finger but
  // cannot cross the arena between two steps. (The old event wrote this same
  // field from `onScrub`; it is now the byte's job.)
  if (input.scrub !== null) {
    playerTargetX = clampPlayerX(input.scrub * (ARENA_WIDTH - PLAYER_SIZE));
  }

  if (leftPressed || rightPressed) {
    // A held key is a direct order, so it cancels any touch target that was
    // still being chased — otherwise the ship would keep drifting toward a
    // finger position the player had already steered away from.
    playerTargetX = null;
  }

  if (leftPressed) {
    playerX -= PLAYER_SPEED * dt;
    playerFacing = "left";
  }
  if (rightPressed) {
    playerX += PLAYER_SPEED * dt;
    playerFacing = "right";
  }

  // Chase the touch target at the keyboard's own speed — see the header of
  // `playerTargetX`.
  if (!leftPressed && !rightPressed && playerTargetX !== null) {
    const distance = playerTargetX - playerX;
    const step = PLAYER_SPEED * dt;
    if (Math.abs(distance) <= step) {
      playerX = playerTargetX;
      playerTargetX = null;
    } else {
      playerX += Math.sign(distance) * step;
      playerFacing = distance < 0 ? "left" : "right";
    }
  }

  playerX = clampPlayerX(playerX);

  let shieldCells = prev.shieldCells;
  let mysteryShip = prev.mysteryShip;

  // ── Fire (was `handleShoot`, a keydown outside the step) ──────────────────
  //
  // Same two rules the event enforced: one player shot in flight at a time,
  // and no fire during the recovery pause (unreachable here — the pause above
  // returns early — but kept as written, since the byte is consumed either
  // way and a press during the pause was equally dead live).
  let playerShots = prev.playerShots;
  let shotCooldownMs = prev.shotCooldownMs;
  if (input.fire && playerShots.length === 0) {
    playerShots = [
      ...playerShots,
      {
        id: nextId++,
        x: playerX + PLAYER_SIZE / 2 - 2,
        y: PLAYER_Y - 8,
        vx: 0,
        vy: -PLAYER_SHOT_SPEED,
      },
    ];
    shotCooldownMs = 0;
  }

  // ── Formation stepping ────────────────────────────────────────────────────
  // One pass over the formation for this step's two whole-formation facts:
  // how many goblins are still alive (the speed pressure) and how far the
  // bottom has descended (the descent pressure). Counted rather than
  // `filter().reduce()`d: this runs every 16 ms step on both ends, and the
  // intermediate array was pure garbage.
  let aliveCount = 0;
  let lowestEnemyY = 0;
  for (let i = 0; i < prev.enemies.length; i++) {
    const enemy = prev.enemies[i];
    if (!enemy.alive) continue;
    aliveCount += 1;
    const bottom = enemy.y + ENEMY_HEIGHT;
    if (bottom > lowestEnemyY) lowestEnemyY = bottom;
  }
  const defeatedCount = prev.enemies.length - aliveCount;
  let enemyDirection = prev.enemyDirection;
  let enemyStepTimerMs = prev.enemyStepTimerMs + dtMs;

  const descentPressure = Math.max(0, (lowestEnemyY - 180) / 8);

  const stepIntervalMs = clamp(
    1080 -
      difficulty.baseEnemySpeed * 7 -
      (prev.wave - 1) * 70 -
      defeatedCount * 10 -
      descentPressure,
    ENEMY_STEP_INTERVAL_MIN_MS,
    1000,
  );

  // Copy-on-write: the enemy array is shared with `prev` until the first
  // mutation of this step, then owned outright for the rest of it. The
  // original transcribed `.map` rebuilt all 55 goblins on every movement
  // (three times a step when the while-loop ran several iterations); one
  // copy per mutated step is the same result, and the step runs 62.5 times
  // a second on both ends, so the allocation count is part of the budget.
  // (Inlined at both copy-on-write sites rather than wrapped in a closure:
  // a closure per step is one more allocation per step.)
  let enemies = prev.enemies;
  let enemiesOwned = false;

  let formationMoved = false;

  // Space Invaders style movement: formation advances in timed steps.
  while (enemyStepTimerMs >= stepIntervalMs) {
    enemyStepTimerMs -= stepIntervalMs;

    // A single pass for the wall test — no intermediate arrays: this runs
    // inside a while-loop whose iterations are bounded only by the timer.
    let willTouchWall = false;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (!enemy.alive) continue;
      const nextX = enemy.x + enemyDirection * ENEMY_STEP_DISTANCE;
      if (nextX <= 8 || nextX + ENEMY_WIDTH >= ARENA_WIDTH - 8) {
        willTouchWall = true;
        break;
      }
    }

    if (!enemiesOwned) {
      enemies = enemies.map((enemy) => ({ ...enemy }));
      enemiesOwned = true;
    }
    formationMoved = true;

    if (willTouchWall) {
      enemyDirection = enemyDirection === 1 ? -1 : 1;
      for (let i = 0; i < enemies.length; i++) {
        const enemy = enemies[i];
        if (!enemy.alive) continue;
        enemy.y = enemy.y + ENEMY_DROP_DISTANCE;
      }
      continue;
    }

    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (!enemy.alive) continue;
      enemy.x = enemy.x + enemyDirection * ENEMY_STEP_DISTANCE;
    }
  }

  // Invaders chew through shields when they descend into them.
  //
  // Gated on `formationMoved` — the one thing that can create an overlap —
  // rather than run every step. A goblin's box and a shield cell's box can
  // only start overlapping when a box moves, and the only moving box is the
  // formation: wave respawns start the formation well above the shields, and
  // a cell that was chewed or shot away never comes back. Same verdicts, an
  // order of magnitude fewer box tests (a step at 16 ms is the budget both
  // ends share).
  if (formationMoved && shieldCells.length > 0) {
    // Pre-pass: only goblins whose box reaches the shield band can chew
    // anything — for most of the game the formation is still up in its
    // starting rows and *nothing* can overlap, so the full scan below is
    // skipped entirely. Exact: outside the band no goblin box can satisfy
    // both y-terms of the test.
    let reachesBand = false;
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (
        enemy.alive &&
        enemy.y + ENEMY_HEIGHT > SHIELD_TOP_Y &&
        enemy.y < SHIELD_BOTTOM_Y
      ) {
        reachesBand = true;
        break;
      }
    }

    if (reachesBand) {
      shieldCells = shieldCells.filter((cell) => {
        for (let i = 0; i < enemies.length; i++) {
          const enemy = enemies[i];
          if (
            enemy.alive &&
            cell.x < enemy.x + ENEMY_WIDTH &&
            cell.x + SHIELD_CELL_SIZE > enemy.x &&
            cell.y < enemy.y + ENEMY_HEIGHT &&
            cell.y + SHIELD_CELL_SIZE > enemy.y
          ) {
            return false;
          }
        }
        return true;
      });
    }
  }

  // ── Mystery ship ──────────────────────────────────────────────────────────
  if (mysteryShip.active) {
    const nextX =
      mysteryShip.x + mysteryShip.direction * MYSTERY_SHIP_SPEED * dt;
    const outOfBounds =
      (mysteryShip.direction === 1 &&
        nextX > ARENA_WIDTH + MYSTERY_SHIP_WIDTH) ||
      (mysteryShip.direction === -1 &&
        nextX + MYSTERY_SHIP_WIDTH < -MYSTERY_SHIP_WIDTH);

    mysteryShip = outOfBounds
      ? {
          active: false,
          x: -MYSTERY_SHIP_WIDTH,
          direction: 1,
          respawnMs: getMysteryShipRespawnMs(roll),
        }
      : {
          ...mysteryShip,
          x: nextX,
        };
  } else {
    const respawnMs = mysteryShip.respawnMs - dtMs;
    if (respawnMs <= 0) {
      const direction: 1 | -1 = roll() < 0.5 ? 1 : -1;
      mysteryShip = {
        active: true,
        direction,
        x: direction === 1 ? -MYSTERY_SHIP_WIDTH : ARENA_WIDTH,
        respawnMs: getMysteryShipRespawnMs(roll),
      };
    } else {
      mysteryShip = {
        ...mysteryShip,
        respawnMs,
      };
    }
  }

  const enemyReachedPlayer = enemies.some(
    (enemy) => enemy.alive && enemy.y + ENEMY_HEIGHT >= PLAYER_Y - 6,
  );

  // ── Projectiles in flight ─────────────────────────────────────────────────
  playerShots = playerShots.map((shot) => ({
    ...shot,
    x: shot.x + shot.vx * dt,
    y: shot.y + shot.vy * dt,
  }));
  playerShots = playerShots.filter(
    (shot) => shot.y > -20 && shot.x > -20 && shot.x < ARENA_WIDTH + 20,
  );

  let enemyShots = prev.enemyShots.map((shot) => ({
    ...shot,
    x: shot.x + shot.vx * dt,
    y: shot.y + shot.vy * dt,
  }));
  enemyShots = enemyShots.filter(
    (shot) =>
      shot.y < ARENA_HEIGHT + 30 &&
      shot.x > -30 &&
      shot.x < ARENA_WIDTH + 30,
  );

  // Classic Space Invaders: player shot cancels enemy shots on contact.
  const cancelledPlayerShots = new Set<number>();
  const cancelledEnemyShots = new Set<number>();
  for (const pShot of playerShots) {
    for (const eShot of enemyShots) {
      const collides =
        pShot.x < eShot.x + 14 &&
        pShot.x + 4 > eShot.x &&
        pShot.y < eShot.y + 20 &&
        pShot.y + 18 > eShot.y;
      if (collides) {
        cancelledPlayerShots.add(pShot.id);
        cancelledEnemyShots.add(eShot.id);
      }
    }
  }
  if (cancelledPlayerShots.size > 0) {
    playerShots = playerShots.filter((s) => !cancelledPlayerShots.has(s.id));
    enemyShots = enemyShots.filter((s) => !cancelledEnemyShots.has(s.id));
  }

  let score = prev.score;

  // ── Player shots: shields, the mystery ship, the formation ────────────────
  const survivingPlayerShots: Projectile[] = [];
  // Created only when something actually dies — a per-step Set otherwise, and
  // most steps with a shot in flight kill nothing.
  let killedIds: Set<number> | null = null;

  for (const shot of playerShots) {
    let hit = false;

    // The shield-band guard: a shot can only ever touch a cell while it is
    // inside the y-band the cells occupy — above it (most of a player
    // shot's flight) or below it (most of an enemy shot's) every cell test
    // fails on y alone, and ~376 failing box tests a step add up over the
    // tens of thousands of steps both ends take. Exact: outside
    // `(SHIELD_TOP_Y − 16, SHIELD_BOTTOM_Y)` no cell can satisfy both
    // y-terms of the test below.
    if (shot.y > SHIELD_TOP_Y - 16 && shot.y < SHIELD_BOTTOM_Y) {
      for (const cell of shieldCells) {
        const intersectsShield =
          shot.x < cell.x + SHIELD_CELL_SIZE &&
          shot.x + 12 > cell.x &&
          shot.y < cell.y + SHIELD_CELL_SIZE &&
          shot.y + 16 > cell.y;

        if (!intersectsShield) continue;

        hit = true;
        shieldCells = shieldCells
          .map((shieldCell) => {
            if (shieldCell.id !== cell.id) return shieldCell;
            return {
              ...shieldCell,
              hp: shieldCell.hp - 1,
            };
          })
          .filter((shieldCell) => shieldCell.hp > 0);
        break;
      }
    }

    if (hit) {
      continue;
    }

    // Same guard idea for the mystery ship's lane: a shot at y ≥ 64 is
    // already past the lane and can never come back down.
    if (mysteryShip.active && shot.y < MYSTERY_SHIP_Y + MYSTERY_SHIP_HEIGHT) {
      const hitMysteryShip =
        shot.x < mysteryShip.x + MYSTERY_SHIP_WIDTH &&
        shot.x + 12 > mysteryShip.x &&
        shot.y < MYSTERY_SHIP_Y + MYSTERY_SHIP_HEIGHT &&
        shot.y + 16 > MYSTERY_SHIP_Y;

      if (hitMysteryShip) {
        hit = true;
        score += getMysteryShipPoints(roll);
        mysteryShip = {
          active: false,
          x: -MYSTERY_SHIP_WIDTH,
          direction: 1,
          respawnMs: getMysteryShipRespawnMs(roll),
        };
        continue;
      }
    }

    for (const enemy of enemies) {
      if (!enemy.alive || (killedIds !== null && killedIds.has(enemy.id)))
        continue;
      const intersects =
        shot.x < enemy.x + ENEMY_WIDTH &&
        shot.x + 12 > enemy.x &&
        shot.y < enemy.y + ENEMY_HEIGHT &&
        shot.y + 16 > enemy.y;

      if (intersects) {
        hit = true;
        killedIds ??= new Set<number>();
        killedIds.add(enemy.id);
        score += getEnemyPoints(enemy.row);
        break;
      }
    }

    if (!hit) {
      survivingPlayerShots.push(shot);
    }
  }

  // Apply the kills: one copy-on-write, then flip the flags — the original
  // rebuilt every goblin to publish `alive: aliveEnemyMap.has(id)`. The scan
  // above skips a killed goblin by id, so a second shot in the same step
  // cannot score the same goblin twice, exactly as the map-delete did.
  if (killedIds !== null && killedIds.size > 0) {
    if (!enemiesOwned) {
      enemies = enemies.map((enemy) => ({ ...enemy }));
      enemiesOwned = true;
    }
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i];
      if (enemy.alive && killedIds.has(enemy.id)) {
        enemy.alive = false;
      }
    }
  }

  // ── Enemy shots: shields, the ship ────────────────────────────────────────
  let lives = prev.lives;
  const survivingEnemyShots: Projectile[] = [];
  let tookHit = false;

  for (const shot of enemyShots) {
    if (tookHit) {
      continue;
    }

    let absorbedByShield = false;
    // Same shield-band guard as the player shot's above — exact, and this is
    // the scan that runs for *every* enemy shot on *every* step.
    if (shot.y > SHIELD_TOP_Y - 16 && shot.y < SHIELD_BOTTOM_Y) {
      for (const cell of shieldCells) {
        const intersectsShield =
          shot.x < cell.x + SHIELD_CELL_SIZE &&
          shot.x + 12 > cell.x &&
          shot.y < cell.y + SHIELD_CELL_SIZE &&
          shot.y + 16 > cell.y;

        if (!intersectsShield) continue;

        shieldCells = shieldCells
          .map((shieldCell) => {
            if (shieldCell.id !== cell.id) return shieldCell;
            return {
              ...shieldCell,
              hp: shieldCell.hp - 1,
            };
          })
          .filter((shieldCell) => shieldCell.hp > 0);
        absorbedByShield = true;
        break;
      }
    }

    if (absorbedByShield) {
      continue;
    }

    const hitPlayer =
      shot.x < playerX + PLAYER_SIZE &&
      shot.x + 12 > playerX &&
      shot.y < PLAYER_Y + PLAYER_SIZE &&
      shot.y + 16 > PLAYER_Y;

    if (hitPlayer) {
      lives -= 1;
      tookHit = true;
      continue;
    }

    survivingEnemyShots.push(shot);
  }

  // ── Enemy fire (the source column is a roll) ──────────────────────────────
  let enemyFireCooldownMs = prev.enemyFireCooldownMs + dtMs;
  const fireInterval = Math.max(
    180,
    difficulty.baseEnemyFireMs - prev.wave * 100 - defeatedCount * 10,
  );

  if (
    enemyFireCooldownMs >= fireInterval &&
    survivingEnemyShots.length < ENEMY_MAX_ACTIVE_SHOTS
  ) {
    const fireCandidates = getBottomShooters(enemies);

    if (fireCandidates.length > 0) {
      const source =
        fireCandidates[Math.floor(roll() * fireCandidates.length)];
      survivingEnemyShots.push({
        id: nextId++,
        x: source.x + ENEMY_WIDTH / 2 - 6,
        y: source.y + ENEMY_HEIGHT - 2,
        vx: 0,
        vy: ENEMY_SHOT_SPEED,
      });
    }

    enemyFireCooldownMs = 0;
  }

  // ── Wave progression and the run's outcome ────────────────────────────────
  let wave = prev.wave;
  const allEnemiesCleared = enemies.every((enemy) => !enemy.alive);

  if (allEnemiesCleared && score < difficulty.targetScore) {
    wave += 1;
    enemies = createWaveEnemies(wave);
    shieldCells = createShieldCells();
    enemyStepTimerMs = 0;
  }

  const won = score >= difficulty.targetScore;
  const lost =
    !won &&
    (lives <= 0 ||
      enemyReachedPlayer ||
      (wave > difficulty.maxWaves && allEnemiesCleared));

  // `""` rather than `undefined` while the run is live, on purpose: the park
  // round-trips through D1 as JSON, and `JSON.stringify` *drops* keys whose
  // value is `undefined` — which would hand the next window's stepping a
  // runtime with a different hidden-class shape than this one, deoptimising
  // the step at every park boundary. A live run never displays `reason`
  // (only a settled one does, and that always has one), so `""` costs
  // nothing visible and keeps the runtime's shape identical through JSON.
  const reason = won
    ? "Target score reached"
    : lives <= 0
      ? "Out of lives"
      : enemyReachedPlayer
        ? "Invaders reached your line"
        : wave > difficulty.maxWaves && allEnemiesCleared
          ? "Wave limit reached"
          : "";

  const respawnPauseMs = tookHit && lives > 0 ? LIFE_LOSS_PAUSE_MS : 0;

  return {
    ...prev,
    rngState,
    nextId,
    playerX,
    playerFacing,
    playerTargetX,
    score,
    lives,
    wave,
    enemies,
    playerShots: survivingPlayerShots,
    enemyShots: tookHit ? [] : survivingEnemyShots,
    shieldCells,
    mysteryShip,
    enemyDirection,
    enemyStepTimerMs,
    respawnPauseMs,
    enemyFireCooldownMs,
    shotCooldownMs: Math.max(0, shotCooldownMs - dtMs),
    gameOver: won || lost,
    won,
    reason,
  };
};
