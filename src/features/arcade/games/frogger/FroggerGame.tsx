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
import { FitStage } from "components/ui/FitStage";
import { InnerPanel, OuterPanel } from "components/ui/Panel";
import { TouchDPad, useIsTouchDevice } from "components/ui/TouchControls";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { startAttempt, submitScore } from "../adapters/portalUtil";
import { useVipAccess } from "../adapters/useVipAccess";
import { NPCIcon, bumpkinPortraitBox } from "../adapters/NPCIcon";
import { NPC_WEARABLES } from "lib/npcs";
import { SUNNYSIDE } from "example-assets/sunnyside";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import { useRewardRun } from "../adapters/rewardRun";
import {
  FROGGER_DIFFICULTIES,
  FROGGER_RAVEN_COIN_REWARD,
  FroggerDifficulty,
  FroggerDifficultyName,
  FroggerMode,
  getFroggerDifficulty,
  isFroggerRewardRunAvailable,
} from "./session";

// ── World layout ──────────────────────────────────────────────────────────────
// COLS × CELL = arena width. VIEWPORT_ROWS shown at once via scrolling camera.
// WORLD_ROWS is the total map height. Player travels from bottom (row 29) to
// the home row (row 0) to earn a phase bonus, then resets for more phases.
const COLS = 14;
const CELL = 54; // px per tile — bigger for better visibility
const PLAYER_SIZE = 42; // collision box (kept as-is; gameplay is tuned to it)

/**
 * How big the bumpkin is *drawn*, in pixels of visible character height.
 *
 * `PLAYER_SIZE` is the collision box, not the sprite. The animation sheet is
 * 96x64 with the character occupying only 13x18 of it, so sizing the sprite by
 * its box drew the bumpkin at a fraction of that box and it read as much
 * smaller than the character you walk around as on the arcade floor.
 *
 * `NPCIcon` now crops to the character and scales that, so this number is the
 * height actually seen: 48px sits just inside a 54px lane, and the sprite stays
 * bottom-aligned to the 42px collision box so it stands on the same lane without
 * touching the lanes, logs or hitboxes. One number to tune.
 */
const PLAYER_RENDER_HEIGHT = 48;
const VIEWPORT_ROWS = 11; // rows visible at once
const WORLD_ROWS = 30; // total world rows (row 0 = home, row 29 = start)

const ARENA_W = COLS * CELL; // 756 px
const ARENA_H = VIEWPORT_ROWS * CELL; // 594 px
const WORLD_H = WORLD_ROWS * CELL; // 1620 px

/**
 * The floor on how far the arena may be scaled down.
 *
 * The arena is 756px wide, so on every phone the *width* sets the scale and not
 * the height: a 320px viewport leaves `FitStage` 288px once its own frame
 * padding is taken out, which is 0.38 of the board. A floor above that is the
 * thing clipping the arena — which is the one outcome a floor exists to prevent
 * — and a floor below it only buys a smaller board, so 0.38 is the highest one
 * that is still safe. It is what a short landscape window falls back to: past
 * here the arena is a legitimate size and the panel scrolls, where below it
 * there is nothing left to aim in.
 */
const MIN_STAGE_SCALE = 0.38;

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
type RowType = "home" | "safe" | "road" | "river" | "checkpoint";
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

const HOME_ROW = 0;
const START_ROW = 29;
const CHECKPOINT_ROW = 17;

// ── Visual config ─────────────────────────────────────────────────────────────
const LANE_COLORS: Record<RowType, string> = {
  home: "#c8971a",
  safe: "#2d6b2d",
  road: "#3a3a3a",
  river: "#0b4fa3",
  checkpoint: "#3a6b22",
};

// ── Entity types ──────────────────────────────────────────────────────────────
type GoblinEntity = {
  id: number;
  worldRow: number;
  x: number; // pixel left edge, can be negative/> ARENA_W (wrap handled at render)
  width: number;
  dir: 1 | -1;
  speed: number; // effective px/s (includes elite boost)
  baseSpeed: number; // px/s without elite boost, used to re-roll on wrap
  kind: "normal" | "elite";
};

