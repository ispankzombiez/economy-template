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
import { SUNNYSIDE } from "example-assets/sunnyside";
import { ITEM_DETAILS } from "../adapters/itemDetails";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { startAttempt, submitScore } from "../adapters/portalUtil";
import { useVipAccess } from "../adapters/useVipAccess";
import { NPCIcon, bumpkinPortraitBox } from "../adapters/NPCIcon";
import { NPC_WEARABLES } from "lib/npcs";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import { useRewardRun } from "../adapters/rewardRun";
import {
  getPacManDifficulty,
  isPacManRewardRunAvailable,
  PAC_MAN_DIFFICULTIES,
  PAC_MAN_RAVEN_COIN_REWARD,
  PacManDifficulty,
  PacManDifficultyName,
  PacManMode,
  PELLET_POINTS,
  POWER_PELLET_POINTS,
  GHOST_EAT_BONUS,
} from "./session";

// ─────────────────────────────────────────────────────────────────────────────
// Maze definition
// ─────────────────────────────────────────────────────────────────────────────
// Cell types:
//  0  = empty (no pellet, no wall) — used in ghost house / corridors already eaten
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

const MAZE_COLS = 28;
const MAZE_ROWS = RAW_MAZE.length; // 31
const CELL = 20; // px per tile
const ARENA_W = MAZE_COLS * CELL; // 560
const ARENA_H = MAZE_ROWS * CELL; // 620

// Count original pellets / power pellets
const INITIAL_PELLETS = RAW_MAZE.flat().filter((c) => c === 2).length;
const INITIAL_POWER_PELLETS = RAW_MAZE.flat().filter((c) => c === 3).length;

// Player spawn (row 22, just below the ghost house)
const PLAYER_SPAWN_COL = 13;
const PLAYER_SPAWN_ROW = 22;

/**
 * How big the bumpkin is *drawn*, in pixels of visible character height.
 *
 * The animation sheet is 96x64 with the character occupying only 13x18 of it,
 * so sizing the sprite by its box drew the bumpkin at a fraction of that box and
 * it read as much smaller than the character you walk around as on the arcade
 * floor. `NPCIcon` now crops to the character and scales that, so this number is
 * the height actually seen: 30px against the 20px ghosts on a 20px tile grid,
 * centred on the cell the player occupies. One number to tune.
 */
const PLAYER_RENDER_HEIGHT = 30;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type Dir = "left" | "right" | "up" | "down" | "none";

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

interface PacManRuntime {
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
}

// Ghost scatter corner targets (tile coords)
const SCATTER_TARGETS: Vec2[] = [
  { x: MAZE_COLS - 3, y: 0 }, // Blinky – top-right
  { x: 2, y: 0 }, // Pinky  – top-left
  { x: MAZE_COLS - 1, y: MAZE_ROWS - 1 }, // Inky – bottom-right
  { x: 0, y: MAZE_ROWS - 1 }, // Clyde – bottom-left
];

const GHOST_HOUSE_EXIT: Vec2 = { x: 13.5, y: 11 };

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
const INTERCEPTED = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "KeyA",
  "KeyD",
  "KeyW",
  "KeyS",
]);

const keyToDir = (code: string): Dir | null => {
  if (code === "ArrowLeft" || code === "KeyA") return "left";
  if (code === "ArrowRight" || code === "KeyD") return "right";
  if (code === "ArrowUp" || code === "KeyW") return "up";
  if (code === "ArrowDown" || code === "KeyS") return "down";
  return null;
};

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

