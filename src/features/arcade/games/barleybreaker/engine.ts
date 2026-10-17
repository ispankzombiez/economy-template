/**
 * Barley Breaker's simulation: the paddle, the balls, the bricks, and the step
 * that moves all three.
 *
 * ## Why this file exists (and used to be inline in `BarleyBreakerGame.tsx`)
 *
 * Barley Breaker is a tick-simulated cabinet — its score falls out of re-running
 * the exact per-step inputs, which is the only proof of a run worth paying for
 * (see the headers of `worker/src/replay.js` and `worker/src/barleyBreakerReplay.js`
 * for the argument). A proof the *server* re-runs needs the server's copy of the
 * rules to be the same copy the client played with: two implementations of one
 * ruleset will disagree, and a cheater plays whichever one is more lenient. So
 * the step function lives here, imported by both ends, rather than being written
 * once in the component and once in the worker — Pac-Man's `engine.ts` is the
 * precedent.
 *
 * ## What makes a run replayable: no RNG, no clock, and exact ops only
 *
 * Nothing here reads `Math.random()` or `Date.now()`. The wobble the drop rolls
 * and the brick layouts need is a pure function of `(wave, row, col, salt)` —
 * see `getPseudoRandom`.
 *
 * The stricter half of the guarantee is *which arithmetic* is used. IEEE 754
 * pins `+ - * /`, `sqrt` and the integer ops to bit-for-bit results on every
 * engine, but it does **not** pin the transcendentals: `Math.sin`, `cos`,
 * `atan2`, `hypot` and `pow` may differ in the last ulp between the browser a
 * run was played on and the workerd isolate that replays it. One ulp at a
 * bounce angle is invisible live, but a breakout is chaos — minutes of
 * reflections amplify it into a different brick at a different moment and a
 * different score, and the honest player who submitted that score is refused.
 * So the original inline step's transcendentals were each replaced with a
 * formulation built only from exact ops, preserving the behaviour it encoded:
 *
 *  - `getPseudoRandom` — was `fract(sin(x) * 43758.5453)`; now an integer hash
 *    (imul/xor/shift). Same signature, same `[0, 1)` range, same call sites:
 *    strong bricks, powerup drops, the weighted powerup roll.
 *  - The **paddle bounce** — was `vx = sin(impact * 60°) * speed`, a
 *    transcendental of a *variable*; now `vx = impact * SIN_60° * speed` with
 *    `SIN_60°` a literal. The two agree exactly at the ends the paddle is felt
 *    from — centre impact sends the ball straight up, edge impact sends it at
 *    60° — and differ slightly in between (a marginally more vertical mid-
 *    paddle), which is the price of a number every engine computes identically.
 *  - The **multiball fan** — was `atan2` to read the reference ball's heading
 *    then `sin`/`cos` of `heading + offset`; now a pure vector rotation by
 *    literal `(cos, sin)` pairs (`FAN_ROTATION`). Rotating `(vx, vy)` by `θ`
 *    *is* the old reconstruction — `sin(atan2(vx, -vy) + θ)` — algebraically,
 *    without ever naming an angle. The wrap (`offset * (1 + floor(index / 8))`)
 *    is applied by repeating the rotation that many times: m rotations by θ are
 *    a rotation by mθ, and sequential multiplication of the same doubles is
 *    bit-identical everywhere.
 *  - `Math.hypot` → `Math.sqrt(a * a + b * b)`; `Math.pow(x, 2)` → `x * x`.
 *
 * The harness (`scripts/barleyBreakerReplayTest.mjs`) scans this file's source
 * and fails the moment any of that regresses: no `Math.random`, no clock, and
 * no transcendental.
 *
 * ## Why the difficulty rides on the runtime
 *
 * The same reason as Pac-Man's: the replay parks its match in D1 as JSON
 * between chunks, possibly across UTC midnight, and the win check inside `tick`
 * must use the target the run was *played* under. `createRuntime` bakes it in;
 * the worker validates the claimed difficulty *name* (today's or yesterday's)
 * before building the runtime, so "always claim easy" buys nothing.
 *
 * ## The input byte: one per 16 ms step
 *
 * The cabinet has two input paths — keyboard (held direction) and the touch
 * bar (absolute finger position) — and both must fit in the one-byte-per-step
 * log the chunk machinery counts and slices (`CHUNK_TICKS` bytes = one window,
 * end to end). Bit 7 tags which path produced the byte:
 *
 *  - `0b1_RRRRRRR` — a scrub tick: bits 0–6 are the finger's position across
 *    the bar, quantised to 128 levels of the paddle's travel (~4.6px — finer
 *    than one keyboard step of travel). The step applies it as an absolute
 *    position, exactly as the live `onScrub` event did.
 *  - `0b0_0_L_dd` — a keyboard tick: bit 2 is the launch (Space / the LAUNCH
 *    button, consumed once per step), bits 0–1 are the held direction as
 *    `dir + 1` (−1 → 0, 0 → 1, +1 → 2; the value 3 was never produced).
 *
 * A launch that lands on a tick whose scrub bit is already set waits for the
 * next keyboard tick (the fire button dispatches the `Space` pair, so this only
 * ever comes up while a *second* finger is actively dragging) — and because the
 * log records the byte the step actually consumed, the replay reproduces the
 * deferral exactly.
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

import {
  BarleyBreakerDifficulty,
  PowerUpType,
} from "./session";

// ─────────────────────────────────────────────────────────────────────────────
// Arena geometry (also imported by the component for drawing — one constant,
// one meaning)
// ─────────────────────────────────────────────────────────────────────────────
export const ARENA_WIDTH = 760;
export const ARENA_HEIGHT = 560;
const SIDE_GUTTER = 24;
export const CEILING_MARGIN = 20;
export const PADDLE_Y = 506;
const PADDLE_WIDTH = 96;
const WIDE_PADDLE_WIDTH = 130;
export const PADDLE_HEIGHT = 16;
const PADDLE_SPEED = 540;
export const BALL_SIZE = 18;
const BALL_WAVE_SPEED_STEP = 18;
const BALL_WAVE_SPEED_CAP = 72;
const WIDE_PADDLE_DURATION_MS = 18000;
const SLOW_BALL_DURATION_MS = 12000;
const SLOW_BALL_MULTIPLIER = 0.82;
const DROP_SPEED = 140;
const BRICK_FIELD_TOP = 52;
const BRICK_COLS = 13;
const BRICK_WIDTH = 50;
const BRICK_HEIGHT = 18;
const BRICK_GAP = 4;

/**
 * The step the simulation advances by, in milliseconds — shared by the
 * component's frame loop and the worker's replay driver.
 */
