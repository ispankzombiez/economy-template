/**
 * Raven Bubbles' simulation: the hex field, the shot in flight, the ceiling
 * clock, and the step that advances all of them.
 *
 * ## Why this file exists (and used to be inline in `RavenBubblesGame.tsx`)
 *
 * Raven Bubbles is a tick-simulated cabinet — its score falls out of re-running
 * the exact per-step inputs, which is the only proof of a run worth paying for
 * (see the headers of `worker/src/replay.js` and
 * `worker/src/ravenBubblesReplay.js` for the argument). A proof the *server*
 * re-runs needs the server's copy of the rules to be the same copy the client
 * played with: two implementations of one ruleset will disagree, and a cheater
 * plays whichever one is more lenient. So the step function lives here,
 * imported by both ends, rather than being written once in the component and
 * once in the worker — Frogger's, Tetris's, Barley Breaker's, Pac-Man's and
 * Goblin Invaders' `engine.ts` are the precedents.
 *
 * ## What makes a run replayable: an issued seed, a fixed step, and exact ops
 *
 * This engine has genuine runtime RNG — the call sites are all live for the
 * whole run:
 *
 *  - the **opening deal** and every **screen refill** (`createBoard`: a colour
 *    per clump, a clump size of one or two, a placement per extra bubble),
 *  - every **queue deal** (`pickNextColor`: the weighted pool pick, plus its
 *    fallback when the board holds nothing but the excluded colour).
 *
 * That is precisely the shape that must be *issued* rather than chosen: a seed
 * the client picked is a run the client could shop for (a board dealt with the
 * triples already in place, a queue that always hands over the completing
 * colour). The run's seed comes from `active_runs.seed` at run-open
 * (`run-seed`), the worker reads the same column at chunk-0 and at the claim,
 * and nothing else feeds the RNG. See `advanceRng` for the generator itself —
 * a mulberry32 stream, integer ops only, bit-identical on every engine.
 *
 * The stricter half of the guarantee is *which arithmetic* the step uses. IEEE
 * 754 pins `+ - * /`, `sqrt` and the integer ops to bit-for-bit results on
 * every engine, but it does **not** pin the transcendentals: `Math.sin`,
 * `cos`, `atan2`, `hypot` and `pow` may differ in the last ulp between the
 * browser a run was played on and the workerd isolate that replays it. A
 * bubble shooter's shot is short — but "short" still means dozens of substeps,
 * a wall bounce, and a snap-to-nearest-cell whose nearest can flip on a
 * boundary: one ulp is the difference between this cell and the one beside it,
 * and with it a different cluster, a different pop and a different score. The
 * honest player who submitted that score would then be refused.
 *
 * The engine therefore contains **no trig calls at all**: the angle of every
 * shot and of every landing-ray is looked up in {@link SIN_TABLE},
 * {@link COS_TABLE}, {@link RAY_SIN} and {@link RAY_COS} — literals baked once
 * from `Math.sin`/`Math.cos` of the exact angles the step can hold, written
 * with shortest-round-trip digits (the same precision `JSON.stringify` uses),
 * so every engine parses them back to the identical double. The harness
 * (`scripts/ravenBubblesReplayTest.mjs`) re-derives each entry with its own
 * `Math.sin` and fails if a table entry has drifted more than a few ulp.
 *
 * ## Why the difficulty rides on the runtime
 *
 * The same reason as Frogger's, Tetris's and Goblin Invaders': the replay
 * parks its match in D1 between chunks, possibly across UTC midnight, and the
 * win check inside `resolveShot` must use the target the run was *played*
 * under. `createRuntime` bakes it in; the worker validates the claimed
 * difficulty *name* (today's or yesterday's) before building the runtime, so
 * "always claim easy" buys nothing.
 *
 * ## The clock lives in the step
 *
 * The cabinet runs two pressure triggers on one drop: every
 * {@link SHOTS_PER_DROP} shots, and every {@link CEILING_SECONDS} seconds
 * regardless (otherwise sitting still is a strategy). Live, the second one was
 * a wall-clock `setInterval` — time the replay cannot see. It is now a
 * millisecond budget (`ceilingMs`) decremented by the step's own `dtMs`, and
 * 30 000 ms divides by the 16 ms step exactly (1 875 steps), so the drop lands
 * on the same tick on both ends with no drift. The original's quirks are
 * transcribed: the drop only ever applies while the player is *aiming* (a
 * mid-flight expiry resets the clock and skips the drop rather than deferring
 * it), and the shot-counter drop inside a resolution resets the clock too.
 *
 * ## The input byte: one per 16 ms step
 *
 * Two input paths — pointer/touch (aim at an angle, click or lift to fire) and
 * keyboard (arrows nudge the aim, Space fires) — both fit in the one-byte-per-
 * step log the chunk machinery counts and slices (`CHUNK_TICKS` bytes = one
 * window, end to end). The whole byte is:
 *
 *  - **bit 7** — fire pressed this step (consumed once per step, and ignored
 *    by `tick` exactly where the live `shoot()` early-returned: while a shot
 *    is already in flight, or once the run has ended).
 *  - **bits 0–6** — the aim as one of 128 levels across `[-1.15, 1.15]`
 *    radians, about 0.018 rad apart (≈ 5 px of landing at cluster distance).
 *
 * The engine re-quantises `input.aim` inside `tick` before it is used for
 * anything, so the client's raw pointer angle and the replay's decoded
 * level-derived angle always take the *same* step — quantisation is a property
 * of the engine, not of the transport, and the byte is a pure round trip of
 * what the step ran under.
 *
 * ## Step rate
 *
 * `FIXED_STEP_MS = 16` — the closest whole millisecond to the ~16.7 ms frame
 * the old variable-`dt` flight loop ran at on a 60 Hz display, so the game
 * plays at its old pace, and unlike the old loop it now plays at *the same*
 * pace on 60, 120 or 144 Hz hardware. At 62.5 steps/second a run fits
 * comfortably inside the shared `MAX_REPLAY_TICKS` ceiling (64 000 ≈ 17
 * minutes of continuous play).
 */

import {
  COLS,
  INITIAL_ROWS,
  POINTS_PER_DROP,
  POINTS_PER_POP,
  RavenBubblesDifficulty,
} from "./session";

