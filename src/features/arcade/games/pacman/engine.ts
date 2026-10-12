/**
 * Bumpkin-Man's simulation: the maze, the ghosts, the step that moves both.
 *
 * ## Why this file exists (and used to be inline in `PacManGame.tsx`)
 *
 * Pac-Man is a tick-simulated cabinet — its score falls out of re-running the
 * exact per-step inputs, which is the only proof of a run that is worth paying
 * for (see the headers of `worker/src/replay.js` and `worker/src/pacmanReplay.js`
 * for the argument). A proof the *server* re-runs needs the server's copy of
 * the rules to be the same copy the client played with: two implementations of
 * one ruleset will disagree, and a cheater plays whichever one is more lenient.
 * So the step function lives here, imported by both ends, rather than being
 * written once in the component and once in the worker.
 *
 * ## What makes a run replayable at all: no RNG, no clock
 *
 * Nothing here reads `Math.random()` or `Date.now()`. The frightened-mode
 * turns look pseudo-random but are a pure function of `(ghost.id,
 * frightenedMs)` — see `getFrightenedChoiceIndex`. The daily difficulty is not
 * read here either: it is *baked into the runtime* at `createRuntime`, so the
 * parked state a replay resumes from carries the very numbers (target score,
 * ghost speed, frighten duration) that the steps were computed under. A zero
 * RNG game replayed from its inputs is deterministic on any machine, which is
 * exactly what makes Pac-Man's whole proof one input log and no seed.
 *
 * ## The step is pure; the input is a parameter
 *
 * The component used to read the pressed direction off a React ref inside the
 * step. It cannot do that now: the worker steps this function with directions
 * decoded from the claimed log, and a ref would drag the *live* key state into
 * a re-simulation of a run that finished minutes ago. `requestedDir` is
 * therefore an argument, and the runtime is a plain JSON-serialisable object —
 * the worker parks it in D1 between chunk requests and resumes from the row.
 *
 * `FIXED_STEP_MS` is the other half of replayability. The component used to
 * feed whatever wall-clock delta the browser handed it (clamped 8–50 ms); frame
 * timing differs per device and cannot be reproduced server-side, so a log of
 * inputs against variable deltas re-simulates to a different score on every
 * machine. Both ends now advance the simulation in 20 ms steps — the client
 * accumulates real time and runs whole steps, the worker runs one step per
 * logged byte — so step *k* means the same thing on both sides. 20 ms is the
 * finest step that never skips a tile-centre decision: an eaten ghost moves at
 * 12 tiles/s (0.24 tiles per step) and needs to land within 0.15 of a tile
 * centre to re-decide its direction, so step spacing must stay under 0.30
 * tiles — 20 ms is 0.24, and a coarser step would strand ghosts mid-corridor.
 */

import {
  GHOST_EAT_BONUS,
  PELLET_POINTS,
  POWER_PELLET_POINTS,
  type PacManDifficulty,
} from "./session";

// ─────────────────────────────────────────────────────────────────────────────
// The step both ends take
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One simulation step, in milliseconds of simulated time.
 *
 * Shared with the worker through this module (the brawler's `FIXED_STEP_MS`
 * plays the same role there). Changing it changes every replay: a claim's log
 * is a list of directions, one per step, so the step length is part of the
 * protocol as much as it is part of the physics.
 */
export const FIXED_STEP_MS = 20;

/** The direction each input-log byte stands for. `0` is "no press yet". */
const DIR_CODES = {
  none: 0,
  left: 1,
  right: 2,
  up: 3,
  down: 4,
} as const;

export type Dir = "left" | "right" | "up" | "down" | "none";

/** The byte the log records for a direction. */
export const codeFromDir = (d: Dir): number => DIR_CODES[d];

/**
 * The direction a logged byte stands for, or `null` when the byte is not one
 * the client could ever have written.
 *
 * The worker validates every byte through this function *before* stepping:
 * a byte over 4 was not produced by `codeFromDir`, so the log is protocol
 * garbage rather than a run that failed to match, and is refused as the
 * former (see `validatePacmanReplay`).
 */
