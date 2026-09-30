/* eslint-disable react/jsx-no-literals */
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSelector } from "../adapters/useSelector";
import { Button } from "components/ui/Button";
import { InnerPanel, OuterPanel } from "components/ui/Panel";
import { ITEM_DETAILS } from "../adapters/itemDetails";
import { useVipAccess } from "../adapters/useVipAccess";
import { useRewardRun } from "../adapters/rewardRun";
import { PortalContext, PortalMachineState } from "../adapters/portal";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import {
  getRavenBubblesDifficulty,
  isRavenBubblesRewardRunAvailable,
  RAVEN_BUBBLES_DIFFICULTIES,
  RAVEN_BUBBLES_RAVEN_COIN_REWARD,
  type RavenBubblesDifficulty,
  type RavenBubblesDifficultyName,
  type RavenBubblesMode,
} from "./session";

const _portalState = (state: PortalMachineState) => state.context.state;

// ── Board geometry ───────────────────────────────────────────────────────────
/**
 * A hex grid: every row holds `COLS` bubbles and odd rows are shifted half a
 * bubble to the right, which is what makes the cluster maths (and the look)
 * the original game's.
 */
const COLS = 10;
const MAX_ROWS = 13;
const RADIUS = 18;
const DIAMETER = RADIUS * 2;
const ROW_HEIGHT = RADIUS * Math.sqrt(3);
/** One radius wider than `COLS` bubbles so the shifted odd rows still fit. */
const PLAYFIELD_WIDTH = COLS * DIAMETER + RADIUS;
const PLAYFIELD_HEIGHT = 470;
const SHOOTER_X = PLAYFIELD_WIDTH / 2;
const SHOOTER_Y = PLAYFIELD_HEIGHT - 32;
/** A bubble resting on this row has crossed the line and ends the run. */
const DANGER_ROW = 11;
const DANGER_LINE_Y = RADIUS + DANGER_ROW * ROW_HEIGHT + RADIUS;
const INITIAL_ROWS = 5;
/** Shots before the ceiling drops a row — the original's pressure valve. */
const SHOTS_PER_DROP = 15;
const SHOT_SPEED = 950;
/** Longest a single physics substep may travel, in px. See the flight loop. */
const MAX_STEP_PX = 5;
/** Aim is measured from straight up, in radians. */
const MIN_AIM = -1.15;
const MAX_AIM = 1.15;
const POINTS_PER_POP = 30;
const POINTS_PER_DROP = 60;
const MIN_CLUSTER = 3;

// ── Bubbles ──────────────────────────────────────────────────────────────────
type BubbleColor = "Sunflower" | "Carrot" | "Pumpkin" | "Potato" | "Corn" | "Wheat";

const BUBBLE_COLORS: BubbleColor[] = [
  "Sunflower",
  "Carrot",
  "Pumpkin",
  "Potato",
  "Corn",
  "Wheat",
];

/** The SFL crop art inside each bubble — the same theming Tetris uses. */
const BUBBLE_IMAGES: Record<BubbleColor, string> = {
  Sunflower: ITEM_DETAILS.Sunflower.image,
  Carrot: ITEM_DETAILS.Carrot.image,
  Pumpkin: ITEM_DETAILS.Pumpkin.image,
  Potato: ITEM_DETAILS.Potato.image,
  Corn: ITEM_DETAILS.Corn.image,
  Wheat: ITEM_DETAILS.Wheat.image,
};

/** Bubble shell colour, so each crop reads at a glance before its art loads. */
const BUBBLE_SHELL: Record<BubbleColor, string> = {
  Sunflower: "#fbbf24",
  Carrot: "#fb923c",
  Pumpkin: "#c2410c",
  Potato: "#d6d3d1",
  Corn: "#fde047",
  Wheat: "#b45309",
};

type Cell = BubbleColor | null;
type Grid = Cell[][];

const emptyGrid = (): Grid =>
  Array.from({ length: MAX_ROWS }, () => Array<Cell>(COLS).fill(null));

const cellX = (row: number, col: number) =>
  RADIUS + col * DIAMETER + (row % 2 === 1 ? RADIUS : 0);
const cellY = (row: number) => RADIUS + row * ROW_HEIGHT;