// ─────────────────────────────────────────────────────────────────────────────
// Board geometry (also imported by the component for drawing — one constant,
// one meaning)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A hex grid: every row holds `COLS` bubbles and odd rows are shifted half a
 * bubble to the right, which is what makes the cluster maths (and the look)
 * the original game's.
 */
export const MAX_ROWS = 13;
export const RADIUS = 18;
export const DIAMETER = RADIUS * 2;
export const ROW_HEIGHT = RADIUS * Math.sqrt(3);
/**
 * The ceiling slab, drawn in a band above row 0 so it is always visible.
 *
 * The grid has to start below it, or the slab would render off the top of the
 * playfield and be clipped away — which is how the ceiling came to be
 * invisible in the first place.
 */
export const CEILING_THICKNESS = 12;
/** One radius wider than `COLS` bubbles so the shifted odd rows still fit. */
export const PLAYFIELD_WIDTH = COLS * DIAMETER + RADIUS;
export const PLAYFIELD_HEIGHT = 470 + CEILING_THICKNESS;
export const SHOOTER_X = PLAYFIELD_WIDTH / 2;
export const SHOOTER_Y = PLAYFIELD_HEIGHT - 32;
/** A bubble resting on this row has crossed the line and ends the run. */
export const DANGER_ROW = 11;
/** Longest the dotted aim guide is drawn, in px. */
export const MAX_GUIDE_PX = 240;
/** Shots before the ceiling drops a row — the original's pressure valve. */
export const SHOTS_PER_DROP = 15;
/**
 * The clock budget behind the *second* trigger on the same drop: the step
 * carries it in whole milliseconds, and 30 000 / 16 = 1 875 steps exactly, so
 * the drop lands on the same tick on both ends.
 */
export const CEILING_SECONDS = 30;
export const CEILING_MS = CEILING_SECONDS * 1000;
export const SHOT_SPEED = 950;
/** Longest a single physics substep may travel, in px. See the flight step. */
export const MAX_STEP_PX = 5;
/** Aim is measured from straight up, in radians. */
const MIN_AIM = -1.15;
const MAX_AIM = 1.15;
/** The aim quantisation the input byte carries: 128 levels, ends included. */
const AIM_LEVELS = 127;
const AIM_STEP = (MAX_AIM - MIN_AIM) / AIM_LEVELS;
/** Centre-ish level: what `quantizeAim(0)` rounds to at run-open. */
const AIM_CENTER = Math.round((0 - MIN_AIM) / AIM_STEP);
export const MIN_CLUSTER = 3;

/** The shared step — see the header. */
export const FIXED_STEP_MS = 16;

// ─────────────────────────────────────────────────────────────────────────────
// Bubbles and the field
// ─────────────────────────────────────────────────────────────────────────────

export type BubbleColor =
  | "Sunflower"
  | "Carrot"
  | "Pumpkin"
  | "Potato"
  | "Corn"
  | "Wheat";

const BUBBLE_COLORS: BubbleColor[] = [
  "Sunflower",
  "Carrot",
  "Pumpkin",
  "Potato",
  "Corn",
  "Wheat",
];

type Cell = BubbleColor | null;
/**
 * A grid row-major. Treated as **immutable** once built — every resolution
 * copies before it writes — which is what lets `completableColours` memoise by
 * object identity (see its note) and what lets a JSON park round trip between
 * chunks stand in for the live value.
 */
type Grid = Cell[][];

type Shot = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: BubbleColor;
};

export type TickInput = {
  /** Aim in radians (raw; the step quantises it — see the header). */
  aim: number;
  /** Fire pressed this step (click / touch-lift / Space), consumed once. */
  fire: boolean;
};