export const FIXED_STEP_MS = 16;

/**
 * `sin(π / 3)` as a literal.
 *
 * The paddle bounce used to compute `sin(normalizedImpact * MAX_BOUNCE_ANGLE)`
 * per hit — a transcendental of a variable, and therefore engine-dependent to
 * the last ulp (see the header). The literal is `Math.sin(Math.PI / 3)` to
 * full double precision, so the edge-of-paddle angle is what it always was.
 */
const SIN_MAX_BOUNCE_ANGLE = 0.8660254037844386;

const WAVE_TEMPLATES = [
  [
    "XXXXXXXXXXXXX",
    "XXXXXXXXXXXXX",
    "XXXXXXXXXXXXX",
    "XXXXXXXXXXXXX",
    "XXXXXXXXXXXXX",
    "XXXXXXXXXXXXX",
    "XXXXXXXXXXXXX",
    "XXXXXXXXXXXXX",
  ],
  [
    "XXXXXX.XXXXXX",
    "XXXXXX.XXXXXX",
    "XXXXXX.XXXXXX",
    "XXXXXX.XXXXXX",
    "XXXXXX.XXXXXX",
    "XXXXXX.XXXXXX",
    "XXXXXX.XXXXXX",
    "XXXXXX.XXXXXX",
  ],
  [
    "XXXXX...XXXXX",
    "XXXXX...XXXXX",
    "XXXXX...XXXXX",
    "XXXXX...XXXXX",
    "XXXXX...XXXXX",
    "XXXXX...XXXXX",
    "XXXXX...XXXXX",
    "XXXXX...XXXXX",
  ],
  [
    "....XXXXX....",
    "...XXXXXXX...",
    "..XXXXXXXXX..",
    ".XXXXXXXXXXX.",
    ".XXXXXXXXXXX.",
    "..XXXXXXXXX..",
    "...XXXXXXX...",
    "....XXXXX....",
  ],
  [
    "XXXXXXXXXXXXX",
    "X...XXXXX...X",
    "X..XXXXXXX..X",
    "X.XXXXXXXXX.X",
    "X.XXXXXXXXX.X",
    "X..XXXXXXX..X",
    "X...XXXXX...X",
    "XXXXXXXXXXXXX",
  ],
] as const;