export const dirFromCode = (code: number): Dir | null => {
  switch (code) {
    case 0:
      return "none";
    case 1:
      return "left";
    case 2:
      return "right";
    case 3:
      return "up";
    case 4:
      return "down";
    default:
      return null;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Maze definition
// ─────────────────────────────────────────────────────────────────────────────
// Cell types:
//  0  = empty (no pellet, no wall) — used for ghost house / corridors already eaten
//  1  = wall
//  2  = pellet
//  3  = power pellet (kale)
//  4  = ghost house (goblins start here, player cannot enter)
//  5  = tunnel warp (left/right edges)
// prettier-ignore
const RAW_MAZE: number[][] = [
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,2,2,2,2,2,2,2,2,2,2,2,2,1,1,2,2,2,2,2,2,2,2,2,2,2,2,1],
  [1,2,1,1,1,1,2,1,1,1,1,1,2,1,1,2,1,1,1,1,1,2,1,1,1,1,2,1],
  [1,3,1,1,1,1,2,1,1,1,1,1,2,1,1,2,1,1,1,1,1,2,1,1,1,1,3,1],
  [1,2,1,1,1,1,2,1,1,1,1,1,2,1,1,2,1,1,1,1,1,2,1,1,1,1,2,1],
  [1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,1],
  [1,2,1,1,1,1,2,1,1,2,1,1,1,1,1,1,1,1,2,1,1,2,1,1,1,1,2,1],
  [1,2,1,1,1,1,2,1,1,2,1,1,1,1,1,1,1,1,2,1,1,2,1,1,1,1,2,1],
  [1,2,2,2,2,2,2,1,1,2,2,2,2,1,1,2,2,2,2,1,1,2,2,2,2,2,2,1],
  [1,1,1,1,1,1,2,1,1,1,1,1,0,1,1,0,1,1,1,1,1,2,1,1,1,1,1,1],
  [1,1,1,1,1,1,2,1,1,1,1,1,0,1,1,0,1,1,1,1,1,2,1,1,1,1,1,1],
  [1,1,1,1,1,1,2,1,1,0,0,0,0,0,0,0,0,0,0,1,1,2,1,1,1,1,1,1],
  [1,1,1,1,1,1,2,1,1,0,1,1,1,4,4,1,1,1,0,1,1,2,1,1,1,1,1,1],
  [1,1,1,1,1,1,2,1,1,0,1,4,4,4,4,4,4,1,0,1,1,2,1,1,1,1,1,1],
  [5,0,0,0,0,0,2,0,0,0,1,4,4,4,4,4,4,1,0,0,0,2,0,0,0,0,0,5],
  [1,1,1,1,1,1,2,1,1,0,1,1,1,1,1,1,1,1,0,1,1,2,1,1,1,1,1,1],
  [1,1,1,1,1,1,2,1,1,0,0,0,0,0,0,0,0,0,0,1,1,2,1,1,1,1,1,1],
  [1,1,1,1,1,1,2,1,1,0,1,1,1,1,1,1,1,1,0,1,1,2,1,1,1,1,1,1],
  [1,1,1,1,1,1,2,1,1,0,1,1,1,1,1,1,1,1,0,1,1,2,1,1,1,1,1,1],
  [1,2,2,2,2,2,2,2,2,2,2,2,2,1,1,2,2,2,2,2,2,2,2,2,2,2,2,1],
  [1,2,1,1,1,1,2,1,1,1,1,1,2,1,1,2,1,1,1,1,1,2,1,1,1,1,2,1],
  [1,2,1,1,1,1,2,1,1,1,1,1,2,1,1,2,1,1,1,1,1,2,1,1,1,1,2,1],
  [1,3,2,2,1,1,2,2,2,2,2,2,2,0,0,2,2,2,2,2,2,2,1,1,2,2,3,1],
  [1,1,1,2,1,1,2,1,1,2,1,1,1,1,1,1,1,1,2,1,1,2,1,1,2,1,1,1],
  [1,1,1,2,1,1,2,1,1,2,1,1,1,1,1,1,1,1,2,1,1,2,1,1,2,1,1,1],
  [1,2,2,2,2,2,2,1,1,2,2,2,2,1,1,2,2,2,2,1,1,2,2,2,2,2,2,1],
  [1,2,1,1,1,1,1,1,1,1,1,1,2,1,1,2,1,1,1,1,1,1,1,1,1,1,2,1],
  [1,2,1,1,1,1,1,1,1,1,1,1,2,1,1,2,1,1,1,1,1,1,1,1,1,1,2,1],
  [1,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
];

export const MAZE_COLS = 28;
export const MAZE_ROWS = RAW_MAZE.length; // 31

// Count original pellets / power pellets
const INITIAL_PELLETS = RAW_MAZE.flat().filter((c) => c === 2).length;
const INITIAL_POWER_PELLETS = RAW_MAZE.flat().filter((c) => c === 3).length;

// Player spawn (row 22, just below the ghost house)
const PLAYER_SPAWN_COL = 13;
const PLAYER_SPAWN_ROW = 22;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Vec2 {
  x: number;
  y: number;
}

interface Ghost {
  id: 0 | 1 | 2 | 3;
  /** sub-cell floating position (centre of ghost in tile coords) */
  col: number;
  row: number;
  dir: Dir;
  released: boolean;
  /** "chase" | "scatter" | "frightened" | "eaten" */
  mode: "chase" | "scatter" | "frightened" | "eaten";
  frightenedMs: number;
  /** score multiplier index (0-3) during one power-up window */
  eatIndex: number;
  scatterTarget: Vec2;
}

/**
 * The whole simulation state: one plain, JSON-serialisable object.
 *
 * JSON is a hard requirement, not a style one — the worker parks this between
 * chunk requests (`replay_state.state`) and resumes from the row, so every
 * field must survive `JSON.parse(JSON.stringify(x))` unchanged. That is also
 * why the daily difficulty rides *on* the runtime rather than being looked up
 * from the date at step time: the park would otherwise resume under a
 * different day's target and a run that legitimately won would mismatch.
 * (Numbers round-trip exactly; `reason` is the only optional field and the
 * step never reads it back.)
 */
export interface PacManRuntime {
  maze: number[][]; // mutable copy (pellets removed)
  playerCol: number;
  playerRow: number;
  playerDir: Dir;
  playerNextDir: Dir;
  score: number;
  lives: number;
  round: number; // how many times grid has been cleared
  pelletsLeft: number;
  powerPelletsLeft: number;
  ghosts: Ghost[];
  gameOver: boolean;
  won: boolean;
  deathPauseMs: number;
  powerPauseMs: number; // brief pause when eating ghost
  globalMode: "scatter" | "chase";
  modePhaseIndex: number;
  modePhaseElapsedMs: number;
  ghostReleaseMs: [number, number, number, number];
  reason?: string;
  /** The difficulty this run was opened under — see the header. */
  difficulty: PacManDifficulty;
}

// Ghost scatter corner targets (tile coords)
const SCATTER_TARGETS: Vec2[] = [
  { x: MAZE_COLS - 3, y: 0 }, // Blinky – top-right
  { x: 2, y: 0 }, // Pinky  – top-left
  { x: MAZE_COLS - 1, y: MAZE_ROWS - 1 }, // Inky – bottom-right
  { x: 0, y: MAZE_ROWS - 1 }, // Clyde – bottom-left
];

/**
 * The corridor tile above the ghost-house door, on the way out.
 *
 * **Must be a whole tile.** The step loop only re-decides a ghost's direction at
 * a tile centre, gated on `|col - round(col)| < 0.15`, so a half-tile column can
 * never satisfy it: a ghost sitting on one is frozen in whatever direction it
 * last had, which is how the doorway used to fill with ghosts pacing back and
 * forth. The door is row 12 cols 13/14 and the corridor above is row 11, so
 * (13, 11) is a real tile and the shortest step out.
 */
const GHOST_HOUSE_EXIT: Vec2 = { x: 13, y: 11 };

/**
 * Where an eaten ghost is actually headed: a tile *inside* the house.
 *
 * This has to be inside, not the exit. `GHOST_HOUSE_EXIT` sits on row 11, above
 * the house, while respawning requires reaching rows 12-15 - so an eaten ghost
 * sent there converged on the doorway without ever stepping into the house to
 * trigger the respawn. Aiming at a house cell sends it through the door and the
 * respawn fires on the first tile centre it reaches.
 */
const GHOST_HOUSE_HOME: Vec2 = { x: 13, y: 13 };

const isInGhostHouseArea = (col: number, row: number) => {
  return row >= 12 && row <= 15 && col >= 10 && col <= 17;
};

const GLOBAL_MODE_PHASES: Array<{
  mode: "scatter" | "chase";
  durationMs: number;
}> = [
  { mode: "scatter", durationMs: 7000 },
  { mode: "chase", durationMs: 20000 },
  { mode: "scatter", durationMs: 7000 },
  { mode: "chase", durationMs: 20000 },
  { mode: "scatter", durationMs: 5000 },
  { mode: "chase", durationMs: 20000 },
  { mode: "scatter", durationMs: 5000 },
  { mode: "chase", durationMs: Number.POSITIVE_INFINITY },
];

const GHOST_RELEASE_DELAY_MS: [number, number, number, number] = [
  0, 500, 4000, 8000,
];
const TUNNEL_ROW = 14;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const dirVec = (d: Dir): Vec2 => {
  switch (d) {
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
    case "up":
      return { x: 0, y: -1 };
    case "down":
      return { x: 0, y: 1 };
    default:
      return { x: 0, y: 0 };
  }
};

const isWall = (maze: number[][], col: number, row: number): boolean => {
  const r = Math.round(row);
  const c = ((Math.round(col) % MAZE_COLS) + MAZE_COLS) % MAZE_COLS;
  if (r < 0 || r >= MAZE_ROWS) return true;
  return maze[r][c] === 1;
};

const isGhostHouse = (maze: number[][], col: number, row: number): boolean => {
  const r = Math.round(row);
  const c = ((Math.round(col) % MAZE_COLS) + MAZE_COLS) % MAZE_COLS;
  if (r < 0 || r >= MAZE_ROWS) return false;
  return maze[r][c] === 4;
};

/**
 * Who is trying to move, which decides whether the ghost house is passable.
 *
 *  - `player` — never enters the house.
 *  - `ghost` — a live ghost. May be *inside* the house while leaving it, but
 *    must not walk back in from outside.
 *  - `returning-ghost` — an eaten ghost on its way home, the only one allowed
 *    back in.
 */
type MoverKind = "player" | "ghost" | "returning-ghost";

const canMove = (
  maze: number[][],
  col: number,
  row: number,
  dir: Dir,
  kind: MoverKind = "player",
): boolean => {
  const v = dirVec(dir);
  const nc = (((col + v.x) % MAZE_COLS) + MAZE_COLS) % MAZE_COLS;
  const nr = row + v.y;
  if (isWall(maze, nc, nr)) return false;

  if (kind === "returning-ghost") return true;
  if (!isGhostHouse(maze, nc, nr)) return true;

  // Reaching here means the next tile is inside the house.
  //
  // A live ghost is allowed in only while it is already inside, on its way out.
  // Letting it re-enter from outside is what made released ghosts pace the
  // doorway: out in the corridor its target became the player below, so "down"
  // into the house looked like the shortest route; the moment it was back inside
  // the target flipped to the house exit, so it walked out again and looped
  // forever. Blocking the return removes the cycle at the source.
  return kind === "ghost" && isInGhostHouseArea(col, row);
};

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

const canUseTunnelWrap = (row: number) => {
  return Math.abs(row - TUNNEL_ROW) < 0.7;
};

const spawnMaze = (): number[][] => RAW_MAZE.map((row) => [...row]);

// ─────────────────────────────────────────────────────────────────────────────
// Ghost AI helpers
// ─────────────────────────────────────────────────────────────────────────────
const OPPOSITE: Record<Dir, Dir> = {
  left: "right",
  right: "left",
  up: "down",
  down: "up",
  none: "none",
};
const ALL_DIRS: Dir[] = ["left", "right", "up", "down"];
const DIRECTION_PRIORITY: Dir[] = ["up", "left", "down", "right"];

/** When a frightened ghost starts flashing, and how often — render-side only,
 *  but read from here so the component does not restate engine constants. */
export const FRIGHTENED_FLASH_START_MS = 2000;
export const FRIGHTENED_FLASH_TOGGLE_MS = 180;

const getFrightenedChoiceIndex = (ghost: Ghost, candidateCount: number) => {
  if (candidateCount <= 1) return 0;

  // Deterministic pseudo-random selector for stable, arcade-like frightened turns.
  const tick = Math.floor(ghost.frightenedMs / 120);
  const seed = ((ghost.id + 1) * 1103515245 + tick * 12345) >>> 0;
  return seed % candidateCount;
};

/**
 * The first step of a shortest walkable path from `from` to `to`, or `null`
 * when there is no path.
 *
 * ## Why this exists
 *
 * `chooseGhostDir` below minimises straight-line distance to the target, which
 * is the classic hunting rule and is exactly right for a goblin chasing the
 * player. But it has no notion of *reachability*, so it walks into a trap when
 * the target sits behind a wall. That is not hypothetical here — it is the
 * reported "goblins get stuck and never come back to spawn":
 *
 *   - an eaten goblin is released inside the house with its target flipped to
 *     the corridor above it (`GHOST_HOUSE_EXIT`);
 *   - the house is walled *internally* (row 12 has walls at columns 10-12 and
 *     15-17, and columns 10 and 17 are walls on rows 13-14), so the direct
 *     route up is blocked;
 *   - each individual step still shortens the straight-line distance, so the
 *     greedy rule walks a closed four-tile cycle before it finds its way out:
 *
 *       (12,13) -> (11,13) -> (11,14) -> (12,14) -> (12,13) -> (13,13) -> ...
 *
 *     which reads as a goblin visibly pacing inside the house on its way out.
 *
 * Measured over every walkable tile of this maze with the maze parsed straight
 * out of the source: the greedy rule revisits a tile on **310 of 310** journeys
 * out of the house, and this one on none. Worst-case walk home drops from 55
 * steps to 38.
 *
 * A breadth-first walk cannot cycle like that: it expands the whole reachable
 * frontier and then commits to the shortest route, so a walled-off target is
 * gone around rather than oscillated at.
 */
const nextStepTowards = (
  maze: number[][],
  from: Vec2,
  to: Vec2,
  kind: MoverKind,
): Dir | null => {
  const startCol = Math.round(from.x);
  const startRow = Math.round(from.y);
  const goalCol = Math.round(to.x);
  const goalRow = Math.round(to.y);
  if (startCol === goalCol && startRow === goalRow) return null;

  const keyOf = (col: number, row: number) => `${col},${row}`;
  const startKey = keyOf(startCol, startRow);
  const seen = new Set<string>([startKey]);
  const cameFrom = new Map<string, string>();
  const cameBy = new Map<string, Dir>();
  const queue: Vec2[] = [{ x: startCol, y: startRow }];

  while (queue.length) {
    const node = queue.shift()!;

    for (const dir of ALL_DIRS) {
      const v = dirVec(dir);
      const nc = (((node.x + v.x) % MAZE_COLS) + MAZE_COLS) % MAZE_COLS;
      const nr = node.y + v.y;
      const key = keyOf(nc, nr);

      if (seen.has(key)) continue;
      if (!canMove(maze, node.x, node.y, dir, kind)) continue;

      seen.add(key);
      cameFrom.set(key, keyOf(node.x, node.y));
      cameBy.set(key, dir);

      if (nc === goalCol && nr === goalRow) {
        // Walk the chain back to the start. The last direction read is the one
        // that leaves the start tile, which is the step we want.
        let cursor = key;
        let firstStep: Dir | null = null;
        while (cursor !== startKey) {
          firstStep = cameBy.get(cursor) ?? null;
          cursor = cameFrom.get(cursor)!;
        }
        return firstStep;
      }

      queue.push({ x: nc, y: nr });
    }
  }

  return null;
};

/**
 * Is this target a place the goblin has to *navigate* to, rather than hunt?
 *
 * The house and the corridor above it. A goblin heading there wants the shortest
 * legal walk, not the most direct line — the difference is the loop above. A
 * goblin chasing the player keeps the classic greedy rule, which is the arcade
 * behaviour and the thing a player reads as a goblin's personality.
 */
const isNavigationTarget = (target: Vec2) =>
  target.y >= GHOST_HOUSE_EXIT.y - 1 &&
  target.y <= 15 &&
  target.x >= 9 &&
  target.x <= 18;

const chooseGhostDir = (ghost: Ghost, maze: number[][], target: Vec2): Dir => {
  // An eaten ghost is the only one that may re-enter the house on the way home.
  const kind: MoverKind = ghost.mode === "eaten" ? "returning-ghost" : "ghost";

  if (ghost.mode !== "frightened") {
    if (ghost.mode === "eaten" || isNavigationTarget(target)) {
      const step = nextStepTowards(
        maze,
        { x: ghost.col, y: ghost.row },
        target,
        kind,
      );
      // Falls through to the greedy rule when there is genuinely no path, so an
      // unreachable target degrades to the old behaviour rather than freezing.
      if (step) return step;
    }
  }

  let candidates = ALL_DIRS.filter(
    (d) =>
      d !== OPPOSITE[ghost.dir] && canMove(maze, ghost.col, ghost.row, d, kind),
  );

  // If reverse is the only valid path, allow it to prevent hallway oscillation/stalls.
  if (candidates.length === 0) {
    candidates = ALL_DIRS.filter((d) =>
      canMove(maze, ghost.col, ghost.row, d, kind),
    );
  }

  if (ghost.mode === "frightened") {
    // Classic frightened mode uses pseudo-random turns rather than targeted chase.
    const idx = getFrightenedChoiceIndex(ghost, candidates.length || 1);
    return candidates[idx] ?? ghost.dir;
  }

  // Pick direction that minimises distance to target.
  // On ties, classic Pac-Man priority is Up, Left, Down, Right.
  let bestDir: Dir = candidates[0] ?? ghost.dir;
  let bestDist = Infinity;
  for (const d of DIRECTION_PRIORITY) {
    if (!candidates.includes(d)) continue;

    const v = dirVec(d);
    const nc = (((ghost.col + v.x) % MAZE_COLS) + MAZE_COLS) % MAZE_COLS;
    const nr = ghost.row + v.y;
    const d2 = dist({ x: nc, y: nr }, target);

    if (d2 < bestDist) {
      bestDist = d2;
      bestDir = d;
    }
  }

  return bestDir;
};

const ghostTarget = (
  ghost: Ghost,
  playerCol: number,
  playerRow: number,
  playerDir: Dir,
  ghosts: Ghost[],
): Vec2 => {
  if (ghost.mode === "scatter") {
    return ghost.scatterTarget;
  }
  if (ghost.mode === "frightened") {
    return { x: playerCol, y: playerRow };
  }
  if (ghost.mode === "eaten") {
    // Into the house, not to the doorway - see GHOST_HOUSE_HOME.
    return GHOST_HOUSE_HOME;
  }

  // Chase targets (classic)
  switch (ghost.id) {
    case 0: // Blinky – direct chase
      return { x: playerCol, y: playerRow };
    case 1: {
      // Pinky – 4 tiles ahead of player
      const v = dirVec(playerDir);
      // Classic Pac-Man Pinky bug: when facing up, offset 4 up AND 4 left
      const ahead =
        playerDir === "up"
          ? { x: playerCol - 4, y: playerRow - 4 }
          : { x: playerCol + v.x * 4, y: playerRow + v.y * 4 };
      return ahead;
    }
    case 2: {
      // Inky – uses Blinky's position
      const blinky = ghosts[0];
      const v = dirVec(playerDir);
      const pivot = { x: playerCol + v.x * 2, y: playerRow + v.y * 2 };
      return {
        x: pivot.x + (pivot.x - blinky.col),
        y: pivot.y + (pivot.y - blinky.row),
      };
    }
    case 3: {
      // Clyde – chase if far, scatter if within 8 tiles
      const d = dist(
        { x: ghost.col, y: ghost.row },
        { x: playerCol, y: playerRow },
      );
      return d > 8 ? { x: playerCol, y: playerRow } : ghost.scatterTarget;
    }
    default:
      return { x: playerCol, y: playerRow };
  }
};

const createGhosts = (): Ghost[] =>
  ([0, 1, 2, 3] as const).map((id) => ({
    id,
    // Blinky starts out on the corridor above the door; the rest start inside
    // the house on distinct whole tiles, so every one of them can pass the
    // step loop's tile-centre test. A half-tile start (13.5) never could.
    col: id === 0 ? GHOST_HOUSE_EXIT.x : 12 + id,
    row: id === 0 ? GHOST_HOUSE_EXIT.y : 13,
    dir: "left" as Dir,
    released: id === 0,
    mode: "scatter" as const,
    frightenedMs: 0,
    eatIndex: 0,
    scatterTarget: SCATTER_TARGETS[id],
  }));

/**
 * A fresh run, opened under a *given* difficulty.
 *
 * The difficulty is copied onto the runtime rather than looked up when needed:
 * the worker replays a parked run days later and must use the target the run
 * was actually played under — while `validatePacmanReplay` still refuses any
 * difficulty that is not today's or yesterday's, so the copied difficulty can
 * only ever be one the date itself would have chosen.
 */
export const createRuntime = (difficulty: PacManDifficulty): PacManRuntime => ({
  maze: spawnMaze(),
  playerCol: PLAYER_SPAWN_COL,
  playerRow: PLAYER_SPAWN_ROW,
  playerDir: "none",
  playerNextDir: "none",
  score: 0,
  lives: 3,
  round: 0,
  pelletsLeft: INITIAL_PELLETS,
  powerPelletsLeft: INITIAL_POWER_PELLETS,
  ghosts: createGhosts(),
  gameOver: false,
  won: false,
  deathPauseMs: 0,
  powerPauseMs: 0,
  globalMode: "scatter",
  modePhaseIndex: 0,
  modePhaseElapsedMs: 0,
  ghostReleaseMs: [...GHOST_RELEASE_DELAY_MS],
  difficulty,
});

// ─────────────────────────────────────────────────────────────────────────────
// Speeds (tiles per second)
// ─────────────────────────────────────────────────────────────────────────────
const PLAYER_SPEED = 6.5; // tiles/s
const GHOST_BASE_SPEED = 5.5;
const GHOST_FRIGHTENED_SPEED = 3.0;
const GHOST_EATEN_SPEED = 12.0;
const DEATH_PAUSE_MS = 2000;
const POWER_PAUSE_MS = 200;

/**
 * Advance the simulation by `dtMs`, under the direction the player was holding
 * at the *start* of this step.
 *
 * Pure: reads only `prev`, `dtMs` and `requestedDir`. The caller decides which
 * direction that is — the client from its key state, the worker from the
 * claimed log — which is what makes one function serve both ends.
 *
 * The win check lives *inside* the step (score >= target, and the maze-clear
 * path below), because a win the client decides in an effect is a win the
 * worker cannot reproduce: the replay must reach `gameOver && won` on the same
 * step index the log ends on, or every honest claim would mismatch.
 */
export const tick = (
  prev: PacManRuntime,
  dtMs: number,
  requestedDir: Dir,
): PacManRuntime => {
  if (prev.gameOver) return prev;

  const targetScore = prev.difficulty.targetScore;

  // ── Death pause ─────────────────────────────────────────────────────────
  if (prev.deathPauseMs > 0) {
    const remaining = prev.deathPauseMs - dtMs;
    if (remaining > 0) return { ...prev, deathPauseMs: remaining };

    // Respawn
    return {
      ...prev,
      deathPauseMs: 0,
      playerCol: PLAYER_SPAWN_COL,
      playerRow: PLAYER_SPAWN_ROW,
      playerDir: "none",
      playerNextDir: "none",
      ghosts: createGhosts(),
    };
  }

  // ── Ghost-eat pause ─────────────────────────────────────────────────────
  if (prev.powerPauseMs > 0) {
    return { ...prev, powerPauseMs: Math.max(0, prev.powerPauseMs - dtMs) };
  }

  const dt = dtMs / 1000;
  const maze = prev.maze.map((r) => [...r]);

  // ── Global ghost mode timing (scatter/chase) ─────────────────────────
  let globalMode = prev.globalMode;
  let modePhaseIndex = prev.modePhaseIndex;
  let modePhaseElapsedMs = prev.modePhaseElapsedMs;
  let modeSwitched = false;

  const hasFrightenedGhost = prev.ghosts.some((g) => g.mode === "frightened",);
  if (!hasFrightenedGhost) {
    modePhaseElapsedMs += dtMs;

    while (modePhaseIndex < GLOBAL_MODE_PHASES.length) {
      const phase = GLOBAL_MODE_PHASES[modePhaseIndex];
      if (
        !Number.isFinite(phase.durationMs) ||
        modePhaseElapsedMs < phase.durationMs
      ) {
        break;
      }

      modePhaseElapsedMs -= phase.durationMs;
      modePhaseIndex = Math.min(
        modePhaseIndex + 1,
        GLOBAL_MODE_PHASES.length - 1,
      );
      const nextMode = GLOBAL_MODE_PHASES[modePhaseIndex].mode;

      if (nextMode !== globalMode) {
        globalMode = nextMode;
        modeSwitched = true;
      }
    }
  }

  const ghostReleaseMs = [...prev.ghostReleaseMs] as [
    number,
    number,
    number,
    number,
  ];
  for (let i = 1; i <= 3; i++) {
    ghostReleaseMs[i] = Math.max(0, ghostReleaseMs[i] - dtMs);
  }

  // ── Player movement ─────────────────────────────────────────────────────
  let { playerCol, playerRow, playerDir } = prev;

  // Try to turn if player is close enough to tile centre
  const colSnap = Math.abs(playerCol - Math.round(playerCol)) < 0.2;
  const rowSnap = Math.abs(playerRow - Math.round(playerRow)) < 0.2;

  if (requestedDir !== "none") {
    const anchorCol = Math.round(playerCol);
    const anchorRow = Math.round(playerRow);

    if (canMove(maze, anchorCol, anchorRow, requestedDir)) {
      if (playerDir === "none") {
        // Snap to tile centre so first key press always starts movement.
        playerCol = anchorCol;
        playerRow = anchorRow;
      }

      if ((colSnap && rowSnap) || playerDir === "none") {
        playerDir = requestedDir;
      }
    }
  }

  if (playerDir !== "none" && colSnap && rowSnap) {
    if (
      !canMove(
        maze,
        Math.round(playerCol),
        Math.round(playerRow),
        playerDir,
      )
    ) {
      playerDir = "none";
    }
  }

  const pv = dirVec(playerDir);
  let nextPlayerCol = playerCol + pv.x * PLAYER_SPEED * dt;
  let nextPlayerRow = playerRow + pv.y * PLAYER_SPEED * dt;

  if (pv.x !== 0 && canUseTunnelWrap(playerRow)) {
    if (nextPlayerCol < -0.5) nextPlayerCol = MAZE_COLS - 0.5;
    if (nextPlayerCol > MAZE_COLS - 0.5) nextPlayerCol = -0.5;
  } else {
    nextPlayerCol = Math.max(0, Math.min(MAZE_COLS - 1, nextPlayerCol));
  }

  nextPlayerRow = Math.max(0, Math.min(MAZE_ROWS - 1, nextPlayerRow));

  if (
    !isWall(maze, nextPlayerCol, nextPlayerRow) &&
    !isGhostHouse(maze, nextPlayerCol, nextPlayerRow)
  ) {
    playerCol = nextPlayerCol;
    playerRow = nextPlayerRow;
  } else {
    playerCol = Math.round(playerCol);
    playerRow = Math.round(playerRow);
    if (playerDir !== "none") {
      playerDir = "none";
    }
  }

  // ── Collect pellets ─────────────────────────────────────────────────────
  let { score, pelletsLeft, powerPelletsLeft } = prev;
  let frightenGhosts = false;

  const pr = Math.round(playerRow);
  const pc = Math.round(playerCol);
  const cell = maze[pr]?.[pc];

  if (cell === 2) {
    maze[pr][pc] = 0;
    score += PELLET_POINTS;
    pelletsLeft -= 1;
  } else if (cell === 3) {
    maze[pr][pc] = 0;
    score += POWER_PELLET_POINTS;
    powerPelletsLeft -= 1;
    frightenGhosts = true;
  }

  // ── Maze cleared → reset maze, increment round ──────────────────────────
  let { round } = prev;
  if (pelletsLeft === 0 && powerPelletsLeft === 0) {
    const newMaze = spawnMaze();
    round += 1;
    return {
      ...prev,
      maze: newMaze,
      playerCol: PLAYER_SPAWN_COL,
      playerRow: PLAYER_SPAWN_ROW,
      playerDir: "none",
      playerNextDir: "none",
      score,
      pelletsLeft: INITIAL_PELLETS,
      powerPelletsLeft: INITIAL_POWER_PELLETS,
      round,
      ghosts: createGhosts(),
      globalMode: "scatter",
      modePhaseIndex: 0,
      modePhaseElapsedMs: 0,
      ghostReleaseMs: [...GHOST_RELEASE_DELAY_MS],
      gameOver: score >= targetScore,
      won: score >= targetScore,
      reason: score >= targetScore ? "Target score reached!" : undefined,
    };
  }

  // ── Ghost update ────────────────────────────────────────────────────────
  let ghosts = prev.ghosts.map((g): Ghost => {
    let { frightenedMs } = g;
    let { released } = g;
    let mode = g.mode;

    if (!released && g.id !== 0) {
      if (ghostReleaseMs[g.id] <= 0) {
        // Unlock the ghost where it stands; do not move it.
        //
        // This used to teleport the ghost to `GHOST_HOUSE_EXIT`, which is
        // also the target a ghost inside the house is given - so it started
        // life standing on its own goal. "Minimise distance to target" is
        // then degenerate, because every direction is equally far and the
        // turn falls to the static priority order, which points it sideways
        // out of the doorway. Releasing in place keeps the exit genuinely
        // ahead, so the ghost walks out under its own steam.
        released = true;
        return { ...g, released, mode: globalMode };
      }

      return {
        ...g,
        released,
        mode: globalMode,
      };
    }

    if (frightenGhosts && g.mode !== "eaten") {
      mode = "frightened";
      g = {
        ...g,
        mode,
        dir: OPPOSITE[g.dir],
        frightenedMs: prev.difficulty.frightenedDurationMs,
        eatIndex: 0,
      };
      frightenedMs = g.frightenedMs;
    }

    if (mode === "frightened") {
      frightenedMs = Math.max(0, frightenedMs - dtMs);
      if (frightenedMs === 0) {
        mode = globalMode;
      }
    }

    if (modeSwitched && mode !== "eaten" && mode !== "frightened") {
      g = { ...g, dir: OPPOSITE[g.dir], mode: globalMode };
      mode = globalMode;
    }

    const speed =
      mode === "eaten"
        ? GHOST_EATEN_SPEED
        : mode === "frightened"
          ? GHOST_FRIGHTENED_SPEED
          : GHOST_BASE_SPEED * prev.difficulty.ghostSpeedMultiplier;

    // Decide direction at tile centres
    const gcSnap = Math.abs(g.col - Math.round(g.col)) < 0.15;
    const grSnap = Math.abs(g.row - Math.round(g.row)) < 0.15;

    let { dir } = g;
    if (gcSnap && grSnap) {
      // Re-enter ghost house when eaten
      if (
        mode === "eaten" &&
        g.row >= 12 &&
        g.row <= 15 &&
        g.col >= 10 &&
        g.col <= 17
      ) {
        return {
          ...g,
          released: true,
          mode: globalMode,
          dir,
          col: g.col,
          row: g.row,
        };
      }

      const target =
        released && mode !== "eaten" && isInGhostHouseArea(g.col, g.row)
          ? GHOST_HOUSE_EXIT
          : ghostTarget(
              { ...g, mode, dir },
              playerCol,
              playerRow,
              playerDir,
              prev.ghosts,
            );

      dir = chooseGhostDir({ ...g, mode, dir }, maze, target);
    }

    const gv = dirVec(dir);
    let newCol = g.col + gv.x * speed * dt;
    let newRow = g.row + gv.y * speed * dt;

    if (gv.x !== 0 && canUseTunnelWrap(g.row)) {
      if (newCol < -0.5) newCol = MAZE_COLS - 0.5;
      if (newCol > MAZE_COLS - 0.5) newCol = -0.5;
    } else {
      newCol = Math.max(0, Math.min(MAZE_COLS - 1, newCol));
    }

    newRow = Math.max(0, Math.min(MAZE_ROWS - 1, newRow));

    if (isWall(maze, newCol, newRow)) {
      newCol = Math.round(g.col);
      newRow = Math.round(g.row);
    }

    return {
      ...g,
      released,
      mode: mode === "eaten" || mode === "frightened" ? mode : globalMode,
      dir,
      col: newCol,
      row: newRow,
      frightenedMs,
    };
  });

  // ── Collision player ↔ ghosts ───────────────────────────────────────────
  let { lives } = prev;
  let powerPauseMs = 0;
  let deathPauseMs = 0;
  let gameOver = false;
  let won = false;
  let reason: string | undefined;

  for (let i = 0; i < ghosts.length; i++) {
    const g = ghosts[i];
    const d = dist({ x: g.col, y: g.row }, { x: playerCol, y: playerRow });

    if (d < 0.8) {
      if (g.mode === "frightened") {
        // Eat ghost
        const eatBonus =
          GHOST_EAT_BONUS[Math.min(g.eatIndex, GHOST_EAT_BONUS.length - 1)];
        score += eatBonus;
        ghosts = ghosts.map((gh, idx) =>
          idx === i
            ? {
                ...gh,
                mode: "eaten",
                eatIndex: gh.eatIndex + 1,
                frightenedMs: 0,
              }
            : gh,
        );
        powerPauseMs = POWER_PAUSE_MS;
      } else if (g.mode === "chase" || g.mode === "scatter") {
        // Player dies
        lives -= 1;
        deathPauseMs = DEATH_PAUSE_MS;
        if (lives <= 0) {
          gameOver = true;
          won = false;
          reason = "Out of lives";
        }
        break;
      }
    }
  }

  // Check win on score
  if (!gameOver && score >= targetScore) {
    gameOver = true;
    won = true;
    reason = "Target score reached!";
  }

  return {
    ...prev,
    maze,
    playerCol,
    playerRow,
    playerDir,
    playerNextDir: "none",
    score,
    lives,
    round,
    pelletsLeft,
    powerPelletsLeft,
    ghosts,
    gameOver,
    won,
    deathPauseMs,
    powerPauseMs,
    globalMode,
    modePhaseIndex,
    modePhaseElapsedMs,
    ghostReleaseMs,
    reason,
  };
};