export type RavenBubblesRuntime = {
  /** The difficulty this run is being played under — see the header. */
  difficulty: RavenBubblesDifficulty;
  /** The seed `active_runs` issued — the only thing that feeds the stream. */
  seed: number;
  /** The RNG stream's position — advanced by `advanceRng`, never a clock. */
  rngState: number;
  grid: Grid;
  score: number;
  /** Shots left before the shot-counter drops the ceiling a row. */
  shotsLeft: number;
  /** Grid row the ceiling is currently resting on; it drops one at a time. */
  ceilingRow: number;
  /** Milliseconds left on the clock trigger; refilled by either drop. */
  ceilingMs: number;
  /** Aim as a quantised level 0..127 — the byte's payload. */
  aimLevel: number;
  /** The bubble in the shooter and the one queued behind it. */
  current: BubbleColor;
  next: BubbleColor;
  /** In flight, else `null` (which is also "the player is aiming"). */
  shot: Shot | null;
  gameOver: boolean;
  won: boolean;
  /** Empty until the run settles; see `resolveShot` for the four endings. */
  reason: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every other row is shifted half a bubble to the right — the hex packing.
 *
 * The shift is measured **from the ceiling**, not from an absolute row number.
 * That is the whole trick behind a ceiling drop: every row moves down by one,
 * and if the stagger were absolute then every row would also flip parity and
 * the entire cluster would jump sideways by half a bubble. Measuring from the
 * ceiling means `(row - ceilingRow)` is unchanged by a drop and the cluster
 * descends as one rigid body, which is what the original does.
 */
export const isStaggered = (row: number, ceilingRow: number) =>
  (((row - ceilingRow) % 2) + 2) % 2 === 1;

export const cellX = (row: number, col: number, ceilingRow: number) =>
  RADIUS + col * DIAMETER + (isStaggered(row, ceilingRow) ? RADIUS : 0);
export const cellY = (row: number) =>
  CEILING_THICKNESS + RADIUS + row * ROW_HEIGHT;

/** The bottom of row 11 — the line the cluster must not reach. */
export const DANGER_LINE_Y = cellY(DANGER_ROW) + RADIUS;

/**
 * The underside of the ceiling slab.
 *
 * The ceiling is a solid the shot bounces off, not just the row the
 * floating-bubbles check happens to anchor to. Without this the shot flew on up
 * past the real ceiling into the space behind it and bounced around up there
 * where nothing could ever reach it.
 */
export const ceilingLimitY = (ceilingRow: number) =>
  cellY(ceilingRow) - RADIUS;

/** The six hex neighbours of a cell, given the stagger from the ceiling. */
function neighbours(
  row: number,
  col: number,
  ceilingRow: number,
): [number, number][] {
  const deltas: [number, number][] = isStaggered(row, ceilingRow)
    ? [
        [0, -1],
        [0, 1],
        [-1, 0],
        [-1, 1],
        [1, 0],
        [1, 1],
      ]
    : [
        [0, -1],
        [0, 1],
        [-1, -1],
        [-1, 0],
        [1, -1],
        [1, 0],
      ];

  return deltas
    .map(([dr, dc]) => [row + dr, col + dc] as [number, number])
    .filter(([r, c]) => r >= 0 && r < MAX_ROWS && c >= 0 && c < COLS);
}

/**
 * Every empty cell a new bubble could land in: the row the ceiling is
 * currently sitting on, plus the empty cells touching an existing bubble.
 */
function snapCandidates(grid: Grid, ceilingRow: number): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];

  const push = (row: number, col: number) => {
    if (row < 0 || row >= MAX_ROWS || col < 0 || col >= COLS) return;
    // Above the ceiling slab is solid: no bubble can come to rest up there.
    if (row < ceilingRow) return;
    if (grid[row][col]) return;
    const key = `${row},${col}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([row, col]);
  };

  for (let col = 0; col < COLS; col++) push(ceilingRow, col);

  for (let row = 0; row < MAX_ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!grid[row][col]) continue;
      for (const neighbour of neighbours(row, col, ceilingRow)) push(...neighbour);
    }
  }

  return out;
}

/** The empty cell closest to a point — where a shot that hit something lands. */
export function nearestEmptyCell(
  grid: Grid,
  x: number,
  y: number,
  ceilingRow: number,
): [number, number] | null {
  let best: [number, number] | null = null;
  let bestDistance = Infinity;

  for (const [row, col] of snapCandidates(grid, ceilingRow)) {
    const dx = cellX(row, col, ceilingRow) - x;
    const dy = cellY(row) - y;
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = [row, col];
    }
  }

  return best;
}

/** Flood fill of the same-colour cluster a cell belongs to. */
export function clusterOf(
  grid: Grid,
  row: number,
  col: number,
  ceilingRow: number,
): [number, number][] {
  const color = grid[row]?.[col];
  if (!color) return [];

  const seen = new Set<string>([`${row},${col}`]);
  const stack: [number, number][] = [[row, col]];
  const cluster: [number, number][] = [];

  while (stack.length) {
    const [r, c] = stack.pop()!;
    cluster.push([r, c]);

    for (const [nr, nc] of neighbours(r, c, ceilingRow)) {
      const key = `${nr},${nc}`;
      if (seen.has(key) || grid[nr][nc] !== color) continue;
      seen.add(key);
      stack.push([nr, nc]);
    }
  }

  return cluster;
}

/**
 * Bubbles no longer connected to the ceiling — they fall.
 *
 * `ceilingRow` is the row the ceiling is currently resting on, which moves down
 * one row every time the ceiling drops. Anchoring on row 0 instead would read a
 * post-drop board as nothing-but-floating and drop the whole cluster.
 */
export function floatingCells(grid: Grid, ceilingRow: number): [number, number][] {
  const anchored = new Set<string>();
  const stack: [number, number][] = [];

  for (let col = 0; col < COLS; col++) {
    if (grid[ceilingRow]?.[col]) {
      anchored.add(`${ceilingRow},${col}`);
      stack.push([ceilingRow, col]);
    }
  }

  while (stack.length) {
    const [row, col] = stack.pop()!;
    for (const [nr, nc] of neighbours(row, col, ceilingRow)) {
      const key = `${nr},${nc}`;
      if (anchored.has(key) || !grid[nr][nc]) continue;
      anchored.add(key);
      stack.push([nr, nc]);
    }
  }

  const floating: [number, number][] = [];
  for (let row = 0; row < MAX_ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (grid[row][col] && !anchored.has(`${row},${col}`)) {
        floating.push([row, col]);
      }
    }
  }

  return floating;
}

const coloursOnBoard = (grid: Grid): BubbleColor[] => {
  const present = new Set<BubbleColor>();
  for (const row of grid) {
    for (const cell of row) {
      if (cell) present.add(cell);
    }
  }
  return BUBBLE_COLORS.filter((color) => present.has(color));
};

/** How many bubbles of one colour the board is holding. */
function countOnBoard(grid: Grid, color: BubbleColor): number {
  let total = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (cell === color) total++;
    }
  }
  return total;
}

export const touchesBubble = (
  grid: Grid,
  x: number,
  y: number,
  ceilingRow: number,
): boolean => {
  const reach = DIAMETER - 2;
  for (let row = 0; row < MAX_ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!grid[row][col]) continue;
      const dx = cellX(row, col, ceilingRow) - x;
      const dy = cellY(row) - y;
      if (dx * dx + dy * dy < reach * reach) return true;
    }
  }
  return false;
};

/**
 * Shift the whole cluster down one row.
 *
 * The caller moves the ceiling with it. The hex stagger is measured from the
 * ceiling ({@link isStaggered}), so descending does not also slide the cluster
 * sideways — it moves as one piece, which is the whole reason the stagger is
 * relative.
 */
const dropCeilingOnce = (grid: Grid): Grid => {
  const shifted = emptyGrid();
  for (let row = 0; row < MAX_ROWS - 1; row++) {
    for (let col = 0; col < COLS; col++) {
      shifted[row + 1][col] = grid[row][col];
    }
  }
  return shifted;
};

/** Has anything come to rest on or below the line? */
const hasCrossedTheLine = (grid: Grid): boolean =>
  grid.some((row, rowIndex) => rowIndex >= DANGER_ROW && row.some(Boolean));

/** Is the field completely empty? */
const isBoardEmpty = (grid: Grid): boolean =>
  grid.every((row) => row.every((cell) => cell === null));

const emptyGrid = (): Grid =>
  Array.from({ length: MAX_ROWS }, () => Array<Cell>(COLS).fill(null));

// ─────────────────────────────────────────────────────────────────────────────
// The aim quantisation and the baked trig tables
// ─────────────────────────────────────────────────────────────────────────────

/** Clamp an aim angle to the range the shooter can actually hold. */
export const clampAim = (angle: number) =>
  Math.min(MAX_AIM, Math.max(MIN_AIM, angle));

/** The exact radians of an aim level — the render's, and `decodeTick`'s. */
export const levelToAim = (level: number) => MIN_AIM + level * AIM_STEP;

/**
 * The angle of a step's input as one of the 128 levels the byte can carry.
 *
 * Applied *inside* `tick` before the aim is used for anything, so a raw
 * pointer angle on the client and the decoded level on the worker always take
 * the same step — see the header.
 */
export const quantizeAim = (angle: number): number => {
  if (!Number.isFinite(angle)) return AIM_CENTER;
  const level = Math.round((clampAim(angle) - MIN_AIM) / AIM_STEP);
  return Math.min(AIM_LEVELS, Math.max(0, level));
};

/**
 * `Math.sin` of every aim level, baked.
 *
 * No `Math.sin` call exists in this file — see the header. Generated once as
 * shortest-round-trip decimal, which parses back to the exact same double on
 * every engine. Regenerate only alongside `COS_TABLE` and the harness's
 * table check, which re-derives these against its own `Math.sin`.
 */
const SIN_TABLE: number[] = [
  -0.912763940260521, -0.9052168602289755, -0.8973728946923496, -0.889234616249291,
  -0.8808046940247487, -0.8720858927945763, -0.8630810720787636, -0.8537931852035952,
  -0.8442252783330421, -0.8343804894697079, -0.8242620474256512, -0.8138732707634275,
  -0.8032175667076942, -0.7922984300277376, -0.7811194418912875, -0.7696842686899953,
  -0.7579966608369618, -0.7460604515367074, -0.7338795555279899, -0.7214579677998805,
  -0.7087997622815211, -0.6959090905059907, -0.6827901802487195, -0.669447334140899,
  -0.6558849282583404, -0.6421074106862457, -0.6281193000603615, -0.6139251840849947,
  -0.5995297180283752, -0.5849376231958594, -0.5701536853814763, -0.555182753298322,
  -0.5400297369883196, -0.5246996062118637, -0.5091973888178805, -0.4935281690948349,
  -0.4776970861032285, -0.46170933199013287, -0.44557015028631214, -0.4292848341864938,
  -0.41285872481335045, -0.3962972094657625, -0.37960571985193703, -0.36278973030796097,
  -0.3458547560023743, -0.32880635112735007, -0.31165010707707747, -0.2943916506139424,
  -0.27703664202310846, -0.25959077325610425, -0.2420597660640239, -0.22444937012095478,
  -0.20676536113824734, -0.1890135389702453, -0.17119972571209713, -0.15332976379027427,
  -0.1354095140464205, -0.1174448538151611, -0.09944167499650491, -0.08140588212346635,
  -0.0633433904255464, -0.045260123888705525, -0.02716201331246254, -0.009054994364761,
  0.009054994364761221, 0.02716201331246254, 0.04526012388870575, 0.06334339042554663,
  0.08140588212346635, 0.09944167499650514, 0.11744485381516132, 0.1354095140464205,
  0.1533297637902745, 0.1711997257120972, 0.1890135389702453, 0.20676536113824756,
  0.2244493701209549, 0.2420597660640239, 0.25959077325610447, 0.27703664202310857,
  0.2943916506139426, 0.3116501070770777, 0.3288063511273502, 0.3458547560023745,
  0.3627897303079612, 0.3796057198519371, 0.39629720946576275, 0.4128587248133506,
  0.42928483418649394, 0.44557015028631236, 0.4617093319901329, 0.47769708610322853,
  0.49352816909483505, 0.5091973888178806, 0.5246996062118637, 0.5400297369883198,
  0.5551827532983221, 0.5701536853814764, 0.5849376231958595, 0.5995297180283753,
  0.6139251840849947, 0.6281193000603617, 0.6421074106862458, 0.6558849282583404,
  0.6694473341408991, 0.6827901802487195, 0.6959090905059907, 0.7087997622815213,
  0.7214579677998806, 0.7338795555279899, 0.7460604515367075, 0.757996660836962,
  0.7696842686899953, 0.7811194418912876, 0.7922984300277378, 0.8032175667076942,
  0.8138732707634276, 0.8242620474256515, 0.8343804894697079, 0.8442252783330422,
  0.8537931852035953, 0.8630810720787636, 0.8720858927945764, 0.8808046940247488,
  0.889234616249291, 0.8973728946923497, 0.9052168602289755, 0.912763940260521,
];

/** `Math.cos` of every aim level — baked on the same terms as `SIN_TABLE`. */
const COS_TABLE: number[] = [
  0.4084874408841574, 0.4249499217051293, 0.4412730309813565, 0.4574514151950742,
  0.47347976829424165, 0.4893528334327766, 0.5050654046946513, 0.5206123288012872,
  0.5359885068016829, 0.5511888957447262, 0.56620851033314, 0.5810424245585176,
  0.5956857733169147, 0.610133754004466, 0.6243816280925021, 0.6384247226816542,
  0.6522584320344321, 0.6658782190857757, 0.6792796169310839, 0.6924582302912332,
  0.7054097369541047, 0.7181298891921467, 0.7306145151555101, 0.7428595202402966,
  0.7548608884314723, 0.7666146836200081, 0.7781170508938109, 0.7893642178020266,
  0.8003524955922965, 0.8110782804205638, 0.821538054533033, 0.8317283874198923,
  0.8416459369404253, 0.8512874504191373, 0.8606497657125413, 0.8697298122462516,
  0.878524612022045, 0.8870312805945602, 0.8952470280173139, 0.9031691597577247,
  0.9107950775808432, 0.9181222804014995, 0.9251483651045883, 0.9318710273332232,
  0.9382880622444997, 0.9443973652326216, 0.9501969326191525, 0.9556848623101647,
  0.9608593544200733, 0.9657187118619468, 0.9702613409041041, 0.9744857516928129,
  0.9783905587409203, 0.9819744813822524, 0.9852363441916374, 0.9881750773704114,
  0.990789717097282, 0.9930794058444347, 0.9950433926587772, 0.9966810334082316,
  0.9979917909929905, 0.9989752355216714, 0.9996310444523088, 0.9999590026981376,
  0.9999590026981376, 0.9996310444523088, 0.9989752355216714, 0.9979917909929905,
  0.9966810334082316, 0.9950433926587772, 0.9930794058444347, 0.990789717097282,
  0.9881750773704114, 0.9852363441916374, 0.9819744813822524, 0.9783905587409202,
  0.9744857516928129, 0.9702613409041041, 0.9657187118619468, 0.9608593544200733,
  0.9556848623101646, 0.9501969326191524, 0.9443973652326216, 0.9382880622444997,
  0.9318710273332231, 0.9251483651045883, 0.9181222804014993, 0.9107950775808431,
  0.9031691597577247, 0.8952470280173138, 0.88703128059456, 0.878524612022045,
  0.8697298122462515, 0.8606497657125413, 0.8512874504191372, 0.8416459369404252,
  0.8317283874198922, 0.8215380545330329, 0.8110782804205637, 0.8003524955922964,
  0.7893642178020266, 0.7781170508938108, 0.766614683620008, 0.7548608884314723,
  0.7428595202402964, 0.7306145151555101, 0.7181298891921467, 0.7054097369541046,
  0.6924582302912332, 0.6792796169310839, 0.6658782190857755, 0.6522584320344319,
  0.6384247226816542, 0.624381628092502, 0.6101337540044657, 0.5956857733169147,
  0.5810424245585174, 0.5662085103331397, 0.5511888957447262, 0.5359885068016828,
  0.5206123288012869, 0.5050654046946513, 0.4893528334327764, 0.47347976829424143,
  0.4574514151950742, 0.44127303098135634, 0.4249499217051291, 0.4084874408841574,
];

/**
 * `Math.sin` of each of the 45 ray angles {@link landingCells} traces, baked on
 * the same terms as the aim tables — the ray grid (`-MAX_AIM + (ray / 44) *
 * (MAX_AIM * 2)`) is a different set of angles from the aim levels, and the
 * queue's weighting depends on exactly where those rays land.
 */
const RAY_SIN: number[] = [
  -0.912763940260521, -0.8901741590020407, -0.865152585832553, -0.8377675750831952,
  -0.8080939375614365, -0.7762127361817257, -0.7422110645165331, -0.706181808872746,
  -0.6682233945433793, -0.6284395169277966, -0.5869388582549705, -0.5438347906836426,
  -0.49924506659045886, -0.4532914968921566, -0.4060996182805667, -0.3577983502794836,
  -0.3085196430602626, -0.2583981169782454, -0.2075706948147335, -0.1561762277291601,
  -0.10435511594328536, -0.05224892519364066, 0, 0.05224892519364066,
  0.10435511594328536, 0.15617622772916032, 0.20757069481473372, 0.2583981169782455,
  0.30851964306026247, 0.35779835027948337, 0.4060996182805665, 0.4532914968921567,
  0.49924506659045886, 0.5438347906836426, 0.5869388582549705, 0.6284395169277966,
  0.6682233945433794, 0.7061818088727461, 0.7422110645165332, 0.7762127361817258,
  0.8080939375614365, 0.8377675750831952, 0.865152585832553, 0.8901741590020407,
  0.912763940260521,
];

/** `Math.cos` of the ray angles — baked on the same terms as `RAY_SIN`. */
const RAY_COS: number[] = [
  0.4084874408841574, 0.4556204194776719, 0.5015087269701766, 0.5460270049541716,
  0.5890536376905359, 0.6304710843403357, 0.6701662000647561, 0.7080305451159692,
  0.74396068107456, 0.7778584534242445, 0.8096312596919363, 0.8391923024206541,
  0.8664608262841941, 0.8913623386958123, 0.9138288133082574, 0.9337988758492269,
  0.951217971784579, 0.9660385153512757, 0.9782200195529269, 0.9877292067628098,
  0.9945400996322187, 0.9986340920557987, 1, 0.9986340920557987,
  0.9945400996322187, 0.9877292067628098, 0.9782200195529269, 0.9660385153512757,
  0.951217971784579, 0.933798875849227, 0.9138288133082575, 0.8913623386958123,
  0.8664608262841941, 0.8391923024206541, 0.8096312596919363, 0.7778584534242445,
  0.7439606810745599, 0.7080305451159691, 0.670166200064756, 0.6304710843403356,
  0.5890536376905358, 0.5460270049541716, 0.5015087269701766, 0.4556204194776719,
  0.4084874408841574,
];

// ─────────────────────────────────────────────────────────────────────────────
// The RNG stream
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One step of the run's RNG stream: a mulberry32 advance.
 *
 * Integer ops throughout (imul, xor, shift, or, + — all pinned bit-for-bit by
 * IEEE 754 / ECMAScript on every engine), with the single `/ 2^32` that turns
 * the mixed word into `[0, 1)`. The state travels on the runtime like
 * `rngState` does in Goblin Invaders' engine, so a JSON park round trip resumes
 * the stream exactly where the client left it.
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
// The queue: which colour the shooter hands out next
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The cells a shot can actually come to rest in.
 *
 * Traced from the shooter, bouncing off the walls exactly as a real shot does.
 * "Can this colour pop" is only worth asking if the player has an angle that
 * lands the bubble beside the pair — a triple buried in the middle of the
 * cluster is not a play, it is a coincidence, and offering it as one hands out
 * dead bubbles.
 *
 * The per-step hit test walks a flat list of the bubbles' centres built once
 * above the rays, rather than re-scanning the whole grid for every 4 px step as
 * the original did — same boolean, same first-hit point (the scan order only
 * ever decided *whether* something was hit, never *when*), a fraction of the
 * work: this runs on the worker inside a 10 ms request budget, twice a shot.
 */
function landingCells(grid: Grid, ceilingRow: number): Set<string> {
  const cells = new Set<string>();
  const RAYS = 44;

  const occupied: number[] = [];
  for (let row = 0; row < MAX_ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!grid[row][col]) continue;
      occupied.push(cellX(row, col, ceilingRow), cellY(row));
    }
  }
  const reach = (DIAMETER - 2) * (DIAMETER - 2);

  for (let ray = 0; ray <= RAYS; ray++) {
    let x = SHOOTER_X;
    let y = SHOOTER_Y;
    let dx = RAY_SIN[ray];
    let dy = -RAY_COS[ray];

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
      let hitBubble = false;

      if (!hitCeiling) {
        for (let index = 0; index < occupied.length && !hitBubble; index += 2) {
          const bx = occupied[index] - x;
          const by = occupied[index + 1] - y;
          if (bx * bx + by * by < reach) hitBubble = true;
        }
      }

      if (hitCeiling || hitBubble) {
        const cell = nearestEmptyCell(grid, x, y, ceilingRow);
        if (cell) cells.add(cell[0] + "," + cell[1]);
        break;
      }
    }
  }

  return cells;
}

/**
 * Colours the player could actually complete with the shot they are holding.
 *
 * Walks the cells {@link landingCells} can reach and asks, for each colour still
 * on the board, whether putting it there would pop.
 */
//
// One-entry memo, keyed by the grid's identity. Grids are immutable in this
// engine (every write copies first — see `Grid`), so identity pins content,
// and one shot resolution asks this same question about the same board twice:
// once to decide the incoming colour and once to deal the one behind it. Live,
// the pair cost two full ray-traces apiece — a visible hitch in the resolver
// and a blown chunk budget on the worker. A JSON park round trip mints a new
// grid object and simply misses, which is correct: only reuse within one
// board's lifetime was ever asked for.
let completableMemoGrid: Grid | null = null;
let completableMemoCeiling = -1;
let completableMemo: BubbleColor[] | null = null;

function completableColours(grid: Grid, ceilingRow: number): BubbleColor[] {
  if (
    completableMemo !== null &&
    completableMemoGrid === grid &&
    completableMemoCeiling === ceilingRow
  ) {
    return completableMemo;
  }

  const present = coloursOnBoard(grid);
  const found = new Set<BubbleColor>();

  for (const key of landingCells(grid, ceilingRow)) {
    const [row, col] = key.split(",").map(Number);

    for (const color of present) {
      if (found.has(color)) continue;

      const scratch = grid.map((line) => [...line]);
      scratch[row][col] = color;
      if (clusterOf(scratch, row, col, ceilingRow).length >= MIN_CLUSTER) {
        found.add(color);
      }
    }
  }

  const result = present.filter((color) => found.has(color));
  completableMemoGrid = grid;
  completableMemoCeiling = ceilingRow;
  completableMemo = result;
  return result;
}

/**
 * The colour the shooter hands out next.
 *
 * Restricted to colours that are actually on the board (a colour nothing else
 * uses is a wasted shot), and then weighted towards the ones the player can act
 * on right now.
 *
 * The weighting is deliberately not exclusive. A colour with one or two bubbles
 * left can never complete a triple by itself, so a pool of only playable colours
 * strands it for good: it can never be matched, so it can never be cleared, and
 * the ceiling eventually wins the run. Every colour still on the board stays in
 * the pool at roughly a quarter of the weight, which keeps a lone bubble
 * reachable without handing out dead shots most of the time.
 *
 * Without any bias at all the cabinet is unwinnable rather than merely hard, so
 * this is the compromise: playable colours dominate the queue, and nothing on
 * the board is ever stranded by it.
 */
function pickNextColor(
  grid: Grid,
  ceilingRow: number,
  roll: () => number,
  exclude?: BubbleColor,
): BubbleColor {
  const present = coloursOnBoard(grid).filter((color) => color !== exclude);

  if (present.length === 0) {
    return BUBBLE_COLORS[Math.floor(roll() * BUBBLE_COLORS.length)];
  }

  const live = completableColours(grid, ceilingRow).filter((color) =>
    present.includes(color),
  );

  // Colours that cannot complete themselves carry the same weight as playable
  // ones. Fewer than MIN_CLUSTER bubbles of a colour on the board means the
  // queue can never complete it alone, so it is exactly the colour that would
  // otherwise sit there forever while the ceiling closes in — the lone Corn of
  // the original report. Dealing it on a par with a playable colour is what
  // guarantees the loop closes: two of them make a pair, the third pops it.
  const stranded = present.filter(
    (color) => countOnBoard(grid, color) < MIN_CLUSTER && !live.includes(color),
  );

  const pool = [
    ...live,
    ...live,
    ...live,
    ...stranded,
    ...stranded,
    ...stranded,
    ...present,
  ];

  return pool[Math.floor(roll() * pool.length)];
}

/**
 * A fresh board, used for the opening deal and for every refill.
 *
 * Dealt in small clumps — one or two bubbles of a colour at a time — so the
 * board is full of loose singles and pairs and the player assembles the three
 * themselves. That is the actual game: bigger clumps hand out free triples, the
 * cluster never grows a floor, and the ceiling never gets to matter.
 *
 * Clumping at all, even this little, is load-bearing. Filling cell-by-cell at
 * random does not work either: with six colours the chance that any given cell
 * and two of its neighbours agree is 1 in 36, so a board of fifty contains
 * roughly one accidental triplet — and a board with no triplets in it has no
 * plays at all. Every shot then just snaps a bubble onto the floor of the
 * cluster and pushes it down a row, and the line is crossed within ten shots no
 * matter how well the player aims. Pairs are enough: one lands against the pair
 * and makes the three.
 */
function createBoard(roll: () => number): Grid {
  const grid = emptyGrid();
  const inDeal = (row: number, col: number) =>
    row >= 0 && row < INITIAL_ROWS && col >= 0 && col < COLS;

  for (let row = 0; row < INITIAL_ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (grid[row][col]) continue;

      const color = BUBBLE_COLORS[Math.floor(roll() * BUBBLE_COLORS.length)];
      // One or two. Bigger clumps hand the player free triples and the run turns
      // into a formality — every shot pops, the cluster never grows a floor, and
      // the ceiling never gets to matter. At one or two, the board is made of
      // loose singles and pairs and the player has to build the three themselves,
      // which is the actual game.
      const size = 1 + Math.floor(roll() * 2);

      grid[row][col] = color;
      const candidates = neighbours(row, col, 0).filter(
        ([r, c]) => inDeal(r, c) && !grid[r][c],
      );

      // Grow the clump one cell at a time, so it stays compact instead of
      // trailing off in a line.
      for (let placed = 1; placed < size && candidates.length > 0; placed++) {
        const index = Math.floor(roll() * candidates.length);
        const [r, c] = candidates.splice(index, 1)[0];
        if (grid[r][c]) continue;

        grid[r][c] = color;
        for (const [nr, nc] of neighbours(r, c, 0)) {
          if (inDeal(nr, nc) && !grid[nr][nc]) candidates.push([nr, nc]);
        }
      }
    }
  }

  return grid;
}

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a fresh run at `difficulty`, dealing its first rolls from `seed`.
 *
 * The same call the component makes at run-open and the worker's replay makes
 * at claim: the difficulty is copied onto the runtime, the seed both ends read
 * from `active_runs` seeds one shared stream, and the board, the incoming
 * colour and the queued colour are all dealt from it — so two ends that never
 * see each other's clocks still produce the same game.
 */
export const createRuntime = (
  difficulty: RavenBubblesDifficulty,
  seed: number,
): RavenBubblesRuntime => {
  let rngState = seed >>> 0;
  const roll = () => {
    const next = advanceRng(rngState);
    rngState = next.state;
    return next.value;
  };

  const grid = createBoard(roll);
  const current = pickNextColor(grid, 0, roll);
  const next = pickNextColor(grid, 0, roll);

  return {
    difficulty,
    seed: seed >>> 0,
    rngState,
    grid,
    score: 0,
    shotsLeft: SHOTS_PER_DROP,
    ceilingRow: 0,
    ceilingMs: CEILING_MS,
    aimLevel: quantizeAim(0),
    current,
    next,
    shot: null,
    gameOver: false,
    won: false,
    // Present from the first tick so the runtime's key set never changes —
    // see the note on `reason` in `resolveShot`.
    reason: "",
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// The input byte
// ─────────────────────────────────────────────────────────────────────────────

/** Bit 7: the fire press (click / touch-lift / Space), consumed once. */
const FIRE_BIT = 0x80;

/**
 * Pack one step's input into its log byte. See the header for the layout:
 * `fire | aimLevel`, every value 0..255 legal.
 */
export const encodeTick = (input: TickInput): number =>
  (input.fire ? FIRE_BIT : 0) | quantizeAim(input.aim);

/**
 * Decode one log byte, or `null` for a value that is not a byte at all.
 *
 * Every byte 0..255 is an input the client can write (the layout has no
 * reserved region — fire owns bit 7, the aim owns the rest), so the worker's
 * protocol scan never refuses a *log* byte; the guard here is for values
 * outside the encoding that no `Uint8Array` could have carried anyway.
 */
export const decodeTick = (byte: number): TickInput | null => {
  if (!Number.isInteger(byte) || byte < 0 || byte > 255) return null;
  return { aim: levelToAim(byte & 0x7f), fire: (byte & FIRE_BIT) !== 0 };
};

// ─────────────────────────────────────────────────────────────────────────────
// Settling a shot (was the component's `resolveShot` closure)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Settle a shot that has hit the ceiling or a bubble: snap it into the grid,
 * pop any cluster it completed, drop whatever that left floating, apply the
 * ceiling drop, then decide whether the run is still alive.
 *
 * Transcribed from the original closure in the order it wrote, quirks
 * included: the queue is dealt (`current`/`next`, rolls and all) *before* the
 * win/loss decision — even on the resolving shot, and even when the win means
 * nobody will hold that colour — and a cleared screen deals a fresh board
 * before either. `prev.shot` is already null; `prev` carries this step's
 * clock, aim and (possibly drop-shifted) ceiling.
 *
 * `rngState` is *not* rolled here: the rolls go through the caller's `roll`
 * closure, and the caller writes the advanced state onto the result — so the
 * stream advances exactly once per roll regardless of which branch settles.
 *
 * The four endings, each setting `gameOver` with `reason` from one place:
 * nowhere to land, target score reached, bubbles crossed the line, and "still
 * playing" (`reason` back to the empty string, keeping the key set — and the
 * JSON shape the park round trips — identical for the run's whole life).
 */
const resolveShot = (
  prev: RavenBubblesRuntime,
  x: number,
  y: number,
  color: BubbleColor,
  roll: () => number,
): RavenBubblesRuntime => {
  const ceiling = prev.ceilingRow;
  const landed = nearestEmptyCell(prev.grid, x, y, ceiling);

  // Nowhere to land means the field is full — the line has effectively been
  // crossed, so the run is over.
  if (!landed) {
    return {
      ...prev,
      gameOver: true,
      won: false,
      reason: "Nowhere left to land.",
    };
  }

  let working = prev.grid.map((row) => [...row]);
  working[landed[0]][landed[1]] = color;

  let gained = 0;

  const cluster = clusterOf(working, landed[0], landed[1], ceiling);
  if (cluster.length >= MIN_CLUSTER) {
    for (const [row, col] of cluster) working[row][col] = null;
    gained += cluster.length * POINTS_PER_POP;
  }

  const floating = floatingCells(working, ceiling);
  if (floating.length > 0) {
    for (const [row, col] of floating) working[row][col] = null;
    gained += floating.length * POINTS_PER_DROP;
  }

  const newScore = prev.score + gained;
  const remainingShots = prev.shotsLeft - 1;
  const dropCeiling = remainingShots <= 0;

  let ceilingRow = ceiling;
  let ceilingMs = prev.ceilingMs;

  if (dropCeiling) {
    working = dropCeilingOnce(working);
    ceilingRow = ceiling + 1;
    ceilingMs = CEILING_MS;
  }

  const crossedLine = hasCrossedTheLine(working);
  const cleared = isBoardEmpty(working);

  // A cleared screen is a stage complete: the next is dealt with the ceiling
  // back at the top, so a run is a chain of screens rather than one long slide
  // toward the line. The run is won on **points** — the target is set outright
  // per difficulty in `session`, and because drops pay double a player can
  // reach it well before the screens are used up.
  const won = newScore >= prev.difficulty.targetScore;

  const finalGrid = cleared ? createBoard(roll) : working;

  let shotsLeft: number;
  if (cleared) {
    // The ceiling and its countdown restart with the new screen.
    ceilingRow = 0;
    shotsLeft = SHOTS_PER_DROP;
    ceilingMs = CEILING_MS;
  } else {
    shotsLeft = dropCeiling ? SHOTS_PER_DROP : remainingShots;
  }

  // The shooter moves on to the bubble that was queued up, unless that shot
  // just removed the last bubble of the queued colour.
  //
  // The queue is dealt a shot ahead, so it goes stale exactly when a pop takes
  // the final bubbles of a colour: hold a Wheat, have Pumpkin queued behind it,
  // clear the board's last Pumpkins, and the queued Pumpkin is now a colour
  // with nothing on the board. It is re-dealt rather than handed over.
  const nextCeiling = cleared ? 0 : dropCeiling ? ceiling + 1 : ceiling;
  const queued = prev.next;
  const incoming = coloursOnBoard(finalGrid).includes(queued)
    ? queued
    : pickNextColor(finalGrid, nextCeiling, roll);
  const nextColor = pickNextColor(finalGrid, nextCeiling, roll, incoming);

  const base: RavenBubblesRuntime = {
    ...prev,
    grid: finalGrid,
    score: newScore,
    shotsLeft,
    ceilingRow,
    ceilingMs,
    current: incoming,
    next: nextColor,
    shot: null,
  };

  if (won) {
    return { ...base, gameOver: true, won: true, reason: "Target score reached." };
  }

  if (crossedLine) {
    return {
      ...base,
      gameOver: true,
      won: false,
      reason: "Bubbles crossed the line.",
    };
  }

  // The run carries on: hand control back to the player.
  return { ...base, gameOver: false, won: false, reason: "" };
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
 * The body is the original inline machinery transcribed in the same order,
 * with four substitutions:
 *
 *  1. the wall-clock `setInterval` became the `ceilingMs` countdown (see the
 *     header), and runs *before* this step's fire — so a press that would have
 *     been ignored live (the run ended under it) is ignored identically here;
 *  2. the `shoot()` event became the `input.fire` check, keeping its own rule:
 *     one shot in flight, none after the end;
 *  3. the rAF flight loop became the substepped block below at the fixed step,
 *     `Math.hypot` replaced by its IEEE-exact spelling `sqrt(vx*vx + vy*vy)`
 *     (both ends run this same engine, so the substitution cannot diverge);
 *  4. the resolver closure became `resolveShot`, called on the first hit.
 *
 * Order within a step: **clock → fire → flight**. The clock owns the ordering
 * question the original left to two independent timers (the drop is only ever
 * applied while aiming; a fire on the drop's own tick happens after it, and a
 * run the drop ends is over before the press is looked at).
 */
export const tick = (
  prev: RavenBubblesRuntime,
  dtMs: number,
  input: TickInput,
): RavenBubblesRuntime => {
  if (prev.gameOver) return prev;

  let rngState = prev.rngState;
  const roll = () => {
    const next = advanceRng(rngState);
    rngState = next.state;
    return next.value;
  };

  const aimLevel = quantizeAim(input.aim);

  // ── The ceiling clock (was the wall-clock `setInterval`) ──────────────────
  let ceilingMs = prev.ceilingMs - dtMs;
  let ceilingRow = prev.ceilingRow;
  let grid = prev.grid;
  let shotsLeft = prev.shotsLeft;

  if (ceilingMs <= 0) {
    // The original reset the clock *then* dropped — an expiry that found the
    // player mid-flight restarted the countdown and skipped the drop entirely.
    // Same here: the reset is unconditional, the drop is not.
    ceilingMs = CEILING_MS;
    if (prev.shot === null) {
      grid = dropCeilingOnce(grid);
      ceilingRow += 1;
      shotsLeft = SHOTS_PER_DROP;

      if (hasCrossedTheLine(grid)) {
        return {
          ...prev,
          aimLevel,
          ceilingMs,
          ceilingRow,
          grid,
          shotsLeft,
          shot: null,
          gameOver: true,
          won: false,
          reason: "Bubbles crossed the line.",
        };
      }
    }
  }

  // ── Fire (was the click / touch-lift / Space event) ───────────────────────
  let shot = prev.shot;
  if (input.fire && shot === null) {
    shot = {
      x: SHOOTER_X,
      y: SHOOTER_Y,
      vx: SIN_TABLE[aimLevel] * SHOT_SPEED,
      vy: -COS_TABLE[aimLevel] * SHOT_SPEED,
      color: prev.current,
    };
  }

  const alive: RavenBubblesRuntime = {
    ...prev,
    aimLevel,
    ceilingMs,
    ceilingRow,
    grid,
    shotsLeft,
    shot,
  };

  if (shot === null) return { ...alive, rngState };

  // ── Flight (was the rAF loop) ─────────────────────────────────────────────
  //
  // Substepped so a shot can never tunnel. At 950 px/s a 16 ms step moves
  // ~15 px, which is under a bubble's diameter but not comfortably; stepping
  // in slices no longer than `MAX_STEP_PX` keeps every step's collision in the
  // same place regardless of how the arithmetic lands, exactly as the frame
  // loop's own substepping did live.
  const dt = dtMs / 1000;
  const travel =
    Math.sqrt(shot.vx * shot.vx + shot.vy * shot.vy) * dt;
  const steps = Math.max(1, Math.ceil(travel / MAX_STEP_PX));
  const stepDt = dt / steps;

  let { x, y, vx, vy } = shot;
  let hit = false;

  for (let index = 0; index < steps && !hit; index++) {
    x += vx * stepDt;
    y += vy * stepDt;

    if (x < RADIUS) {
      x = RADIUS;
      vx = -vx;
    } else if (x > PLAYFIELD_WIDTH - RADIUS) {
      x = PLAYFIELD_WIDTH - RADIUS;
      vx = -vx;
    }

    if (
      y - RADIUS <= ceilingLimitY(ceilingRow) ||
      touchesBubble(grid, x, y, ceilingRow)
    ) {
      hit = true;
    }
  }

  if (!hit) {
    return {
      ...alive,
      shot: { x, y, vx, vy, color: shot.color },
      rngState,
    };
  }

  const settled = resolveShot({ ...alive, shot: null }, x, y, shot.color, roll);
  return { ...settled, rngState };
};