export type Brick = {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  hp: number;
  maxHp: number;
  points: number;
  alive: boolean;
};

export type Ball = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  stuck: boolean;
};

export type Drop = {
  id: number;
  type: PowerUpType;
  x: number;
  y: number;
  vy: number;
};

export type BarleyBreakerRuntime = {
  /** Baked at run-open so a park resumed days later still plays to its target. */
  difficulty: BarleyBreakerDifficulty;
  /** Monotonic id source for balls and drops — deterministic, never a clock. */
  nextId: number;
  paddleX: number;
  balls: Ball[];
  bricks: Brick[];
  drops: Drop[];
  score: number;
  lives: number;
  wave: number;
  widePaddleMs: number;
  slowBallMs: number;
  speedMultiplier: number;
  gameOver: boolean;
  won: boolean;
  reason?: string;
};

/**
 * What one step consumes. The component samples this from its refs, encodes it
 * into the log, and feeds it to `tick`; the worker decodes the log's byte and
 * feeds the same object to the same `tick`.
 */
export type TickInput = {
  /** Held direction: −1 left, 0 none, +1 right. Ignored while `scrub` is set. */
  dir: -1 | 0 | 1;
  /** A launch was pending this step: release every stuck ball. */
  launch: boolean;
  /** Touch scrub: the finger's 0..1 position across the bar, else `null`. */
  scrub: number | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const getBrickPoints = (row: number) => {
  if (row < 2) return 40;
  if (row < 4) return 30;
  if (row < 6) return 20;
  return 10;
};

const getWaveBallSpeed = (
  difficulty: BarleyBreakerDifficulty,
  wave: number,
) => {
  return (
    difficulty.baseBallSpeed +
    Math.min(BALL_WAVE_SPEED_CAP, (wave - 1) * BALL_WAVE_SPEED_STEP)
  );
};

export const getPaddleWidth = (runtime: BarleyBreakerRuntime) => {
  return runtime.widePaddleMs > 0 ? WIDE_PADDLE_WIDTH : PADDLE_WIDTH;
};

/**
 * The paddle's travel, in arena pixels.
 *
 * One clamp for both input paths: the directional step and the touch scrub
 * both land here, so a dragged finger and a held arrow key stop at the same
 * two walls rather than the touch path growing a second, looser range.
 */
const clampPaddleX = (x: number, paddleWidth: number) =>
  clamp(x, SIDE_GUTTER, ARENA_WIDTH - SIDE_GUTTER - paddleWidth);

const getTemplateForWave = (wave: number) => {
  return WAVE_TEMPLATES[(wave - 1) % WAVE_TEMPLATES.length];
};

/**
 * The drop rolls and the strong-brick rolls: a pure function of
 * `(wave, row, col, salt)` returning `[0, 1)`.
 *
 * The original was `fract(sin(x) * 43758.5453)` — fine for cosmetics, and
 * what the game shipped with, but `Math.sin` is implementation-defined to the
 * last ulp, so two engines could disagree about whether a roll landed under
 * `powerUpChance` and the whole run diverges from there. This is an integer
 * avalanche (mulberry/murmur-style: imul, xor, shift) — bit-identical on every
 * engine, same call sites, same range.
 */
const getPseudoRandom = (
  wave: number,
  row: number,
  col: number,
  salt: number,
) => {
  let h =
    Math.imul(wave | 0, 0x9e3779b1) ^
    Math.imul(row | 0, 0x85ebca6b) ^
    Math.imul(col | 0, 0xc2b2ae35) ^
    Math.imul(salt | 0, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 13), 0x297a2d39);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

const getWeightedPowerUp = (
  wave: number,
  score: number,
  brickId: number,
): PowerUpType => {
  const roll = getPseudoRandom(wave, score, brickId, 19) * 10;

  if (roll < 4) return "wide-paddle";
  if (roll < 7) return "slow-ball";
  if (roll < 9) return "multiball";
  return "extra-life";
};

// ─────────────────────────────────────────────────────────────────────────────
// The multiball fan — exact vector rotation instead of atan2 + sin/cos
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The eight fan offsets, as the rotation matrices they denote: `(cos, sin)` of
 * each literal offset, written out as literals so *no* engine computes them.
 *
 * The offsets themselves (`[-0.34, 0.34, …]`) are ordinary double literals —
 * exactly representable, identical everywhere — but `Math.cos(0.34)` is a
 * library call whose last ulp is not specified by anything. Pasting the pair
 * that the original `Math.cos`/`Math.sin` produced removes the call.
 */
const FAN_ROTATION: ReadonlyArray<readonly [number, number]> = [
  [0.9427546655283462, -0.3334870921408144], // −0.34
  [0.9427546655283462, 0.3334870921408144], // +0.34
  [0.7775727187509279, -0.6287930240184686], // −0.68
  [0.7775727187509279, 0.6287930240184686], // +0.68
  [0.5233659512516495, -0.852108021949363], // −1.02
  [0.5233659512516495, 0.852108021949363], // +1.02
  [0.20923866589141926, -0.9778646024353163], // −1.36
  [0.20923866589141926, 0.9778646024353163], // +1.36
];

/**
 * Spread a multiball across the reference ball's heading — by rotating its
 * *velocity*, never by naming an angle.
 *
 * The original's feel is that the ball you were already watching keeps its
 * momentum and simply *becomes several*: the heading was taken from a live
 * ball, and each new ball rotated `MULTIBALL_FAN[index]` radians either side
 * of it, `offset * (1 + floor(index / 8))` on wraps so a long run of
 * multiballs keeps fanning outwards rather than winding round to the back of
 * the room.
 *
 * Algebraically, with `h = atan2(vx, −vy)` (0 = straight up), the old
 * `sin(h + θ)`, `−cos(h + θ)` is exactly `R(θ) · (vx, vy)` — the standard
 * rotation of the velocity vector — so the rotation is applied directly, and
 * the wrap's `×m` is applied by repeating it `m` times (m rotations by θ are a
 * rotation by mθ; sequential multiplication of the same doubles is exact and
 * identical on every engine).
 *
 * The degenerate reference (a ball with no velocity — every ball stuck) is the
 * old `ballHeading` fallback of −π/2: the unit vector `(-1, 0)`, which rotated
 * reproduces the old `sin(-π/2 + θ)`, `-cos(-π/2 + θ)` exactly.
 *
 * @param vx The reference ball's x velocity.
 * @param vy The reference ball's y velocity.
 * @param index The fan index (0 and 1 per pickup, as the caller has always
 *   passed).
 * @param speed The magnitude to give the new ball.
 * @returns The new ball's velocity.
 */
const fanVelocity = (
  vx: number,
  vy: number,
  index: number,
  speed: number,
): { vx: number; vy: number } => {
  const refSpeed = Math.sqrt(vx * vx + vy * vy);
  const [ux, uy] = refSpeed < 0.001 ? [-1, 0] : [vx / refSpeed, vy / refSpeed];

  const [c, s] = FAN_ROTATION[((index % 8) + 8) % 8];
  const wraps = 1 + Math.floor(index / FAN_ROTATION.length);

  let x = ux;
  let y = uy;
  for (let m = wraps; m > 0; m--) {
    const rotatedX = x * c - y * s;
    y = x * s + y * c;
    x = rotatedX;
  }

  return { vx: x * speed, vy: y * speed };
};

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

const createWaveBricks = (
  wave: number,
  difficulty: BarleyBreakerDifficulty,
): Brick[] => {
  const template = getTemplateForWave(wave);
  const totalWidth = BRICK_COLS * BRICK_WIDTH + (BRICK_COLS - 1) * BRICK_GAP;
  const startX = Math.floor((ARENA_WIDTH - totalWidth) / 2);
  const bricks: Brick[] = [];
  let id = 1;

  template.forEach((rowPattern, row) => {
    rowPattern.split("").forEach((cell, col) => {
      if (cell !== "X") return;

      const strongBrick =
        wave > 1 &&
        getPseudoRandom(wave, row, col, difficulty.baseBallSpeed) <
          difficulty.strongBrickChance;
      const hp = strongBrick ? 2 : 1;

      bricks.push({
        id: id++,
        x: startX + col * (BRICK_WIDTH + BRICK_GAP),
        y: BRICK_FIELD_TOP + row * (BRICK_HEIGHT + BRICK_GAP),
        width: BRICK_WIDTH,
        height: BRICK_HEIGHT,
        hp,
        maxHp: hp,
        points: getBrickPoints(row),
        alive: true,
      });
    });
  });

  return bricks;
};

const createHeldBall = (
  paddleX: number,
  paddleWidth: number,
  id: number,
): Ball => ({
  id,
  x: paddleX + paddleWidth / 2 - BALL_SIZE / 2,
  y: PADDLE_Y - BALL_SIZE - 4,
  vx: 0,
  vy: 0,
  stuck: true,
});

/**
 * Build a fresh run at `difficulty`.
 *
 * The same call the component makes at run-open and the worker's replay makes
 * at claim: the difficulty is copied onto the runtime, and every id the run
 * will ever mint comes from the monotonic `nextId` counter rather than
 * `Date.now() + Math.random()` — so two ends that never see each other's
 * clocks still produce the same list of balls and drops.
 */
export const createRuntime = (
  difficulty: BarleyBreakerDifficulty,
): BarleyBreakerRuntime => {
  const paddleX = ARENA_WIDTH / 2 - PADDLE_WIDTH / 2;
  let nextId = 1;

  return {
    difficulty,
    nextId: nextId + 1,
    paddleX,
    balls: [createHeldBall(paddleX, PADDLE_WIDTH, nextId)],
    bricks: createWaveBricks(1, difficulty),
    drops: [],
    score: 0,
    lives: difficulty.startingLives,
    wave: 1,
    widePaddleMs: 0,
    slowBallMs: 0,
    speedMultiplier: 1,
    gameOver: false,
    won: false,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// The input byte
// ─────────────────────────────────────────────────────────────────────────────

const SCRUB_BIT = 0x80;
const LAUNCH_BIT = 0x04;
/** A keyboard byte at most this wide is the largest `dir + 1 | launch` can make. */
const KEYBOARD_MAX = 0x06;
/** Bits 0–6 of a scrub byte: the finger quantised to 128 levels of travel. */
const SCRUB_LEVELS = 127;

/**
 * Pack one step's input into its log byte. See the header for the layout.
 *
 * The scrub ratio is clamped to `[0, 1]` here — the original scrub handler
 * clamped the mapped position through `clampPaddleX` instead, and a ratio
 * outside the bar maps outside the travel to the same two walls.
 */
export const encodeTick = (input: TickInput): number => {
  if (input.scrub !== null) {
    const ratio = clamp(input.scrub, 0, 1);
    return SCRUB_BIT | Math.round(ratio * SCRUB_LEVELS);
  }
  return (input.dir + 1) | (input.launch ? LAUNCH_BIT : 0);
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
    return { dir: 0, launch: false, scrub: (byte & 0x7f) / SCRUB_LEVELS };
  }
  if (byte > KEYBOARD_MAX || (byte & 3) === 3) return null;
  return {
    dir: ((byte & 3) - 1) as -1 | 0 | 1,
    launch: (byte & LAUNCH_BIT) !== 0,
    scrub: null,
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
 * The body is the original inline `tick` (plus the event-driven `launchBall`
 * and the touch `scrubPaddle`, both of which moved *into* the step: an event
 * applied between frames cannot be replayed, a value consumed at step N can).
 * What changed is arithmetic only — see the header.
 */
export const tick = (
  previous: BarleyBreakerRuntime,
  dtMs: number,
  input: TickInput,
): BarleyBreakerRuntime => {
  if (previous.gameOver) return previous;

  const difficulty = previous.difficulty;
  const dt = dtMs / 1000;
  let nextId = previous.nextId;

  // ── Launch (was the event-driven `launchBall`) ────────────────────────────
  let balls: Ball[] = previous.balls;
  if (input.launch) {
    const speed =
      getWaveBallSpeed(difficulty, previous.wave) * previous.speedMultiplier;
    let launched = false;

    balls = balls.map((ball, index) => {
      if (!ball.stuck) return ball;

      launched = true;
      const direction = index % 2 === 0 ? 1 : -1;
      const horizontal = speed * 0.55 * direction;
      return {
        ...ball,
        vx: horizontal,
        vy: -Math.sqrt(Math.max(speed * speed - horizontal * horizontal, 1)),
        stuck: false,
      };
    });

    if (!launched) balls = previous.balls;
  }

  // ── Paddle (was the key poll inside `tick` + the touch `scrubPaddle`) ─────
  const currentPaddleWidth = getPaddleWidth(previous);
  let paddleX: number;
  if (input.scrub !== null) {
    const leftmost = SIDE_GUTTER;
    const rightmost = ARENA_WIDTH - SIDE_GUTTER - currentPaddleWidth;
    paddleX = clampPaddleX(
      leftmost + input.scrub * (rightmost - leftmost),
      currentPaddleWidth,
    );
  } else {
    paddleX = clampPaddleX(
      previous.paddleX + input.dir * PADDLE_SPEED * dt,
      currentPaddleWidth,
    );
  }

  let score: number = previous.score;
  let lives: number = previous.lives;
  let won: boolean = previous.won;
  let gameOver: boolean = previous.gameOver;
  let reason: string | undefined = previous.reason;
  let wave: number = previous.wave;
  let widePaddleMs: number = Math.max(0, previous.widePaddleMs - dtMs);
  let slowBallMs: number = Math.max(0, previous.slowBallMs - dtMs);
  let drops: Drop[] = previous.drops.map((drop) => ({
    ...drop,
    y: drop.y + drop.vy * dt,
  }));
  let bricks = previous.bricks.map((brick) => ({ ...brick }));
  balls = balls.map((ball) => ({ ...ball }));
  const paddleWidth = currentPaddleWidth;
  const paddleRight = paddleX + paddleWidth;
  let collectedWide = false;
  let collectedSlow = false;
  let collectedMultiball = false;
  let collectedExtraLife = false;
  const livingBalls: Ball[] = [];

  for (const sourceBall of balls) {
    const ball = { ...sourceBall };

    if (ball.stuck) {
      livingBalls.push({
        ...ball,
        x: paddleX + paddleWidth / 2 - BALL_SIZE / 2,
        y: PADDLE_Y - BALL_SIZE - 4,
      });
      continue;
    }

    let nextX = ball.x + ball.vx * dt;
    let nextY = ball.y + ball.vy * dt;
    let nextVx = ball.vx;
    let nextVy = ball.vy;

    if (nextX <= SIDE_GUTTER) {
      nextX = SIDE_GUTTER;
      nextVx = Math.abs(nextVx);
    }
    if (nextX + BALL_SIZE >= ARENA_WIDTH - SIDE_GUTTER) {
      nextX = ARENA_WIDTH - SIDE_GUTTER - BALL_SIZE;
      nextVx = -Math.abs(nextVx);
    }
    if (nextY <= CEILING_MARGIN) {
      nextY = CEILING_MARGIN;
      nextVy = Math.abs(nextVy);
    }

    const overlapsPaddle =
      nextX < paddleRight &&
      nextX + BALL_SIZE > paddleX &&
      nextY < PADDLE_Y + PADDLE_HEIGHT &&
      nextY + BALL_SIZE > PADDLE_Y;
    if (
      nextVy > 0 &&
      overlapsPaddle &&
      ball.y + BALL_SIZE <= PADDLE_Y + 6
    ) {
      const speed = Math.sqrt(nextVx * nextVx + nextVy * nextVy);
      const paddleCenter = paddleX + paddleWidth / 2;
      const ballCenter = nextX + BALL_SIZE / 2;
      const normalizedImpact = clamp(
        (ballCenter - paddleCenter) / (paddleWidth / 2),
        -1,
        1,
      );
      // Was `sin(impact * 60°)` / `cos(impact * 60°)` — a transcendental of a
      // variable, therefore engine-dependent. The linear map keeps the two ends
      // the paddle is *felt* from exactly (centre → straight up, edge → 60°)
      // and keeps `vx² + vy² = speed²` exactly, which the trig did only to
      // within an ulp.
      nextVx = speed * normalizedImpact * SIN_MAX_BOUNCE_ANGLE;
      nextVy = -Math.max(
        120,
        Math.sqrt(Math.max(speed * speed - nextVx * nextVx, 1)),
      );
      nextY = PADDLE_Y - BALL_SIZE - 1;
    }

    let hitBrickIndex = -1;
    for (let index = 0; index < bricks.length; index++) {
      const brick = bricks[index];
      if (!brick.alive) continue;

      const intersectsBrick =
        nextX < brick.x + brick.width &&
        nextX + BALL_SIZE > brick.x &&
        nextY < brick.y + brick.height &&
        nextY + BALL_SIZE > brick.y;
      if (!intersectsBrick) continue;

      hitBrickIndex = index;
      const overlapLeft = nextX + BALL_SIZE - brick.x;
      const overlapRight = brick.x + brick.width - nextX;
      const overlapTop = nextY + BALL_SIZE - brick.y;
      const overlapBottom = brick.y + brick.height - nextY;
      const overlapX = Math.min(overlapLeft, overlapRight);
      const overlapY = Math.min(overlapTop, overlapBottom);

      if (overlapX < overlapY) {
        nextVx = -nextVx;
      } else {
        nextVy = -nextVy;
      }
      break;
    }

    if (hitBrickIndex >= 0) {
      const brick = bricks[hitBrickIndex];
      brick.hp -= 1;

      if (brick.hp <= 0) {
        brick.alive = false;
        score += brick.points;

        if (
          getPseudoRandom(wave, hitBrickIndex, score, brick.id) <
          difficulty.powerUpChance
        ) {
          drops.push({
            // The runtime's counter, where the original mixed `Date.now()`
            // with `Math.random()` — ids are React keys and nothing else, but
            // a replay that minted different ids would still be a different
            // runtime, and JSON-compared runtimes are exactly what the park
            // round trip is.
            id: nextId++,
            type: getWeightedPowerUp(wave, score, brick.id),
            x: brick.x + brick.width / 2 - 14,
            y: brick.y + brick.height / 2 - 14,
            vy: DROP_SPEED,
          });
        }
      }
    }

    if (nextY > ARENA_HEIGHT + BALL_SIZE) {
      continue;
    }

    livingBalls.push({
      ...ball,
      x: nextX,
      y: nextY,
      vx: nextVx,
      vy: nextVy,
    });
  }
  balls = livingBalls;

  drops = drops.filter((drop) => drop.y < ARENA_HEIGHT + 32);
  drops = drops.filter((drop) => {
    const caught =
      drop.x < paddleRight &&
      drop.x + 28 > paddleX &&
      drop.y < PADDLE_Y + PADDLE_HEIGHT &&
      drop.y + 28 > PADDLE_Y;
    if (!caught) return true;

    if (drop.type === "wide-paddle") {
      collectedWide = true;
    }
    if (drop.type === "slow-ball") {
      collectedSlow = true;
    }
    if (drop.type === "extra-life") {
      collectedExtraLife = true;
    }
    if (drop.type === "multiball") {
      collectedMultiball = true;
    }
    return false;
  });

  if (collectedWide) {
    widePaddleMs = WIDE_PADDLE_DURATION_MS;
  }
  if (collectedSlow) {
    slowBallMs = SLOW_BALL_DURATION_MS;
  }
  if (collectedExtraLife) {
    lives = Math.min(difficulty.startingLives + 1, lives + 1);
  }
  if (collectedMultiball && balls.length > 0) {
    // Fan out from a ball that is actually moving, and **keep every ball
    // already on the table with its own velocity untouched**. (The comment is
    // the original's; the arithmetic moved into `fanVelocity`, which rotates
    // the reference velocity by literal matrices instead of naming its
    // heading.)
    const live = balls.filter((ball) => !ball.stuck);
    const referenceBall = live[0] ?? balls[0];
    const refSpeed = Math.sqrt(
      referenceBall.vx * referenceBall.vx + referenceBall.vy * referenceBall.vy,
    );
    const speed = Math.max(
      160,
      refSpeed || getWaveBallSpeed(difficulty, wave),
    );

    // Two extra balls per pickup. No cap: the ceiling that used to sit at
    // three is what stopped a good position from paying off, and every ball
    // is just another 12-line loop in the tick.
    const extrasPerPickup = 2;

    for (let index = 0; index < extrasPerPickup; index++) {
      const velocity = fanVelocity(
        referenceBall.vx,
        referenceBall.vy,
        index,
        speed,
      );
      balls.push({
        id: nextId++,
        x: referenceBall.x,
        y: referenceBall.y,
        vx: velocity.vx,
        vy: velocity.vy,
        stuck: false,
      });
    }
  }

  const nextSpeedMultiplier = slowBallMs > 0 ? SLOW_BALL_MULTIPLIER : 1;
  if (nextSpeedMultiplier !== previous.speedMultiplier) {
    const ratio = nextSpeedMultiplier / previous.speedMultiplier;
    balls = balls.map((ball) =>
      ball.stuck
        ? ball
        : {
            ...ball,
            vx: ball.vx * ratio,
            vy: ball.vy * ratio,
          },
    );
  }

  if (score >= difficulty.targetScore) {
    won = true;
    gameOver = true;
    reason = "Target score reached";
  }

  const remainingBricks = bricks.filter((brick) => brick.alive);
  if (!gameOver && remainingBricks.length === 0) {
    wave += 1;
    bricks = createWaveBricks(wave, difficulty);
    drops = [];
    widePaddleMs = 0;
    slowBallMs = 0;
    balls = [createHeldBall(paddleX, PADDLE_WIDTH, nextId++)];
  }

  if (!gameOver && balls.length === 0) {
    lives -= 1;

    if (lives <= 0) {
      gameOver = true;
      won = false;
      reason = "Out of lives";
    } else {
      balls = [createHeldBall(paddleX, PADDLE_WIDTH, nextId++)];
    }
  }

  return {
    ...previous,
    nextId,
    paddleX,
    balls,
    bricks,
    drops,
    score,
    lives,
    wave,
    widePaddleMs,
    slowBallMs,
    speedMultiplier: nextSpeedMultiplier,
    gameOver,
    won,
    reason,
  };
};