type LogEntity = {
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

type FroggerRuntime = {
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
  introLocked: boolean;
  reason?: string;
};

// ── Entity builders ───────────────────────────────────────────────────────────
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

const mod = (value: number, size: number) => ((value % size) + size) % size;

const getRowType = (virtualRow: number): RowType =>
  ROW_TYPES[mod(virtualRow, WORLD_ROWS)];

const isRoad = (virtualRow: number) => getRowType(virtualRow) === "road";
const isRiver = (virtualRow: number) => getRowType(virtualRow) === "river";

const getWrapSpan = (width: number) => ARENA_W + width * 2;

const wrapX = (x: number, width: number) => {
  const span = getWrapSpan(width);
  return mod(x + width, span) - width;
};

const getWrappedCopies = (x: number, width: number): number[] => {
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

const isLogSunk = (log: LogEntity, nowMs: number) =>
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

const buildGoblins = (
  difficulty: FroggerDifficulty,
  loopLevel: number,
  score: number,
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
    const laneRandomBoost = Math.random() < 0.55 ? 1 : 0;
    const count = Math.max(
      2,
      Math.round(cfg.count * densityMult) + laneRandomBoost,
    );
    const goblinW = cfg.width * CELL;
    const spacing = getWrapSpan(goblinW) / count;

    for (let i = 0; i < count; i++) {
      const offsetJitter = (Math.random() - 0.5) * spacing * 0.55;
      const speedVariance = 0.85 + Math.random() * 0.4;
      const isElite = Math.random() < eliteChance;
      const eliteSpeedBoost = isElite ? 1.5 + Math.random() * 0.5 : 1; // 1.5–2.0× (50–100% faster)
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

const buildLogs = (
  difficulty: FroggerDifficulty,
  loopLevel: number,
  score: number,
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
      const isFragile = Math.random() < fragileChance;
      entities.push({
        id: id++,
        worldRow: row,
        x: wrapX(
          i * spacing +
            (Math.random() - 0.5) * spacing * 0.35 +
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

const startCameraY = (playerCY: number, _introLocked: boolean) =>
  playerCY - (ARENA_H - CELL * 0.5);

const createRuntime = (difficulty: FroggerDifficulty): FroggerRuntime => {
  const cx = startPlayerCX();
  const cy = startPlayerCY();
  const startVirtualRow = Math.floor(cy / CELL);
  const introLocked = true;
  return {
    playerCX: cx,
    playerFacing: "right",
    playerCY: cy,
    goblins: buildGoblins(difficulty, 0, 0),
    logs: buildLogs(difficulty, 0, 0),
    cameraY: startCameraY(cy, introLocked),
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
    introLocked,
  };
};

// ── xstate selector ───────────────────────────────────────────────────────────
const _portalState = (state: PortalMachineState) => state.context.state;

// ── Component ─────────────────────────────────────────────────────────────────
export const FroggerGame: React.FC<{ onClose?: () => void }> = ({
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });

  const hasRewardRun = useMemo(
    () => isFroggerRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const todaysDifficulty = useMemo(() => getFroggerDifficulty(), []);

  const isTouchDevice = useIsTouchDevice();

  const [mode, setMode] = useState<FroggerMode | null>(null);
  const [runtime, setRuntime] = useState<FroggerRuntime | null>(null);
  const [activeDifficulty, setActiveDifficulty] =
    useState<FroggerDifficulty>(todaysDifficulty);
  const [practiceDifficultyName, setPracticeDifficultyName] =
    useState<FroggerDifficultyName>(todaysDifficulty.name);
  const [showPracticePrompt, setShowPracticePrompt] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  const rewardGrantedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const pressedKeysRef = useRef(new Set<string>());

  const playerParts =
    portalGameState.bumpkin?.equipped ?? NPC_WEARABLES["pumpkin' pete"];

  /** Centering box for the portrait, whose own width is measured at runtime. */
  const portrait = useMemo(() => bumpkinPortraitBox(PLAYER_RENDER_HEIGHT), []);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const returnToMenu = useCallback(() => {
    setShowExitConfirm(false);
    setShowPracticePrompt(false);
    setMode(null);
    setRuntime(null);
    rewardGrantedRef.current = false;
    pressedKeysRef.current.clear();
  }, []);

  const startSession = useCallback(
    (nextMode: FroggerMode, practiceOverride?: FroggerDifficultyName) => {
      if (nextMode === "reward" && !hasRewardRun) return;

      const practiceName = practiceOverride ?? practiceDifficultyName;
      const practiceDiff =
        FROGGER_DIFFICULTIES.find((d) => d.name === practiceName) ??
        todaysDifficulty;
      const diff = nextMode === "reward" ? todaysDifficulty : practiceDiff;

      pressedKeysRef.current.clear();
      setActiveDifficulty(diff);
      setMode(nextMode);
      setRuntime(createRuntime(diff));
      setShowPracticePrompt(false);
      setShowExitConfirm(false);
      rewardGrantedRef.current = false;

      if (nextMode === "reward") {
        portalService.send({
          type: "arcadeMinigame.started",
          name: "frogger" as any,
        });
        startAttempt();
      }
    },
    [hasRewardRun, practiceDifficultyName, portalService, todaysDifficulty],
  );

  // Free run first, then 1 burned Play Ticket per attempt — with the "are you
  // sure?" box in between.
  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "frogger",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  // ── Tick ──────────────────────────────────────────────────────────────────
  const tick = useCallback(
    (prev: FroggerRuntime, dtMs: number): FroggerRuntime => {
      if (prev.gameOver) return prev;

      const dt = dtMs / 1000;
      const nowMs = prev.elapsedMs + dtMs;
      const pressureSteps = Math.floor(prev.score / DIFFICULTY_SCORE_STEP);
      const pressureMult = 1 + prev.loopLevel * 0.08 + pressureSteps * 0.03;
      const fragileChance = getFragileChance(
        activeDifficulty,
        prev.loopLevel,
        prev.score,
      );

      // ── Death pause ────────────────────────────────────────────────────────
      if (prev.deathPauseMs > 0) {
        const rem = prev.deathPauseMs - dtMs;
        if (rem > 0) return { ...prev, deathPauseMs: rem, elapsedMs: nowMs };
        // Resume — player already reset
        return {
          ...prev,
          deathPauseMs: 0,
          cameraY: startCameraY(prev.playerCY, prev.introLocked),
          elapsedMs: nowMs,
        };
      }

      // ── Move goblins ───────────────────────────────────────────────────────
      const eliteChanceNow = getEliteGoblinChance(prev.score, prev.loopLevel);
      const newGoblins: GoblinEntity[] = prev.goblins.map((g) => {
        const rawNext = g.x + g.dir * g.speed * pressureMult * dt;
        const nx = wrapX(rawNext, g.width);
        // Detect wrap: position jumped backward relative to travel direction
        const didWrap = g.dir === 1 ? nx < g.x : nx > g.x;
        if (didWrap) {
          // Re-roll elite status each time the goblin re-enters from off-screen
          const nowElite = Math.random() < eliteChanceNow;
          const eliteBoost = nowElite ? 1.5 + Math.random() * 0.5 : 1;
          return {
            ...g,
            x: nx,
            kind: nowElite ? "elite" : "normal",
            speed: g.baseSpeed * eliteBoost,
          };
        }
        return { ...g, x: nx };
      });

      // ── Move logs + carry player on river ──────────────────────────────────
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
            kind: Math.random() < fragileChance ? "fragile" : "stable",
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
              sinkAtMs: nowMs + 1000 + Math.random() * 1000,
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

      // ── Player movement (fluid / velocity-based) ───────────────────────────
      const keys = pressedKeysRef.current;
      let dx = 0;
      let dy = 0;
      if (keys.has("ArrowLeft") || keys.has("KeyA")) dx -= 1;
      if (keys.has("ArrowRight") || keys.has("KeyD")) dx += 1;
      if (keys.has("ArrowUp") || keys.has("KeyW")) dy -= 1;
      if (keys.has("ArrowDown") || keys.has("KeyS")) dy += 1;

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

      // ── Score for advancing upward ──────────────────────────────────────────
      let {
        score,
        highestProgressVirtualRow,
        checkpointLoopToken,
        homeLoopToken,
      } = prev;
      const loopLevel = Math.max(prev.loopLevel, newLoopBand);
      const introLocked = true;

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

      // ── Goblin collision (pixel hitbox) ─────────────────────────────────────
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

      // ── River (water) collision ─────────────────────────────────────────────
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

      // ── Handle death ───────────────────────────────────────────────────────
      if (killedBy) {
        const newLives = prev.lives - 1;
        const resetVirtualRow = newVirtualRow + (START_ROW - newRowIndex);
        const newCYReset = (resetVirtualRow + 0.5) * CELL;
        if (newLives <= 0) {
          return {
            ...prev,
            goblins: newGoblins,
            logs: newLogs,
            score,
            lives: 0,
            gameOver: true,
            won: score >= activeDifficulty.targetScore,
            reason: killedBy,
            elapsedMs: nowMs,
          };
        }
        return {
          ...prev,
          playerCX: startPlayerCX(),
          playerCY: newCYReset,
          goblins: newGoblins,
          logs: newLogs,
          score,
          lives: newLives,
          highestProgressVirtualRow: resetVirtualRow,
          deathPauseMs: DEATH_PAUSE_MS,
          reason: killedBy,
          cameraY: startCameraY(newCYReset, introLocked),
          loopLevel,
          checkpointLoopToken,
          homeLoopToken,
          introLocked,
          elapsedMs: nowMs,
        };
      }

      // ── Smooth camera ─────────────────────────────────────────────────────
      const targetCamY = newCY - (ARENA_H - CELL * 0.5);
      const newCamY =
        prev.cameraY + (targetCamY - prev.cameraY) * Math.min(1, dt * 8);

      return {
        ...prev,
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
        introLocked,
        elapsedMs: nowMs,
      };
    },
    [activeDifficulty],
  );

  // ── RAF loop ───────────────────────────────────────────────────────────────
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

  // ── Reward submission ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!runtime?.gameOver || mode !== "reward" || rewardGrantedRef.current)
      return;

    submitScore({ score: runtime.score });

    if (runtime.won) {
      portalService.send({
        type: "arcadeMinigame.ravenCoinWon",
        amount: FROGGER_RAVEN_COIN_REWARD,
      });
    }
    rewardGrantedRef.current = true;
  }, [mode, portalService, runtime]);

  // ── Unmount cleanup ────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  // ── Keyboard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!runtime) return;

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

    const onDown = (e: KeyboardEvent) => {
      if (INTERCEPTED.has(e.code)) {
        e.preventDefault();
        e.stopPropagation();
        pressedKeysRef.current.add(e.code);
      }
    };
    const onUp = (e: KeyboardEvent) => {
      pressedKeysRef.current.delete(e.code);
    };

    window.addEventListener("keydown", onDown, { capture: true });
    window.addEventListener("keyup", onUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onDown, { capture: true });
      window.removeEventListener("keyup", onUp, { capture: true });
    };
  }, [!!runtime]);

  // ── Menu ──────────────────────────────────────────────────────────────────
  if (!mode || !runtime) {
    return (
      <OuterPanel className="mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden">
        <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
          <div className="text-center space-y-2">
            <h2 className="text-4xl font-bold">FROGGER</h2>
            <p className="text-sm text-gray-600">
              Cross the road and river - reach the golden home without getting
              squished or soaked!
            </p>
          </div>

          <InnerPanel className="bg-amber-50 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  REWARD
                </div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-amber-800">
                  {FROGGER_RAVEN_COIN_REWARD}
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
              {/* Touch players never see the keyboard, so naming it here would
                  describe controls they cannot reach. */}
              {isTouchDevice ? (
                "Move freely with the on-screen pad."
              ) : (
                <>
                  Move freely with <strong>W/A/S/D</strong> or{" "}
                  <strong>Arrow Keys</strong>.
                </>
              )}
            </div>
            <div>
              Dodge goblins on the road. Ride floating logs across the river.
              Fragile light logs sink after 1-2 seconds once stepped on. Watch
              out for rare{" "}
              <span style={{ color: "#ff4444", fontWeight: "bold" }}>
                red goblins
              </span>{" "}
              — they move much faster!
            </div>
            <div>The map loops endlessly: keep climbing for higher scores.</div>
            <div>
              Score <strong>{todaysDifficulty.targetScore}+ points</strong> to
              earn today&apos;s reward. You have{" "}
              <strong>{todaysDifficulty.startingLives} lives</strong>.
            </div>
            <div className="text-xs text-slate-500">
              Bonus: +{CHECKPOINT_BONUS} pts for reaching the mid checkpoint
              &bull; +{HOME_BONUS} pts for reaching home
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
                    ? "VIP: reward run available for Frogger today."
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
                  {FROGGER_DIFFICULTIES.map((d) => (
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

  // ── In-game render ─────────────────────────────────────────────────────────
  const camY = runtime.cameraY;
  const firstVisibleVirtualRow = Math.floor(camY / CELL);
  const lastVisibleVirtualRow = firstVisibleVirtualRow + VIEWPORT_ROWS + 2;
  const playerVirtualRow = Math.floor(runtime.playerCY / CELL);
  const playerRowIndex = mod(playerVirtualRow, WORLD_ROWS);
  const loopBandProgress =
    mod(HOME_ROW - playerVirtualRow, WORLD_ROWS) / WORLD_ROWS;

  return (
    <OuterPanel className="mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden">
      <InnerPanel className="w-full h-full p-3 bg-[#0a0a1a] text-white overflow-auto">
        <div className="max-w-6xl mx-auto h-full flex flex-col gap-2">
          {/* HUD */}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="font-bold text-lg text-yellow-300">
              FROGGER - {activeDifficulty.label.toUpperCase()}
            </div>
            <div className="flex gap-2 items-center flex-wrap text-xs">
              <span className="px-2 py-1 rounded bg-slate-800 font-mono">
                Mode: {mode}
              </span>
              <span className="px-2 py-1 rounded bg-slate-800 font-mono">
                Score: {runtime.score}
              </span>
              <span className="px-2 py-1 rounded bg-slate-700 font-mono text-yellow-200">
                Target: {activeDifficulty.targetScore}
              </span>
              <span className="px-2 py-1 rounded bg-slate-800 font-mono">
                Lives: {runtime.lives}
              </span>
              <span className="px-2 py-1 rounded bg-slate-800 font-mono">
                Loop {runtime.loopLevel + 1}
              </span>
            </div>
          </div>

          {/* World viewport */}
          {/* `FitStage` scales the arena down to whatever is actually left for
              it, and measures the chrome it shares the screen with rather than
              assuming a size: the arena is 756px wide, so on a phone the board
              was being laid out at full size inside a phone-width popup and
              clipped by it. The camera, the lanes and the collision maths all
              read `ARENA_W`/`ARENA_H`, so nothing downstream changes — only the
              scale the whole board is drawn at. */}
          <FitStage width={ARENA_W} height={ARENA_H} minScale={MIN_STAGE_SCALE}>
            <div
              className="relative h-full w-full overflow-hidden"
              style={{
                boxShadow: "0 0 24px 4px rgba(0,0,0,0.8)",
                border: "2px solid #334",
              }}
            >
              {/* Lane background rows */}
              {Array.from({ length: VIEWPORT_ROWS + 2 }).map((_, offsetIdx) => {
                const row = firstVisibleVirtualRow + offsetIdx;
                const rowIndex = mod(row, WORLD_ROWS);
                const type = getRowType(row);
                const screenY = row * CELL - camY;
                const color = LANE_COLORS[type];

                return (
                  <div
                    key={`bg-${row}`}
                    className="absolute"
                    style={{
                      left: 0,
                      top: screenY,
                      width: ARENA_W,
                      height: CELL,
                      backgroundColor: color,
                      borderBottom: "1px solid rgba(0,0,0,0.2)",
                    }}
                  >
                    {/* Road lane markings */}
                    {type === "road" && (
                      <div
                        className="absolute top-1/2 left-0 right-0"
                        style={{ height: 2, marginTop: -1 }}
                      >
                        {Array.from({ length: 14 }).map((_, i) => (
                          <div
                            key={i}
                            className="absolute"
                            style={{
                              left: i * 54,
                              top: 0,
                              width: 26,
                              height: 2,
                              backgroundColor: "rgba(255,255,200,0.15)",
                            }}
                          />
                        ))}
                      </div>
                    )}
                    {/* River wave shimmer */}
                    {type === "river" && (
                      <div
                        className="absolute inset-0 opacity-20"
                        style={{
                          background:
                            "repeating-linear-gradient(90deg, transparent 0, transparent 30px, rgba(255,255,255,0.4) 30px, rgba(255,255,255,0.4) 32px)",
                        }}
                      />
                    )}
                    {/* Home glow */}
                    {type === "home" && (
                      <div
                        className="absolute inset-0"
                        style={{
                          boxShadow: "inset 0 0 20px rgba(255, 196, 80, 0.22)",
                        }}
                      ></div>
                    )}
                    {/* Safe zone edge highlight lines */}
                    {(type === "safe" || type === "checkpoint") &&
                      rowIndex !== START_ROW && (
                        <div
                          className="absolute bottom-0 left-0 right-0"
                          style={{
                            height: 1,
                            backgroundColor: "rgba(255,255,255,0.12)",
                          }}
                        />
                      )}
                    {rowIndex === START_ROW && (
                      <div
                        className="absolute inset-0 opacity-35"
                        style={{
                          background:
                            "repeating-linear-gradient(90deg, transparent 0, transparent 20px, rgba(255,255,255,0.18) 20px, rgba(255,255,255,0.18) 22px)",
                        }}
                      />
                    )}
                  </div>
                );
              })}

              {/* Logs */}
              {runtime.logs
                .filter((l) => !isLogSunk(l, runtime.elapsedMs))
                .map((l) => {
                  const rowCopies: number[] = [];
                  for (
                    let vr = firstVisibleVirtualRow;
                    vr <= lastVisibleVirtualRow;
                    vr += 1
                  ) {
                    if (mod(vr, WORLD_ROWS) === l.worldRow) rowCopies.push(vr);
                  }

                  return rowCopies.flatMap((vr) => {
                    const screenY = vr * CELL - camY;
                    return getWrappedCopies(l.x, l.width).map((ox, ci) => {
                      const armed =
                        l.kind === "fragile" && l.sinkAtMs !== undefined;
                      const remainingMs =
                        armed && l.sinkAtMs
                          ? Math.max(0, l.sinkAtMs - runtime.elapsedMs)
                          : 0;
                      const warningPulse = armed && remainingMs < 1000;
                      return (
                        <div
                          key={`${l.id}-${vr}-${ci}`}
                          className="absolute"
                          style={{
                            left: ox,
                            top: screenY + 8,
                            width: l.width,
                            height: CELL - 16,
                            backgroundColor:
                              l.kind === "fragile" ? "#b7792d" : "#6B3A1F",
                            border:
                              l.kind === "fragile"
                                ? "2px solid #d9a66a"
                                : "2px solid #9C6B3A",
                            borderRadius: 4,
                            boxShadow: warningPulse
                              ? "0 0 10px rgba(255,210,120,0.7), inset 0 3px 0 rgba(255,255,255,0.2)"
                              : "inset 0 3px 0 rgba(255,255,255,0.15)",
                            zIndex: 2,
                          }}
                        >
                          {Array.from({ length: Math.floor(l.width / 18) }).map(
                            (_, gi) => (
                              <div
                                key={gi}
                                className="absolute"
                                style={{
                                  left: gi * 18 + 6,
                                  top: 4,
                                  width: 2,
                                  height: CELL - 24,
                                  backgroundColor: "rgba(0,0,0,0.25)",
                                  borderRadius: 1,
                                }}
                              />
                            ),
                          )}
                        </div>
                      );
                    });
                  });
                })}

              {/* Goblins */}
              {runtime.goblins.map((g) => {
                const rowCopies: number[] = [];
                for (
                  let vr = firstVisibleVirtualRow;
                  vr <= lastVisibleVirtualRow;
                  vr += 1
                ) {
                  if (mod(vr, WORLD_ROWS) === g.worldRow) rowCopies.push(vr);
                }

                return rowCopies.flatMap((vr) => {
                  const screenY = vr * CELL - camY;
                  return getWrappedCopies(g.x, g.width).map((ox, ci) => (
                    <div
                      key={`${g.id}-${vr}-${ci}`}
                      className="absolute flex items-center justify-center"
                      style={{
                        left: ox,
                        top: screenY,
                        width: g.width,
                        height: CELL,
                        zIndex: 5,
                      }}
                    >
                      <img
                        src={SUNNYSIDE.npcs.goblin}
                        alt=""
                        style={{
                          width: CELL - 6,
                          height: CELL - 6,
                          imageRendering: "pixelated",
                          transform: g.dir === -1 ? "scaleX(-1)" : undefined,
                          filter:
                            g.kind === "elite"
                              ? "drop-shadow(0 2px 4px rgba(200,0,0,0.8)) hue-rotate(240deg) saturate(2.5) brightness(1.15)"
                              : "drop-shadow(0 2px 4px rgba(0,0,0,0.6))",
                        }}
                      />
                    </div>
                  ));
                });
              })}

              {/* Player */}
              {runtime.deathPauseMs === 0 && (
                <div
                  className="absolute"
                  style={{
                    // Centred on the collision box and bottom-aligned so the
                    // bumpkin stands on the same lane. The box is
                    // `bumpkinPortraitBox(...)` wide so the canvas - whose width
                    // is measured from the sheet - can be centred inside it.
                    left: runtime.playerCX - portrait.width / 2,
                    top:
                      runtime.playerCY -
                      camY +
                      PLAYER_SIZE / 2 -
                      PLAYER_RENDER_HEIGHT,
                    width: portrait.width,
                    height: PLAYER_RENDER_HEIGHT,
                    zIndex: 20,
                    filter: "drop-shadow(0 3px 6px rgba(0,0,0,0.7))",
                  }}
                >
                  <NPCIcon
                    parts={playerParts}
                    height={PLAYER_RENDER_HEIGHT}
                    facing={runtime.playerFacing}
                  />
                </div>
              )}

              {/* Death overlay */}
              {runtime.deathPauseMs > 0 && (
                <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-30 pointer-events-none">
                  <div className="px-5 py-3 bg-black/80 border-2 border-red-500 rounded-lg text-red-300 font-bold text-sm">
                    {runtime.reason ?? "You died!"}
                  </div>
                </div>
              )}

              {/* Progress bar on right edge */}
              <div
                className="absolute right-0 top-0 bottom-0 w-2 bg-black/30"
                style={{ zIndex: 25 }}
              >
                <div
                  className="absolute bottom-0 w-full bg-yellow-400 transition-all"
                  style={{
                    height: `${loopBandProgress * 100}%`,
                    opacity: 0.85,
                  }}
                />
              </div>
            </div>
          </FitStage>

          {/* Touch controls */}
          {/* Frogger was keyboard-only, which made the cabinet unplayable on a
              phone. `TouchDPad` is not a second input path: each button
              dispatches the real `ArrowLeft`/`ArrowRight`/`ArrowUp`/`ArrowDown`
              keydown and keyup on `window`, which is exactly what the movement
              tick above already polls — so the pad is driveable with no game
              code behind it. It is a *sibling* of the stage rather than a child
              of it, which is the point: `FitStage` sums the height of the board's
              siblings, so the pad's 168px is already being held back from the
              arena and adding a `reserve` for it as well would count it twice.
              `shrink-0` keeps the flex column from squashing it. Gated on
              `(pointer: coarse)`, so a desktop player keeps the keyboard and
              gets no pad in front of them.

              No down arrow: Frogger is a one-way trip up the screen, so
              `ArrowDown` is not a direction that can be travelled. Offering it
              would put a button in the middle of the thumb's arc that cannot do
              anything. */}
          {isTouchDevice && !runtime.gameOver && (
            <div className="sticky bottom-0 z-10 flex justify-center shrink-0 bg-slate-950/95 py-1">
              <TouchDPad directions={["up", "left", "right"]} />
            </div>
          )}

          {/* Game over */}
          {runtime.gameOver && (
            <div
              className={`rounded-lg border-2 p-4 text-center space-y-2 ${
                runtime.won
                  ? "border-green-400 bg-green-900/30"
                  : "border-red-400 bg-red-900/25"
              }`}
            >
              <div className="font-bold text-xl">
                {runtime.won ? "Target Reached!" : "Game Over"}
              </div>
              <div className="text-sm text-slate-300">{runtime.reason}</div>
              <div className="text-sm">
                Final Score:{" "}
                <strong className="text-yellow-300 text-lg">
                  {runtime.score}
                </strong>{" "}
                / Target: <strong>{activeDifficulty.targetScore}</strong>
              </div>
              {mode === "reward" && (
                <div
                  className={`text-sm font-bold ${
                    runtime.won ? "text-green-300" : "text-red-300"
                  }`}
                >
                  {runtime.won
                    ? `Reward earned: ${FROGGER_RAVEN_COIN_REWARD} Raven Coin!`
                    : "Score below target - no reward this run."}
                </div>
              )}
              <div className="flex gap-3 justify-center flex-wrap pt-2">
                <button
                  onClick={returnToMenu}
                  className="px-4 py-2 bg-slate-600 text-white rounded hover:bg-slate-500 active:scale-95 text-sm"
                >
                  MENU
                </button>
                {mode === "practice" && (
                  <button
                    onClick={() => startSession("practice")}
                    className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500 active:scale-95 text-sm"
                  >
                    PLAY AGAIN
                  </button>
                )}
                {onClose && (
                  <button
                    onClick={onClose}
                    className="px-4 py-2 bg-gray-500 text-white rounded hover:bg-gray-400 active:scale-95 text-sm"
                  >
                    EXIT
                  </button>
                )}
              </div>
            </div>
          )}

          {/* In-game quit button */}
          {!runtime.gameOver && (
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowExitConfirm(true)}
                className="px-3 py-1 text-xs bg-gray-700 text-slate-300 rounded hover:bg-gray-600"
              >
                QUIT RUN
              </button>
            </div>
          )}
        </div>

        {/* Quit confirm */}
        {showExitConfirm && !runtime.gameOver && (
          <div className="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4">
            <div className="w-full max-w-md rounded-lg border border-white/20 bg-slate-900 p-5 space-y-4 text-white shadow-xl">
              <h3 className="text-lg font-bold">Quit the run?</h3>
              <p className="text-sm text-slate-400">
                {mode === "reward"
                  ? "Quitting will submit your current score and count the run as used."
                  : "Your progress will be lost."}
              </p>
              <div className="flex gap-3 justify-end">
                <Button onClick={() => setShowExitConfirm(false)}>
                  KEEP PLAYING
                </Button>
                <Button
                  onClick={() => {
                    setShowExitConfirm(false);
                    setRuntime((current) => {
                      if (!current) return current;
                      return {
                        ...current,
                        gameOver: true,
                        won: current.score >= activeDifficulty.targetScore,
                        reason: "Run forfeited.",
                      };
                    });
                  }}
                >
                  QUIT
                </Button>
              </div>
            </div>
          </div>
        )}
      </InnerPanel>
    </OuterPanel>
  );
};