const canMove = (
  maze: number[][],
  col: number,
  row: number,
  dir: Dir,
  isGhost = false,
): boolean => {
  const v = dirVec(dir);
  const nc = (((col + v.x) % MAZE_COLS) + MAZE_COLS) % MAZE_COLS;
  const nr = row + v.y;
  if (isGhost) {
    // Ghosts in "eaten" mode can re-enter the house; others cannot
    return !isWall(maze, nc, nr);
  }
  return !isWall(maze, nc, nr) && !isGhostHouse(maze, nc, nr);
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
const FRIGHTENED_FLASH_START_MS = 2000;
const FRIGHTENED_FLASH_TOGGLE_MS = 180;

const getFrightenedChoiceIndex = (ghost: Ghost, candidateCount: number) => {
  if (candidateCount <= 1) return 0;

  // Deterministic pseudo-random selector for stable, arcade-like frightened turns.
  const tick = Math.floor(ghost.frightenedMs / 120);
  const seed = ((ghost.id + 1) * 1103515245 + tick * 12345) >>> 0;
  return seed % candidateCount;
};

const chooseGhostDir = (ghost: Ghost, maze: number[][], target: Vec2): Dir => {
  let candidates = ALL_DIRS.filter(
    (d) =>
      d !== OPPOSITE[ghost.dir] && canMove(maze, ghost.col, ghost.row, d, true),
  );

  // If reverse is the only valid path, allow it to prevent hallway oscillation/stalls.
  if (candidates.length === 0) {
    candidates = ALL_DIRS.filter((d) =>
      canMove(maze, ghost.col, ghost.row, d, true),
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
    return GHOST_HOUSE_EXIT;
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
    col: id === 0 ? GHOST_HOUSE_EXIT.x : id === 1 ? 13 : id === 2 ? 14 : 13.5,
    row: id === 0 ? GHOST_HOUSE_EXIT.y : 13,
    dir: "left" as Dir,
    released: id === 0,
    mode: "scatter" as const,
    frightenedMs: 0,
    eatIndex: 0,
    scatterTarget: SCATTER_TARGETS[id],
  }));

const createRuntime = (): PacManRuntime => ({
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

// ─────────────────────────────────────────────────────────────────────────────
// xstate selector
// ─────────────────────────────────────────────────────────────────────────────
const _portalState = (state: PortalMachineState) => state.context.state;

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────
export const PacManGame: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });

  const hasRewardRun = useMemo(
    () => isPacManRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const todaysDifficulty = useMemo(() => getPacManDifficulty(), []);

  const [mode, setMode] = useState<PacManMode | null>(null);
  const [runtime, setRuntime] = useState<PacManRuntime | null>(null);
  const [showPracticePrompt, setShowPracticePrompt] = useState(false);
  const [activeDifficulty, setActiveDifficulty] =
    useState<PacManDifficulty>(todaysDifficulty);
  const [practiceDifficultyName, setPracticeDifficultyName] =
    useState<PacManDifficultyName>(todaysDifficulty.name);
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const returnToMenu = useCallback(() => {
    setShowExitConfirm(false);
    setMode(null);
    setRuntime(null);
    nextDirRef.current = "none";
  }, []);

  const playerParts =
    portalGameState.bumpkin?.equipped ?? NPC_WEARABLES["pumpkin' pete"];

  /** Centering box for the portrait, whose own width is measured at runtime. */
  const portrait = useMemo(() => bumpkinPortraitBox(PLAYER_RENDER_HEIGHT), []);

  const nextDirRef = useRef<Dir>("none");
  const rewardGrantedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  // ── Start session ───────────────────────────────────────────────────────────
  const startSession = useCallback(
    (nextMode: PacManMode, practiceOverride?: PacManDifficultyName) => {
      if (nextMode === "reward" && !hasRewardRun) return;

      const practiceName = practiceOverride ?? practiceDifficultyName;
      const practiceDiff =
        PAC_MAN_DIFFICULTIES.find((d) => d.name === practiceName) ??
        todaysDifficulty;
      const runDiff = nextMode === "reward" ? todaysDifficulty : practiceDiff;

      setMode(nextMode);
      setActiveDifficulty(runDiff);
      setShowPracticePrompt(false);
      rewardGrantedRef.current = false;
      setRuntime(createRuntime());
      nextDirRef.current = "none";

      if (nextMode === "reward") {
        portalService.send({
          type: "arcadeMinigame.started",
          name: "pac-man" as any,
        });
        startAttempt();
      }
    },
    [hasRewardRun, portalService, practiceDifficultyName, todaysDifficulty],
  );

  // Free run first, then 1 burned Play Ticket per attempt — with the "are you
  // sure?" box in between.
  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "pac-man",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  // ── Key handling ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mode) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (!INTERCEPTED.has(e.code)) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      const d = keyToDir(e.code);
      if (d) nextDirRef.current = d;
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [mode]);

  // ── Game tick ───────────────────────────────────────────────────────────────
  const tick = useCallback(
    (prev: PacManRuntime, dtMs: number): PacManRuntime => {
      if (prev.gameOver) return prev;

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

      const hasFrightenedGhost = prev.ghosts.some(
        (g) => g.mode === "frightened",
      );
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
      const requestedDir = nextDirRef.current;

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
          gameOver: score >= activeDifficulty.targetScore,
          won: score >= activeDifficulty.targetScore,
          reason:
            score >= activeDifficulty.targetScore
              ? "Target score reached!"
              : undefined,
        };
      }

      // ── Ghost update ────────────────────────────────────────────────────────
      let ghosts = prev.ghosts.map((g): Ghost => {
        let { frightenedMs } = g;
        let { released } = g;
        let mode = g.mode;

        if (!released && g.id !== 0) {
          if (ghostReleaseMs[g.id] <= 0) {
            released = true;
            return {
              ...g,
              released,
              col: GHOST_HOUSE_EXIT.x,
              row: GHOST_HOUSE_EXIT.y,
              dir: "left",
              mode: globalMode,
            };
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
            frightenedMs: activeDifficulty.frightenedDurationMs,
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
              : GHOST_BASE_SPEED * activeDifficulty.ghostSpeedMultiplier;

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
      if (!gameOver && score >= activeDifficulty.targetScore) {
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
    },
    [activeDifficulty],
  );

  // ── RAF loop ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mode || !runtime || runtime.gameOver) {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      lastFrameAtRef.current = null;
      return;
    }

    const loop = (ts: number) => {
      const prevAt = lastFrameAtRef.current ?? ts;
      const dtMs = Math.min(50, Math.max(8, ts - prevAt));
      lastFrameAtRef.current = ts;
      setRuntime((prev) => (prev ? tick(prev, dtMs) : prev));
      frameRef.current = requestAnimationFrame(loop);
    };

    frameRef.current = requestAnimationFrame(loop);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      lastFrameAtRef.current = null;
    };
  }, [mode, runtime?.gameOver, tick]);

  // ── Reward grant ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (
      !runtime?.gameOver ||
      !runtime.won ||
      rewardGrantedRef.current ||
      mode !== "reward"
    )
      return;
    submitScore({ score: runtime.score });
    portalService.send({
      type: "arcadeMinigame.ravenCoinWon",
      amount: PAC_MAN_RAVEN_COIN_REWARD,
    });
    rewardGrantedRef.current = true;
  }, [mode, portalService, runtime]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Lobby
  // ─────────────────────────────────────────────────────────────────────────────
  if (!mode || !runtime) {
    return (
      <OuterPanel className="mx-auto w-[min(98vw,1100px)] h-[min(95vh,900px)] overflow-hidden">
        <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
          <div className="text-center space-y-2">
            <h2 className="text-4xl font-bold">BUMPKIN-MAN</h2>
            <p className="text-sm text-gray-600">
              Eat all the pellets, avoid the goblins — unless you find a Kale!
            </p>
          </div>

          <InnerPanel className="bg-amber-50 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  REWARD
                </div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-amber-800">
                  {PAC_MAN_RAVEN_COIN_REWARD}
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
                  TARGET
                </div>
                <div className="text-2xl font-bold text-amber-800">
                  {todaysDifficulty.targetScore}
                </div>
              </div>
            </div>
          </InnerPanel>

          <InnerPanel className="bg-slate-50 p-3 text-sm text-slate-700 space-y-1">
            <div className="font-semibold">How to play</div>
            <div>
              Move with <strong>W/A/S/D</strong> or <strong>Arrow Keys</strong>.
            </div>
            <div>
              Collect white pellets (10 pts). Collect{" "}
              <img
                src={ITEM_DETAILS.Kale.image}
                className="inline w-4 h-4"
                alt="kale"
              />{" "}
              Kale (50 pts) to frighten goblins and eat them for bonus points
              (200 → 400 → 800 → 1600).
            </div>
            <div>
              Reach <strong>{todaysDifficulty.targetScore} points</strong> to
              win. You have <strong>3 lives</strong>.
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
                    ? "VIP: reward run available for Bumpkin-Man today."
                    : "Reward run available for the arcade today."
                  : `Uses 1 Play Ticket (you have ${rewardRun.tickets}).`}
            </div>
          </button>

          <button
            onClick={() => setShowPracticePrompt(true)}
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
              onClick={onClose}
              className="w-full px-6 py-2 bg-gray-400 text-white font-semibold rounded-lg hover:bg-gray-500 active:scale-95 transition-all"
            >
              EXIT
            </button>
          )}

          {showPracticePrompt && (
            <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-md rounded border border-white/30 bg-slate-900 p-4 space-y-4 text-white">
                <h3 className="text-lg font-bold">
                  Select Practice Difficulty
                </h3>
                <div className="grid grid-cols-3 gap-2">
                  {PAC_MAN_DIFFICULTIES.map((d) => (
                    <button
                      key={d.name}
                      type="button"
                      onClick={() => {
                        setPracticeDifficultyName(d.name);
                        startSession("practice", d.name);
                      }}
                      className={`px-3 py-2 rounded border text-xs font-semibold ${
                        practiceDifficultyName === d.name
                          ? "bg-blue-600 text-white border-blue-700"
                          : "bg-white text-slate-700 border-slate-300"
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
                <div className="text-xs text-slate-300">
                  Reward runs use today&apos;s difficulty (
                  {todaysDifficulty.label}).
                </div>
                <div className="flex justify-end">
                  <Button onClick={() => setShowPracticePrompt(false)}>
                    CANCEL
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </OuterPanel>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // In-game render
  // ─────────────────────────────────────────────────────────────────────────────
  const GHOST_COLOURS = ["#ff0000", "#ffb8ff", "#00ffff", "#ffb852"];
  const GHOST_FRIGHTENED_COLOUR = "#0000c8";

  return (
    <OuterPanel className="mx-auto w-[min(98vw,1100px)] h-[min(95vh,900px)] overflow-hidden">
      <InnerPanel className="w-full h-full p-3 bg-black text-white overflow-auto">
        <div className="max-w-6xl mx-auto h-full flex flex-col gap-2">
          {/* HUD */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="font-bold text-lg text-yellow-400">
              BUMPKIN-MAN – {activeDifficulty.label}
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              <span className="px-2 py-1 rounded bg-slate-800">
                Mode: {mode}
              </span>
              <span className="px-2 py-1 rounded bg-slate-800">
                Score: {runtime.score}
              </span>
              <span className="px-2 py-1 rounded bg-slate-800">
                Target: {activeDifficulty.targetScore}
              </span>
              <span className="px-2 py-1 rounded bg-slate-800">
                {"Lives: "}
                {Array.from({ length: runtime.lives }).map((_, i) => (
                  <span key={i} className="inline-block mx-0.5">
                    ❤️
                  </span>
                ))}
              </span>
              <span className="px-2 py-1 rounded bg-slate-800">
                Round: {runtime.round + 1}
              </span>
            </div>
          </div>

          {/* Maze */}
          <div
            className="relative mx-auto border border-blue-700 bg-black overflow-hidden"
            style={{ width: ARENA_W, height: ARENA_H }}
          >
            {/* Walls + pellets */}
            {runtime.maze.map((rowArr, r) =>
              rowArr.map((cell, c) => {
                if (cell === 1) {
                  return (
                    <div
                      key={`w-${r}-${c}`}
                      className="absolute bg-blue-800 border border-blue-900"
                      style={{
                        left: c * CELL,
                        top: r * CELL,
                        width: CELL,
                        height: CELL,
                      }}
                    />
                  );
                }
                if (cell === 2) {
                  return (
                    <div
                      key={`p-${r}-${c}`}
                      className="absolute rounded-full bg-yellow-100"
                      style={{
                        left: c * CELL + CELL / 2 - 3,
                        top: r * CELL + CELL / 2 - 3,
                        width: 6,
                        height: 6,
                      }}
                    />
                  );
                }
                if (cell === 3) {
                  return (
                    <img
                      key={`k-${r}-${c}`}
                      src={ITEM_DETAILS.Kale.image}
                      alt="kale"
                      className="absolute"
                      style={{
                        left: c * CELL + 2,
                        top: r * CELL + 2,
                        width: CELL - 4,
                        height: CELL - 4,
                        imageRendering: "pixelated",
                      }}
                    />
                  );
                }
                if (cell === 4) {
                  return (
                    <div
                      key={`gh-${r}-${c}`}
                      className="absolute bg-gray-900"
                      style={{
                        left: c * CELL,
                        top: r * CELL,
                        width: CELL,
                        height: CELL,
                      }}
                    />
                  );
                }
                return null;
              }),
            )}

            {/* Ghosts */}
            {runtime.ghosts.map((g, i) => {
              const frightened = g.mode === "frightened";
              const eaten = g.mode === "eaten";
              const isFlashingWindow =
                frightened && g.frightenedMs <= FRIGHTENED_FLASH_START_MS;
              const flashToNormal =
                isFlashingWindow &&
                Math.floor(g.frightenedMs / FRIGHTENED_FLASH_TOGGLE_MS) % 2 ===
                  0;
              const wrapCol = ((g.col % MAZE_COLS) + MAZE_COLS) % MAZE_COLS;
              return (
                <div
                  key={`ghost-${i}`}
                  className="absolute flex items-center justify-center"
                  style={{
                    left: wrapCol * CELL - CELL / 2,
                    top: g.row * CELL - CELL / 2,
                    width: CELL * 2,
                    height: CELL * 2,
                    zIndex: 10,
                  }}
                >
                  {eaten ? (
                    <img
                      src={SUNNYSIDE.npcs.goblin}
                      alt={`ghostly goblin ${i}`}
                      style={{
                        width: CELL * 1.5,
                        height: CELL * 1.5,
                        imageRendering: "pixelated",
                        opacity: 0.35,
                        filter: "grayscale(1) brightness(1.4)",
                      }}
                    />
                  ) : (
                    <img
                      src={SUNNYSIDE.npcs.goblin}
                      alt={`goblin ${i}`}
                      style={{
                        width: CELL * 1.5,
                        height: CELL * 1.5,
                        imageRendering: "pixelated",
                        filter:
                          frightened && !flashToNormal
                            ? "hue-rotate(180deg) saturate(2)"
                            : "none",
                      }}
                    />
                  )}
                </div>
              );
            })}

            {/* Player */}
            {runtime.deathPauseMs === 0 && (
              <div
                className="absolute"
                style={{
                  // Centred on the tile the player occupies, so the character
                  // sits on its cell. The box is `bumpkinPortraitBox(...)` wide
                  // so the canvas - whose width is measured from the sheet -
                  // can be centred inside it.
                  left:
                    (((runtime.playerCol % MAZE_COLS) + MAZE_COLS) %
                      MAZE_COLS) *
                      CELL -
                    portrait.width / 2,
                  top: runtime.playerRow * CELL - PLAYER_RENDER_HEIGHT / 2,
                  width: portrait.width,
                  height: PLAYER_RENDER_HEIGHT,
                  zIndex: 20,
                }}
              >
                <NPCIcon
                  parts={playerParts}
                  height={PLAYER_RENDER_HEIGHT}
                  facing={runtime.playerDir === "left" ? "left" : "right"}
                />
              </div>
            )}

            {/* Death flash */}
            {runtime.deathPauseMs > 0 && (
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="px-4 py-2 bg-black/70 text-red-400 text-sm font-bold border border-red-600 rounded">
                  Caught by a Goblin!
                </div>
              </div>
            )}
          </div>

          {/* Game over banner */}
          {runtime.gameOver && (
            <div
              className={`rounded border-2 p-3 text-center ${
                runtime.won
                  ? "border-green-400 bg-green-900/40"
                  : "border-red-400 bg-red-900/30"
              }`}
            >
              <div className="font-bold text-lg">
                {runtime.won ? "You Win!" : "Game Over"}
              </div>
              <div className="text-sm mt-1">
                {runtime.reason}. Final score: {runtime.score}.
                {runtime.won && mode === "reward"
                  ? ` Reward granted: ${PAC_MAN_RAVEN_COIN_REWARD} RavenCoin.`
                  : ""}
              </div>
            </div>
          )}

          {/* Action row */}
          <div className="flex flex-wrap gap-2">
            {mode === "practice" && (
              <Button onClick={() => startSession("practice")}>
                Restart Practice
              </Button>
            )}
            {runtime.gameOver && mode === "reward" && hasRewardRun && (
              <Button onClick={() => startSession("reward")}>Play Again</Button>
            )}
            {onClose && (
              <Button
                onClick={() => {
                  if (runtime.gameOver) {
                    returnToMenu();
                    return;
                  }

                  setShowExitConfirm(true);
                }}
              >
                Exit
              </Button>
            )}
          </div>

          <div className="text-xs text-slate-400">
            W/A/S/D or Arrow Keys to move. Collect{" "}
            <img
              src={ITEM_DETAILS.Kale.image}
              className="inline w-3 h-3"
              alt="kale"
            />{" "}
            Kale to frighten goblins!
          </div>
        </div>

        {/* Exit confirmation dialog */}
        {showExitConfirm && (
          <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-slate-900 rounded border border-white/30 p-5 text-white space-y-4">
              <div className="font-bold text-lg">Exit Bumpkin-Man?</div>
              <div className="text-sm text-slate-300">
                Your progress will be lost.
              </div>
              <div className="flex gap-3 justify-end">
                <Button onClick={() => setShowExitConfirm(false)}>
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    if (runtime?.gameOver) {
                      returnToMenu();
                      return;
                    }

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
      </InnerPanel>
    </OuterPanel>
  );
};