/** The six hex neighbours of a cell, given the odd-row right shift. */
function neighbours(row: number, col: number): [number, number][] {
  const deltas: [number, number][] =
    row % 2 === 0
      ? [
          [0, -1],
          [0, 1],
          [-1, -1],
          [-1, 0],
          [1, -1],
          [1, 0],
        ]
      : [
          [0, -1],
          [0, 1],
          [-1, 0],
          [-1, 1],
          [1, 0],
          [1, 1],
        ];

  return deltas
    .map(([dr, dc]) => [row + dr, col + dc] as [number, number])
    .filter(([r, c]) => r >= 0 && r < MAX_ROWS && c >= 0 && c < COLS);
}

/** Every empty cell a new bubble could land in: the row the ceiling is
 *  currently sitting on, plus the empty cells touching an existing bubble. */
function snapCandidates(grid: Grid, ceilingRow: number): [number, number][] {
  const seen = new Set<string>();
  const out: [number, number][] = [];

  const push = (row: number, col: number) => {
    if (row < 0 || row >= MAX_ROWS || col < 0 || col >= COLS) return;
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
      for (const neighbour of neighbours(row, col)) push(...neighbour);
    }
  }

  return out;
}

/** The empty cell closest to a point — where a shot that hit something lands. */
function nearestEmptyCell(
  grid: Grid,
  x: number,
  y: number,
  ceilingRow: number,
): [number, number] | null {
  let best: [number, number] | null = null;
  let bestDistance = Infinity;

  for (const [row, col] of snapCandidates(grid, ceilingRow)) {
    const dx = cellX(row, col) - x;
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
function clusterOf(grid: Grid, row: number, col: number): [number, number][] {
  const color = grid[row]?.[col];
  if (!color) return [];

  const seen = new Set<string>([`${row},${col}`]);
  const stack: [number, number][] = [[row, col]];
  const cluster: [number, number][] = [];

  while (stack.length) {
    const [r, c] = stack.pop()!;
    cluster.push([r, c]);

    for (const [nr, nc] of neighbours(r, c)) {
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
function floatingCells(grid: Grid, ceilingRow: number): [number, number][] {
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
    for (const [nr, nc] of neighbours(row, col)) {
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

/**
 * The cells a shot can actually come to rest in.
 *
 * Traced from the shooter, bouncing off the walls exactly as a real shot does.
 * "Can this colour pop" is only worth asking if the player has an angle that
 * lands the bubble beside the pair — a triple buried in the middle of the
 * cluster is not a play, it is a coincidence, and offering it as one hands out
 * dead bubbles.
 */
function landingCells(grid: Grid, ceilingRow: number): Set<string> {
  const cells = new Set<string>();
  const RAYS = 44;

  for (let ray = 0; ray <= RAYS; ray++) {
    const angle = -MAX_AIM + (ray / RAYS) * (MAX_AIM * 2);
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

      const hitCeiling = y <= RADIUS;
      let hitBubble = false;

      if (!hitCeiling) {
        for (let row = 0; row < MAX_ROWS && !hitBubble; row++) {
          for (let col = 0; col < COLS && !hitBubble; col++) {
            if (!grid[row][col]) continue;
            const bx = cellX(row, col) - x;
            const by = cellY(row) - y;
            if (bx * bx + by * by < (DIAMETER - 2) * (DIAMETER - 2)) {
              hitBubble = true;
            }
          }
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
function completableColours(grid: Grid, ceilingRow: number): BubbleColor[] {
  const present = coloursOnBoard(grid);
  const found = new Set<BubbleColor>();

  for (const key of landingCells(grid, ceilingRow)) {
    const [row, col] = key.split(",").map(Number);

    for (const color of present) {
      if (found.has(color)) continue;

      const scratch = grid.map((line) => [...line]);
      scratch[row][col] = color;
      if (clusterOf(scratch, row, col).length >= MIN_CLUSTER) {
        found.add(color);
      }
    }
  }

  return present.filter((color) => found.has(color));
}

/**
 * The colour the shooter hands out next.
 *
 * Restricted to colours that are actually on the board (a colour nothing else
 * uses is a wasted shot) and then biased towards ones the player can act on
 * right now.
 *
 * Without that bias the cabinet is unwinnable rather than merely hard. A bubble
 * that completes nothing does not stay level: it snaps to the nearest empty cell
 * under the cluster and pushes its floor down a row, and the ceiling drops a row
 * every {@link SHOTS_PER_DROP} shots besides. Measured with a solver that picks
 * the best of every possible angle each shot, six colours left the player with
 * a real play on roughly a quarter of shots — the line was crossed around shot
 * 11 with 90 points of a 1500 target, on every difficulty. The bias is
 * invisible (the bubble still looks arbitrary) and is what turns the board into
 * something you can actually work through.
 */
function pickNextColor(grid: Grid, ceilingRow: number): BubbleColor {
  // `present` is the entire pool, and the playable-colour bias below only ever
  // narrows it — so a bubble can never be a colour that is not on the board.
  const present = coloursOnBoard(grid);

  // Unreachable in practice: a cleared board is refilled before the shooter is
  // re-dealt. The function still has to return something.
  if (present.length === 0) {
    return BUBBLE_COLORS[Math.floor(Math.random() * BUBBLE_COLORS.length)];
  }

  const live = completableColours(grid, ceilingRow);
  const pool = live.length > 0 ? live : present;

  return pool[Math.floor(Math.random() * pool.length)];
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
function createBoard(): Grid {
  const grid = emptyGrid();
  const inDeal = (row: number, col: number) =>
    row >= 0 && row < INITIAL_ROWS && col >= 0 && col < COLS;

  for (let row = 0; row < INITIAL_ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (grid[row][col]) continue;

      const color = BUBBLE_COLORS[Math.floor(Math.random() * BUBBLE_COLORS.length)];
      // One or two. Bigger clumps hand the player free triples and the run turns
      // into a formality — every shot pops, the cluster never grows a floor, and
      // the ceiling never gets to matter. At one or two, the board is made of
      // loose singles and pairs and the player has to build the three themselves,
      // which is the actual game.
      const size = 1 + Math.floor(Math.random() * 2);

      grid[row][col] = color;
      const candidates = neighbours(row, col).filter(
        ([r, c]) => inDeal(r, c) && !grid[r][c],
      );

      // Grow the clump one cell at a time, so it stays compact instead of
      // trailing off in a line.
      for (let placed = 1; placed < size && candidates.length > 0; placed++) {
        const index = Math.floor(Math.random() * candidates.length);
        const [r, c] = candidates.splice(index, 1)[0];
        if (grid[r][c]) continue;

        grid[r][c] = color;
        for (const [nr, nc] of neighbours(r, c)) {
          if (inDeal(nr, nc) && !grid[nr][nc]) candidates.push([nr, nc]);
        }
      }
    }
  }

  return grid;
}

const touchesBubble = (grid: Grid, x: number, y: number): boolean => {
  const reach = DIAMETER - 2;
  for (let row = 0; row < MAX_ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (!grid[row][col]) continue;
      const dx = cellX(row, col) - x;
      const dy = cellY(row) - y;
      if (dx * dx + dy * dy < reach * reach) return true;
    }
  }
  return false;
};

const clampAim = (angle: number) => Math.min(MAX_AIM, Math.max(MIN_AIM, angle));

/** One bubble: a glossy shell with the crop art inside. */
const Bubble: React.FC<{ color: BubbleColor; size?: number }> = ({
  color,
  size = DIAMETER,
}) => (
  <div
    className="rounded-full border border-black/40 flex items-center justify-center"
    style={{
      width: size,
      height: size,
      background: `radial-gradient(circle at 32% 28%, rgba(255,255,255,0.9), rgba(255,255,255,0) 44%), ${BUBBLE_SHELL[color]}`,
    }}
  >
    <img
      src={BUBBLE_IMAGES[color]}
      alt={color}
      draggable={false}
      className="rounded-full"
      style={{
        width: size - 10,
        height: size - 10,
        imageRendering: "pixelated",
      }}
    />
  </div>
);

type ShotStatus = "aiming" | "shooting" | "won" | "lost";

type Shot = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  color: BubbleColor;
};

export const RavenBubblesGame: React.FC<{ onClose?: () => void }> = ({
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });

  const hasRewardRun = useMemo(
    () => isRavenBubblesRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const todaysDifficulty = useMemo(() => getRavenBubblesDifficulty(), []);

  const [mode, setMode] = useState<RavenBubblesMode | null>(null);
  const [grid, setGrid] = useState<Grid>(() => createBoard());
  const [score, setScore] = useState(0);
  const [current, setCurrent] = useState<BubbleColor>("Sunflower");
  const [next, setNext] = useState<BubbleColor>("Carrot");
  const [shotsLeft, setShotsLeft] = useState(SHOTS_PER_DROP);
  const [boardNumber, setBoardNumber] = useState(1);
  /** Screens fully cleared this run; the win condition is a count of these. */
  const [screensCleared, setScreensCleared] = useState(0);
  /** Grid row the ceiling is currently resting on; it drops one row at a time. */
  const [ceilingRow, setCeilingRow] = useState(0);
  const [status, setStatus] = useState<ShotStatus>("aiming");
  const [aim, setAim] = useState(0);
  const [movingBubble, setMovingBubble] = useState<{
    x: number;
    y: number;
    color: BubbleColor;
  } | null>(null);
  const [activeDifficulty, setActiveDifficulty] =
    useState<RavenBubblesDifficulty>(todaysDifficulty);
  const [practiceDifficultyName, setPracticeDifficultyName] =
    useState<RavenBubblesDifficultyName>(todaysDifficulty.name);
  const [showPracticeDifficultyPrompt, setShowPracticeDifficultyPrompt] =
    useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const rewardGrantedRef = useRef(false);
  const playfieldRef = useRef<HTMLDivElement | null>(null);
  const touchAimingRef = useRef(false);

  // Refs mirror the state the flight loop and the resolver read, so neither has
  // to be recreated (and restart the animation frame) on every change.
  const gridRef = useRef(grid);
  const scoreRef = useRef(score);
  const shotsLeftRef = useRef(shotsLeft);
  const statusRef = useRef(status);
  const aimRef = useRef(aim);
  const currentRef = useRef(current);
  const nextRef = useRef(next);
  const difficultyRef = useRef(activeDifficulty);
  const ceilingRowRef = useRef(ceilingRow);
  /** Screens fully cleared this run. The win condition is a count of these. */
  const screensClearedRef = useRef(0);
  const shotRef = useRef<Shot | null>(null);

  useEffect(() => {
    gridRef.current = grid;
  }, [grid]);
  useEffect(() => {
    scoreRef.current = score;
  }, [score]);
  useEffect(() => {
    shotsLeftRef.current = shotsLeft;
  }, [shotsLeft]);
  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    aimRef.current = aim;
  }, [aim]);
  useEffect(() => {
    currentRef.current = current;
  }, [current]);
  useEffect(() => {
    nextRef.current = next;
  }, [next]);
  useEffect(() => {
    difficultyRef.current = activeDifficulty;
  }, [activeDifficulty]);
  useEffect(() => {
    ceilingRowRef.current = ceilingRow;
  }, [ceilingRow]);

  const isTouchDevice = useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches,
    [],
  );

  const returnToMenu = useCallback(() => {
    setShowExitConfirm(false);
    setMode(null);
    shotRef.current = null;
    setMovingBubble(null);
  }, []);

  const shoot = useCallback(() => {
    if (statusRef.current !== "aiming") return;

    const angle = aimRef.current;
    shotRef.current = {
      x: SHOOTER_X,
      y: SHOOTER_Y,
      vx: Math.sin(angle) * SHOT_SPEED,
      vy: -Math.cos(angle) * SHOT_SPEED,
      color: currentRef.current,
    };
    setMovingBubble(null);
    setStatus("shooting");
  }, []);

  /**
   * Settle a shot that has hit the ceiling or a bubble: snap it into the grid,
   * pop any cluster it completed, drop whatever that left floating, apply the
   * ceiling drop, then decide whether the run is still alive.
   */
  const resolveShot = useCallback((x: number, y: number, color: BubbleColor) => {
    const ceiling = ceilingRowRef.current;
    const landed = nearestEmptyCell(gridRef.current, x, y, ceiling);

    // Nowhere to land means the field is full — the line has effectively been
    // crossed, so the run is over.
    if (!landed) {
      setMovingBubble(null);
      setStatus("lost");
      return;
    }

    let working = gridRef.current.map((row) => [...row]);
    working[landed[0]][landed[1]] = color;

    let gained = 0;

    const cluster = clusterOf(working, landed[0], landed[1]);
    if (cluster.length >= MIN_CLUSTER) {
      for (const [row, col] of cluster) working[row][col] = null;
      gained += cluster.length * POINTS_PER_POP;
    }

    const floating = floatingCells(working, ceiling);
    if (floating.length > 0) {
      for (const [row, col] of floating) working[row][col] = null;
      gained += floating.length * POINTS_PER_DROP;
    }

    const newScore = scoreRef.current + gained;
    const remainingShots = shotsLeftRef.current - 1;
    const dropCeiling = remainingShots <= 0;

    if (dropCeiling) {
      // Shift everything down one row, and move the ceiling with it — the
      // cluster is still hanging from it, one row lower than before.
      const shifted = emptyGrid();
      for (let row = 0; row < MAX_ROWS - 1; row++) {
        for (let col = 0; col < COLS; col++) {
          shifted[row + 1][col] = working[row][col];
        }
      }
      working = shifted;
      setCeilingRow((row) => row + 1);
    }

    const crossedLine = working.some(
      (row, rowIndex) => rowIndex >= DANGER_ROW && row.some(Boolean),
    );
    const cleared = working.every((row) => row.every((cell) => cell === null));

    // A cleared screen is a stage complete: the next is dealt with the ceiling
    // back at the top, so a run is a chain of stages rather than one long slide
    // toward the line. The run ends when the last screen of the difficulty
    // falls, or when the cluster reaches the line first.
    const screensDone = cleared
      ? screensClearedRef.current + 1
      : screensClearedRef.current;
    const won = cleared && screensDone >= difficultyRef.current.boards;

    const finalGrid = cleared ? createBoard() : working;

    setGrid(finalGrid);
    setScore(newScore);
    setBoardNumber(screensDone + 1);

    if (cleared) {
      // The ceiling and its countdown restart with the new screen.
      setCeilingRow(0);
      setShotsLeft(SHOTS_PER_DROP);
      screensClearedRef.current = screensDone;
      setScreensCleared(screensDone);
    } else {
      setShotsLeft(dropCeiling ? SHOTS_PER_DROP : remainingShots);
    }

    // The shooter moves on to the bubble that was queued up.
    setCurrent(nextRef.current);
    setNext(
      pickNextColor(
        finalGrid,
        cleared ? 0 : dropCeiling ? ceiling + 1 : ceiling,
      ),
    );

    setMovingBubble(null);

    if (won) {
      setStatus("won");
      return;
    }

    if (crossedLine) {
      setStatus("lost");
      return;
    }

    // The run carries on: hand control back to the player.
    setStatus("aiming");
  }, []);

  // The flight loop. Reads only refs so it never restarts mid-shot.
  useEffect(() => {
    if (status !== "shooting") return;

    let frame = 0;
    let last = performance.now();

    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;

      const shot = shotRef.current;
      if (!shot) return;

      let { x, y, vx, vy } = shot;

      // Substepped so a shot can never tunnel.
      //
      // Advancing by `velocity * dt` in one go makes the physics depend on the
      // frame rate: at 950 px/s a 16ms frame moves 15px, but a 50ms hitch (the
      // dt clamp) moves 47px — more than a bubble's diameter — so the shot
      // passes clean through the cluster and snaps to whatever cell it happens
      // to stop beside. Measured against a solver that assumes continuous
      // motion, that mismatch made 9 of 12 aimed shots land somewhere else
      // entirely. Stepping in small increments makes every frame agree, and the
      // result no longer changes with the machine the player is on.
      const travel = Math.hypot(vx, vy) * dt;
      const steps = Math.max(1, Math.ceil(travel / MAX_STEP_PX));
      const stepDt = dt / steps;

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

        if (y <= RADIUS || touchesBubble(gridRef.current, x, y)) hit = true;
      }

      if (hit) {
        shotRef.current = null;
        resolveShot(x, y, shot.color);
        return;
      }

      shotRef.current = { x, y, vx, vy, color: shot.color };
      // The moving bubble is the only thing that changes per frame.
      setMovingBubble({ x, y, color: shot.color });

      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [status, resolveShot]);

  const startSession = useCallback(
    (
      nextMode: RavenBubblesMode,
      practiceDifficultyOverride?: RavenBubblesDifficultyName,
    ) => {
      if (nextMode === "reward" && !hasRewardRun) return;

      const chosenPracticeName =
        practiceDifficultyOverride ?? practiceDifficultyName;
      const selectedPracticeDifficulty =
        RAVEN_BUBBLES_DIFFICULTIES.find(
          (difficulty) => difficulty.name === chosenPracticeName,
        ) ?? todaysDifficulty;

      const runDifficulty =
        nextMode === "reward" ? todaysDifficulty : selectedPracticeDifficulty;

      const freshBoard = createBoard();

      setMode(nextMode);
      setActiveDifficulty(runDifficulty);
      setShowPracticeDifficultyPrompt(false);
      setGrid(freshBoard);
      setCurrent(pickNextColor(freshBoard, 0));
      setNext(pickNextColor(freshBoard, 0));
      setScore(0);
      setShotsLeft(SHOTS_PER_DROP);
      setBoardNumber(1);
      screensClearedRef.current = 0;
      setScreensCleared(0);
      setCeilingRow(0);
      setStatus("aiming");
      setAim(0);
      shotRef.current = null;
      setMovingBubble(null);
      rewardGrantedRef.current = false;

      if (nextMode === "reward") {
        portalService.send({
          type: "arcadeMinigame.started",
          name: "raven-bubbles" as any,
        });
      }
    },
    [hasRewardRun, portalService, practiceDifficultyName, todaysDifficulty],
  );

  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "raven-bubbles",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  const handleInGameExit = useCallback(() => {
    if (status === "won" || status === "lost") {
      returnToMenu();
      return;
    }

    setShowExitConfirm(true);
  }, [returnToMenu, status]);

  // A win pays out once, through the shared Raven Coin wiring.
  useEffect(() => {
    if (status !== "won" || rewardGrantedRef.current || mode !== "reward") return;

    rewardGrantedRef.current = true;
    portalService.send({
      type: "arcadeMinigame.ravenCoinWon",
      amount: RAVEN_BUBBLES_RAVEN_COIN_REWARD,
    });
  }, [mode, portalService, status]);

  const aimFromPoint = useCallback((clientX: number, clientY: number) => {
    const playfield = playfieldRef.current;
    if (!playfield) return;

    const rect = playfield.getBoundingClientRect();
    const dx = clientX - rect.left - SHOOTER_X;
    const dy = SHOOTER_Y - (clientY - rect.top);

    setAim(clampAim(Math.atan2(dx, dy)));
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (status !== "aiming") return;
      aimFromPoint(event.clientX, event.clientY);
    },
    [aimFromPoint, status],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (status !== "aiming") return;

      aimFromPoint(event.clientX, event.clientY);

      // Touch players drag to aim and lift to fire, so a tap never shoots
      // before they have pointed at anything.
      if (event.pointerType === "touch") {
        touchAimingRef.current = true;
        return;
      }

      shoot();
    },
    [aimFromPoint, shoot, status],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "touch" || !touchAimingRef.current) return;
      touchAimingRef.current = false;
      if (status !== "aiming") return;

      aimFromPoint(event.clientX, event.clientY);
      shoot();
    },
    [aimFromPoint, shoot, status],
  );

  // Keyboard: arrows aim, space fires.
  useEffect(() => {
    if (!mode) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "ArrowLeft") {
        setAim((previous) => clampAim(previous - 0.07));
        event.preventDefault();
      } else if (event.code === "ArrowRight") {
        setAim((previous) => clampAim(previous + 0.07));
        event.preventDefault();
      } else if (event.code === "Space") {
        shoot();
        event.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode, shoot]);

  /** Dotted aim guide, bounced off the walls and stopped by the first bubble. */
  const aimDots = useMemo(() => {
    if (status !== "aiming") return [];

    const dots: { x: number; y: number }[] = [];
    let x = SHOOTER_X;
    let y = SHOOTER_Y;
    let dx = Math.sin(aim);
    let dy = -Math.cos(aim);

    for (let step = 0; step < 90; step++) {
      x += dx * 9;
      y += dy * 9;

      if (x < RADIUS) {
        x = RADIUS;
        dx = -dx;
      } else if (x > PLAYFIELD_WIDTH - RADIUS) {
        x = PLAYFIELD_WIDTH - RADIUS;
        dx = -dx;
      }

      if (y <= RADIUS || touchesBubble(grid, x, y)) break;
      if (step % 2 === 0) dots.push({ x, y });
    }

    return dots;
  }, [aim, grid, status]);

  // ── Lobby ──────────────────────────────────────────────────────────────────

  if (!mode) {
    return (
      <OuterPanel className="mx-auto w-[min(98vw,1100px)] h-[min(95vh,900px)] overflow-hidden">
        <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
          <div className="text-center space-y-2">
            <h2 className="text-4xl font-bold">RAVEN BUBBLES</h2>
            <p className="text-sm text-gray-600">
              Pop crop bubbles, outlast the ceiling, and clear today&apos;s
              screens.
            </p>
          </div>

          <InnerPanel className="bg-amber-50 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">REWARD</div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-amber-800">
                  {RAVEN_BUBBLES_RAVEN_COIN_REWARD}
                  <img
                    src={ravenCoinIcon}
                    alt="RavenCoin"
                    className="w-6 h-6"
                  />
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">TODAY</div>
                <div className="text-2xl font-bold text-amber-800">
                  {todaysDifficulty.label}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  SCREENS
                </div>
                <div className="text-2xl font-bold text-amber-800">
                  {todaysDifficulty.boards}
                </div>
              </div>
            </div>
          </InnerPanel>

          <InnerPanel className="bg-slate-50 p-3 text-sm text-slate-700">
            <div className="font-semibold">Controls</div>
            <div className="mt-1">
              {isTouchDevice
                ? "Touch: drag to aim, lift to shoot."
                : "Mouse: move to aim, click to shoot."}
            </div>
            <div className="mt-1">
              Keyboard: left/right arrows to aim, Space to shoot.
            </div>
            <div className="mt-1">
              Match {MIN_CLUSTER} or more of a colour to pop them. The ceiling
              drops a row every {SHOTS_PER_DROP} shots — if the cluster reaches
              the line, the run is over.
            </div>
          </InnerPanel>

          <button
            onClick={rewardRun.start}
            disabled={!hasRewardRun}
            className={`w-full px-6 py-4 rounded-lg font-bold transition-all shadow-lg text-lg ${
              hasRewardRun
                ? "bg-green-500 text-white hover:bg-green-600 active:scale-95"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            <div>START REWARD RUN</div>
            <div className="mt-2 text-xs opacity-90">
              {!hasRewardRun
                ? "No reward runs left today — buy Play Tickets in the shop."
                : rewardRun.freeAvailable
                  ? isVip
                    ? "VIP: reward run available for Raven Bubbles today."
                    : "Reward run available for the arcade today."
                  : `Uses 1 Play Ticket (you have ${rewardRun.tickets}).`}
            </div>
          </button>

          <button
            onClick={() => setShowPracticeDifficultyPrompt(true)}
            className="w-full px-6 py-4 bg-blue-500 text-white font-bold rounded-lg hover:bg-blue-600 active:scale-95 transition-all shadow-lg text-lg"
          >
            <div>START PRACTICE MODE</div>
            <div className="mt-2 text-xs font-semibold opacity-90">
              Play without spending today&apos;s reward attempt.
            </div>
          </button>

          {rewardRun.dialog}

          {rewardRun.error && (
            <p className="text-center text-xs font-semibold text-red-600">
              {rewardRun.error}
            </p>
          )}

          {onClose && (
            <button
              onClick={() => onClose()}
              className="w-full px-6 py-2 bg-gray-400 text-white font-semibold rounded-lg hover:bg-gray-500 active:scale-95 transition-all"
            >
              EXIT
            </button>
          )}

          {showPracticeDifficultyPrompt && (
            <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-md rounded border border-white/30 bg-slate-900 p-4 space-y-4 text-white">
                <h3 className="text-lg font-bold">Select Practice Difficulty</h3>
                <p className="text-sm text-slate-200">
                  Reward runs still use today&apos;s difficulty (
                  {todaysDifficulty.label}).
                </p>
                <div className="space-y-2">
                  {RAVEN_BUBBLES_DIFFICULTIES.map((difficulty) => (
                    <button
                      key={difficulty.name}
                      onClick={() => {
                        setPracticeDifficultyName(difficulty.name);
                        startSession("practice", difficulty.name);
                      }}
                      className={`w-full px-4 py-3 rounded-lg font-bold text-sm transition-all ${
                        practiceDifficultyName === difficulty.name
                          ? "bg-green-500 text-white"
                          : "bg-slate-700 text-slate-200 hover:bg-slate-600"
                      }`}
                    >
                      {difficulty.label} — {difficulty.boards}{" "}
                      {difficulty.boards === 1 ? "screen" : "screens"}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setShowPracticeDifficultyPrompt(false)}
                  className="w-full px-4 py-2 rounded-lg font-semibold text-sm bg-gray-500 text-white hover:bg-gray-400"
                >
                  CANCEL
                </button>
              </div>
            </div>
          )}
        </div>
      </OuterPanel>
    );
  }

  // ── Run ────────────────────────────────────────────────────────────────────

  return (
    <OuterPanel className="mx-auto w-[min(98vw,1100px)] h-[min(95vh,900px)] overflow-hidden">
      <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <div>
              <div className="text-xs font-semibold text-gray-600">SCORE</div>
              <div className="text-2xl font-bold text-amber-800">{score}</div>
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-600">SCREENS</div>
              <div className="text-2xl font-bold text-amber-800">
                {screensCleared}/{activeDifficulty.boards}
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-600">SCREEN</div>
              <div className="text-2xl font-bold text-amber-800">
                {boardNumber}
              </div>
            </div>
          </div>

          <div className="text-center">
            <div className="text-xs font-semibold text-gray-600">
              CEILING DROPS IN
            </div>
            <div className="flex gap-1">
              {Array.from({ length: SHOTS_PER_DROP }, (_, index) => (
                <div
                  key={index}
                  className={`h-3 w-3 rounded-full border border-black/30 ${
                    index < shotsLeft ? "bg-red-500" : "bg-gray-300"
                  }`}
                />
              ))}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-center">
              <div className="text-xs font-semibold text-gray-600">NEXT</div>
              <Bubble color={next} size={30} />
            </div>
            {mode === "practice" && (
              <Button onClick={() => startSession("practice")}>
                Restart Practice
              </Button>
            )}
            {onClose && <Button onClick={handleInGameExit}>Exit</Button>}
          </div>
        </div>

        <div
          ref={playfieldRef}
          onPointerMove={handlePointerMove}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          className="relative mx-auto overflow-hidden rounded border-2 border-amber-900/40 bg-slate-900/90"
          style={{
            width: PLAYFIELD_WIDTH,
            height: PLAYFIELD_HEIGHT,
            touchAction: "none",
          }}
        >
          {/* The line the cluster must not reach. */}
          <div
            className="absolute left-0 right-0 border-t-2 border-dashed border-red-500/80"
            style={{ top: DANGER_LINE_Y }}
          />

          {grid.map((row, rowIndex) =>
            row.map((cell, colIndex) =>
              cell ? (
                <div
                  key={`${rowIndex}-${colIndex}`}
                  className="absolute"
                  style={{
                    left: cellX(rowIndex, colIndex) - RADIUS,
                    top: cellY(rowIndex) - RADIUS,
                  }}
                >
                  <Bubble color={cell} />
                </div>
              ) : null,
            ),
          )}

          {aimDots.map((dot, index) => (
            <div
              key={index}
              className="absolute rounded-full bg-white/50"
              style={{
                left: dot.x - 2,
                top: dot.y - 2,
                width: 4,
                height: 4,
              }}
            />
          ))}

          {movingBubble && (
            <div
              className="absolute"
              style={{
                left: movingBubble.x - RADIUS,
                top: movingBubble.y - RADIUS,
              }}
            >
              <Bubble color={movingBubble.color} />
            </div>
          )}

          {/* Shooter. */}
          <div
            className="absolute"
            style={{
              left: SHOOTER_X - RADIUS,
              top: SHOOTER_Y - RADIUS,
            }}
          >
            <Bubble color={current} />
          </div>
          <div
            className="absolute bg-amber-200/80"
            style={{
              left: SHOOTER_X - 2,
              top: SHOOTER_Y - RADIUS - 26,
              width: 4,
              height: 26,
              transformOrigin: "50% 100%",
              transform: `rotate(${aim}rad)`,
            }}
          />

          {(status === "won" || status === "lost") && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 p-4">
              <div
                className={`w-full max-w-sm rounded border-2 p-4 text-center ${
                  status === "won"
                    ? "border-green-400 bg-green-900/50"
                    : "border-red-400 bg-red-900/40"
                }`}
              >
                <div className="font-bold text-xl text-white">
                  {status === "won" ? "Screens Cleared!" : "Bubbles Crossed the Line"}
                </div>
                <div className="mt-1 text-sm text-slate-200">
                  {screensCleared} of {activeDifficulty.boards}{" "}
                  {activeDifficulty.boards === 1 ? "screen" : "screens"} cleared
                  · {score} points.
                  {status === "won" && mode === "reward"
                    ? ` Reward granted: ${RAVEN_BUBBLES_RAVEN_COIN_REWARD} RavenCoin.`
                    : ""}
                </div>
                <div className="mt-3 flex flex-col gap-2">
                  {mode === "practice" && (
                    <Button onClick={() => startSession("practice")}>
                      Play Again
                    </Button>
                  )}
                  {onClose && (
                    <Button onClick={handleInGameExit}>Back to Arcade</Button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        <p className="text-center text-xs text-gray-600">
          {isTouchDevice
            ? "Drag to aim, lift to shoot. Arrows and Space work too."
            : "Move to aim, click to shoot. Arrows and Space work too."}
        </p>
      </div>

      {showExitConfirm && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-slate-900 rounded border border-white/30 p-5 text-white space-y-4">
            <div className="font-bold text-lg">Exit Raven Bubbles?</div>
            <div className="text-sm text-slate-300">
              Your current progress will be lost.
            </div>
            <div className="flex gap-3 justify-end">
              <Button onClick={() => setShowExitConfirm(false)}>Cancel</Button>
              <Button
                onClick={() => {
                  setShowExitConfirm(false);
                  onClose?.();
                }}
              >
                Exit
              </Button>
            </div>
          </div>
        </div>
      )}
    </OuterPanel>
  );
};
