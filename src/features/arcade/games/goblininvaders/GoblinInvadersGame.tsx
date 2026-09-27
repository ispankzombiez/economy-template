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
import spaceInvaderMap from "../../assets/space-invader-map.json";
import arcadeTilesheet from "../../assets/nightshade-arcade-tilesheet.png";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import {
  purchase,
  startAttempt,
  submitScore,
} from "../adapters/portalUtil";
import { useVipAccess } from "../adapters/useVipAccess";
import { NPCIcon } from "../adapters/NPCIcon";
import { NPC_WEARABLES } from "lib/npcs";
import {
  EXTRA_REWARD_ATTEMPT_FLOWER_COST,
  getRemainingPaidAttemptsForMinigame,
} from "../poker/session";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import {
  getGoblinInvadersDifficulty,
  isGoblinInvadersRewardRunAvailable,
  GOBLIN_INVADERS_DIFFICULTIES,
  GOBLIN_INVADERS_RAVEN_COIN_REWARD,
  GoblinInvadersDifficulty,
  GoblinInvadersDifficultyName,
  GoblinInvadersMode,
} from "./session";

const _portalState = (state: PortalMachineState) => state.context.state;

const ARENA_WIDTH = 760;
const ARENA_HEIGHT = 560;
const PLAYER_Y = ARENA_HEIGHT - 48;
const PLAYER_SPEED = 420;
const PLAYER_SIZE = 42;
const PLAYER_SHOT_SPEED = 620;
const ENEMY_SHOT_SPEED = 260;
const ENEMY_ROWS = 5;
const ENEMY_COLS = 11;
const ENEMY_WIDTH = 34;
const ENEMY_HEIGHT = 34;
const ENEMY_POINTS_LOW = 10;
const ENEMY_POINTS_MID = 20;
const ENEMY_POINTS_TOP = 30;
const ENEMY_STEP_DISTANCE = 12;
const ENEMY_DROP_DISTANCE = 18;
const ENEMY_STEP_INTERVAL_MIN_MS = 70;
const ENEMY_MAX_ACTIVE_SHOTS = 3;
const SHIELD_COUNT = 4;
const SHIELD_CELL_SIZE = 6;
const SHIELD_CELL_HP = 3;
const MYSTERY_SHIP_WIDTH = 52;
const MYSTERY_SHIP_HEIGHT = 30;
const MYSTERY_SHIP_SPEED = 110;
const MYSTERY_SHIP_Y = 18;
const MYSTERY_SHIP_RESPAWN_MIN_MS = 9000;
const MYSTERY_SHIP_RESPAWN_MAX_MS = 16000;
const LIFE_LOSS_PAUSE_MS = 1800;
const PLAYER_BLINK_INTERVAL_MS = 120;

const INTERCEPTED_CODES = new Set([
  "ArrowLeft",
  "ArrowRight",
  "KeyA",
  "KeyD",
  "Space",
]);

type Projectile = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
};

type Enemy = {
  id: number;
  x: number;
  y: number;
  row: number;
  col: number;
  alive: boolean;
};

type ShieldCell = {
  id: number;
  x: number;
  y: number;
  hp: number;
};

type MysteryShip = {
  active: boolean;
  x: number;
  direction: 1 | -1;
  respawnMs: number;
};

type GoblinInvadersRuntime = {
  playerX: number;
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

type TiledTileLayer = {
  type: "tilelayer";
  visible?: boolean;
  data?: number[];
};

type TiledMap = {
  width: number;
  height: number;
  tilewidth: number;
  tileheight: number;
  layers: Array<TiledTileLayer | { type: string; visible?: boolean }>;
};

const isTileLayer = (
  layer: TiledTileLayer | { type: string; visible?: boolean },
): layer is TiledTileLayer => layer.type === "tilelayer";

const buildArenaBackgroundDataUrl = (
  tiledMap: TiledMap,
  tilesetImage: HTMLImageElement,
  targetWidth: number,
  targetHeight: number,
) => {
  const mapPixelWidth = tiledMap.width * tiledMap.tilewidth;
  const mapPixelHeight = tiledMap.height * tiledMap.tileheight;

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = mapPixelWidth;
  sourceCanvas.height = mapPixelHeight;
  const sourceCtx = sourceCanvas.getContext("2d");

  if (!sourceCtx) return "";

  sourceCtx.imageSmoothingEnabled = false;

  const columns = Math.floor(tilesetImage.width / tiledMap.tilewidth);

  for (const layer of tiledMap.layers) {
    if (!isTileLayer(layer) || layer.visible === false || !layer.data) {
      continue;
    }

    for (let index = 0; index < layer.data.length; index++) {
      const gid = layer.data[index];
      if (!gid) continue;

      const tileId = gid - 1;
      const sx = (tileId % columns) * tiledMap.tilewidth;
      const sy = Math.floor(tileId / columns) * tiledMap.tileheight;
      const dx = (index % tiledMap.width) * tiledMap.tilewidth;
      const dy = Math.floor(index / tiledMap.width) * tiledMap.tileheight;

      sourceCtx.drawImage(
        tilesetImage,
        sx,
        sy,
        tiledMap.tilewidth,
        tiledMap.tileheight,
        dx,
        dy,
        tiledMap.tilewidth,
        tiledMap.tileheight,
      );
    }
  }

  const scaledCanvas = document.createElement("canvas");
  scaledCanvas.width = targetWidth;
  scaledCanvas.height = targetHeight;
  const scaledCtx = scaledCanvas.getContext("2d");

  if (!scaledCtx) return "";

  scaledCtx.imageSmoothingEnabled = false;
  scaledCtx.drawImage(sourceCanvas, 0, 0, targetWidth, targetHeight);

  return scaledCanvas.toDataURL("image/png");
};

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
  const top = PLAYER_Y - 94;
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

const getMysteryShipRespawnMs = () => {
  return (
    MYSTERY_SHIP_RESPAWN_MIN_MS +
    Math.floor(
      Math.random() *
        (MYSTERY_SHIP_RESPAWN_MAX_MS - MYSTERY_SHIP_RESPAWN_MIN_MS),
    )
  );
};

const createMysteryShip = (): MysteryShip => ({
  active: false,
  x: -MYSTERY_SHIP_WIDTH,
  direction: 1,
  respawnMs: getMysteryShipRespawnMs(),
});

const createInitialRuntime = (): GoblinInvadersRuntime => ({
  playerX: ARENA_WIDTH / 2 - PLAYER_SIZE / 2,
  score: 0,
  lives: 3,
  wave: 1,
  enemies: createWaveEnemies(1),
  playerShots: [],
  enemyShots: [],
  shieldCells: createShieldCells(),
  mysteryShip: createMysteryShip(),
  enemyDirection: 1,
  enemyStepTimerMs: 0,
  respawnPauseMs: 0,
  enemyFireCooldownMs: 0,
  shotCooldownMs: 0,
  gameOver: false,
  won: false,
});

const clamp = (value: number, min: number, max: number) => {
  return Math.max(min, Math.min(max, value));
};

const getEnemyPoints = (row: number) => {
  if (row === 0) return ENEMY_POINTS_TOP;
  if (row <= 2) return ENEMY_POINTS_MID;
  return ENEMY_POINTS_LOW;
};

const getMysteryShipPoints = () => {
  const values = [50, 100, 150, 300];
  return values[Math.floor(Math.random() * values.length)];
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

export const GoblinInvadersGame: React.FC<{ onClose?: () => void }> = ({
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });

  const hasRewardRun = useMemo(
    () => isGoblinInvadersRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );
  const hasEnoughFlower =
    Number(portalGameState.balance ?? 0) >= EXTRA_REWARD_ATTEMPT_FLOWER_COST;
  const paidAttemptsRemaining = useMemo(
    () =>
      getRemainingPaidAttemptsForMinigame(portalGameState, "goblin-invaders"),
    [portalGameState],
  );

  const todaysDifficulty = useMemo(() => getGoblinInvadersDifficulty(), []);

  const [mode, setMode] = useState<GoblinInvadersMode | null>(null);
  const [runtime, setRuntime] = useState<GoblinInvadersRuntime | null>(null);
  const [showPracticeDifficultyPrompt, setShowPracticeDifficultyPrompt] =
    useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [arenaBackgroundUrl, setArenaBackgroundUrl] = useState("");
  const [activeDifficulty, setActiveDifficulty] =
    useState<GoblinInvadersDifficulty>(todaysDifficulty);
  const [practiceDifficultyName, setPracticeDifficultyName] =
    useState<GoblinInvadersDifficultyName>(todaysDifficulty.name);

  const pressedKeysRef = useRef<Record<string, boolean>>({});
  const rewardGrantedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  const returnToMenu = useCallback(() => {
    setShowExitConfirm(false);
    setMode(null);
    setRuntime(null);
  }, []);

  const handleInGameExit = useCallback(() => {
    if (runtime?.gameOver) {
      returnToMenu();
      return;
    }

    setShowExitConfirm(true);
  }, [returnToMenu, runtime?.gameOver]);

  const playerParts =
    portalGameState.bumpkin?.equipped ?? NPC_WEARABLES["pumpkin' pete"];

  const startSession = useCallback(
    (
      nextMode: GoblinInvadersMode,
      practiceDifficultyOverride?: GoblinInvadersDifficultyName,
    ) => {
      if (nextMode === "reward" && !hasRewardRun) return;

      const selectedPracticeDifficultyName =
        practiceDifficultyOverride ?? practiceDifficultyName;

      const selectedPracticeDifficulty =
        GOBLIN_INVADERS_DIFFICULTIES.find(
          (difficulty) => difficulty.name === selectedPracticeDifficultyName,
        ) ?? todaysDifficulty;

      const runDifficulty =
        nextMode === "reward" ? todaysDifficulty : selectedPracticeDifficulty;

      setMode(nextMode);
      rewardGrantedRef.current = false;
      setShowPracticeDifficultyPrompt(false);
      setActiveDifficulty(runDifficulty);
      setRuntime(createInitialRuntime());

      if (nextMode === "reward") {
        portalService.send({
          type: "arcadeMinigame.started",
          name: "goblin-invaders" as any,
        });
        startAttempt();
      }
    },
    [hasRewardRun, portalService, practiceDifficultyName, todaysDifficulty],
  );

  const handleShoot = useCallback(() => {
    setRuntime((previous) => {
      if (!previous || previous.gameOver) return previous;
      if (previous.respawnPauseMs > 0) return previous;
      if (previous.playerShots.length > 0) return previous;

      const shot: Projectile = {
        id: Date.now() + Math.floor(Math.random() * 10000),
        x: previous.playerX + PLAYER_SIZE / 2 - 2,
        y: PLAYER_Y - 8,
        vx: 0,
        vy: -PLAYER_SHOT_SPEED,
      };

      return {
        ...previous,
        playerShots: [...previous.playerShots, shot],
        shotCooldownMs: 0,
      };
    });
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const image = new Image();
    image.src = arcadeTilesheet;

    image.onload = () => {
      const dataUrl = buildArenaBackgroundDataUrl(
        spaceInvaderMap as TiledMap,
        image,
        ARENA_WIDTH,
        ARENA_HEIGHT,
      );

      if (dataUrl) {
        setArenaBackgroundUrl(dataUrl);
      }
    };
  }, []);

  useEffect(() => {
    if (!mode) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!INTERCEPTED_CODES.has(event.code)) return;

      pressedKeysRef.current[event.code] = true;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.code === "Space") {
        handleShoot();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!INTERCEPTED_CODES.has(event.code)) return;

      pressedKeysRef.current[event.code] = false;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      pressedKeysRef.current = {};
    };
  }, [handleShoot, mode]);

  const tick = useCallback(
    (previous: GoblinInvadersRuntime, dtMs: number): GoblinInvadersRuntime => {
      if (previous.gameOver) return previous;

      if (previous.respawnPauseMs > 0) {
        return {
          ...previous,
          respawnPauseMs: Math.max(0, previous.respawnPauseMs - dtMs),
        };
      }

      const dt = dtMs / 1000;
      const leftPressed =
        !!pressedKeysRef.current.ArrowLeft || !!pressedKeysRef.current.KeyA;
      const rightPressed =
        !!pressedKeysRef.current.ArrowRight || !!pressedKeysRef.current.KeyD;

      let playerX = previous.playerX;
      if (leftPressed) playerX -= PLAYER_SPEED * dt;
      if (rightPressed) playerX += PLAYER_SPEED * dt;
      playerX = clamp(playerX, 0, ARENA_WIDTH - PLAYER_SIZE);

      let shieldCells = previous.shieldCells;
      let mysteryShip = previous.mysteryShip;

      const aliveEnemies = previous.enemies.filter((enemy) => enemy.alive);
      const aliveCount = aliveEnemies.length;
      const defeatedCount = previous.enemies.length - aliveCount;
      let enemyDirection = previous.enemyDirection;
      let enemyStepTimerMs = previous.enemyStepTimerMs + dtMs;

      const lowestEnemyY = aliveEnemies.reduce((maximum, enemy) => {
        return Math.max(maximum, enemy.y + ENEMY_HEIGHT);
      }, 0);
      const descentPressure = Math.max(0, (lowestEnemyY - 180) / 8);

      const stepIntervalMs = clamp(
        1080 -
          activeDifficulty.baseEnemySpeed * 7 -
          (previous.wave - 1) * 70 -
          defeatedCount * 10 -
          descentPressure,
        ENEMY_STEP_INTERVAL_MIN_MS,
        1000,
      );

      let enemies = previous.enemies;

      // Space Invaders style movement: formation advances in timed steps.
      while (enemyStepTimerMs >= stepIntervalMs) {
        enemyStepTimerMs -= stepIntervalMs;

        const aliveNow = enemies.filter((enemy) => enemy.alive);
        const willTouchWall = aliveNow.some((enemy) => {
          const nextX = enemy.x + enemyDirection * ENEMY_STEP_DISTANCE;
          return nextX <= 8 || nextX + ENEMY_WIDTH >= ARENA_WIDTH - 8;
        });

        if (willTouchWall) {
          enemyDirection = enemyDirection === 1 ? -1 : 1;
          enemies = enemies.map((enemy) => {
            if (!enemy.alive) return enemy;

            return {
              ...enemy,
              y: enemy.y + ENEMY_DROP_DISTANCE,
            };
          });
          continue;
        }

        enemies = enemies.map((enemy) => {
          if (!enemy.alive) return enemy;

          return {
            ...enemy,
            x: enemy.x + enemyDirection * ENEMY_STEP_DISTANCE,
          };
        });
      }

      // Invaders chew through shields when they descend into them.
      shieldCells = shieldCells.filter((cell) => {
        return !enemies.some(
          (enemy) =>
            enemy.alive &&
            cell.x < enemy.x + ENEMY_WIDTH &&
            cell.x + SHIELD_CELL_SIZE > enemy.x &&
            cell.y < enemy.y + ENEMY_HEIGHT &&
            cell.y + SHIELD_CELL_SIZE > enemy.y,
        );
      });

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
              respawnMs: getMysteryShipRespawnMs(),
            }
          : {
              ...mysteryShip,
              x: nextX,
            };
      } else {
        const respawnMs = mysteryShip.respawnMs - dtMs;
        if (respawnMs <= 0) {
          const direction: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
          mysteryShip = {
            active: true,
            direction,
            x: direction === 1 ? -MYSTERY_SHIP_WIDTH : ARENA_WIDTH,
            respawnMs: getMysteryShipRespawnMs(),
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

      let playerShots = previous.playerShots.map((shot) => ({
        ...shot,
        x: shot.x + shot.vx * dt,
        y: shot.y + shot.vy * dt,
      }));
      playerShots = playerShots.filter(
        (shot) => shot.y > -20 && shot.x > -20 && shot.x < ARENA_WIDTH + 20,
      );

      let enemyShots = previous.enemyShots.map((shot) => ({
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
        playerShots = playerShots.filter(
          (s) => !cancelledPlayerShots.has(s.id),
        );
        enemyShots = enemyShots.filter((s) => !cancelledEnemyShots.has(s.id));
      }

      let score = previous.score;

      const aliveEnemyMap = new Map<number, Enemy>();
      enemies.forEach((enemy) => {
        if (enemy.alive) {
          aliveEnemyMap.set(enemy.id, enemy);
        }
      });

      const survivingPlayerShots: Projectile[] = [];

      for (const shot of playerShots) {
        let hit = false;

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

        if (hit) {
          continue;
        }

        if (mysteryShip.active) {
          const hitMysteryShip =
            shot.x < mysteryShip.x + MYSTERY_SHIP_WIDTH &&
            shot.x + 12 > mysteryShip.x &&
            shot.y < MYSTERY_SHIP_Y + MYSTERY_SHIP_HEIGHT &&
            shot.y + 16 > MYSTERY_SHIP_Y;

          if (hitMysteryShip) {
            hit = true;
            score += getMysteryShipPoints();
            mysteryShip = {
              active: false,
              x: -MYSTERY_SHIP_WIDTH,
              direction: 1,
              respawnMs: getMysteryShipRespawnMs(),
            };
            continue;
          }
        }

        for (const enemy of aliveEnemyMap.values()) {
          const intersects =
            shot.x < enemy.x + ENEMY_WIDTH &&
            shot.x + 12 > enemy.x &&
            shot.y < enemy.y + ENEMY_HEIGHT &&
            shot.y + 16 > enemy.y;

          if (intersects) {
            hit = true;
            aliveEnemyMap.delete(enemy.id);
            score += getEnemyPoints(enemy.row);
            break;
          }
        }

        if (!hit) {
          survivingPlayerShots.push(shot);
        }
      }

      enemies = enemies.map((enemy) => ({
        ...enemy,
        alive: aliveEnemyMap.has(enemy.id),
      }));

      let lives = previous.lives;
      const survivingEnemyShots: Projectile[] = [];
      let tookHit = false;

      for (const shot of enemyShots) {
        if (tookHit) {
          continue;
        }

        let absorbedByShield = false;
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

      let enemyFireCooldownMs = previous.enemyFireCooldownMs + dtMs;
      const fireInterval = Math.max(
        180,
        activeDifficulty.baseEnemyFireMs -
          previous.wave * 100 -
          defeatedCount * 10,
      );

      if (
        enemyFireCooldownMs >= fireInterval &&
        survivingEnemyShots.length < ENEMY_MAX_ACTIVE_SHOTS
      ) {
        const fireCandidates = getBottomShooters(enemies);

        if (fireCandidates.length > 0) {
          const source =
            fireCandidates[Math.floor(Math.random() * fireCandidates.length)];
          survivingEnemyShots.push({
            id: Date.now() + Math.floor(Math.random() * 10000),
            x: source.x + ENEMY_WIDTH / 2 - 6,
            y: source.y + ENEMY_HEIGHT - 2,
            vx: 0,
            vy: ENEMY_SHOT_SPEED,
          });
        }

        enemyFireCooldownMs = 0;
      }

      let wave = previous.wave;
      const allEnemiesCleared = enemies.every((enemy) => !enemy.alive);

      if (allEnemiesCleared && score < activeDifficulty.targetScore) {
        wave += 1;
        enemies = createWaveEnemies(wave);
        shieldCells = createShieldCells();
        enemyStepTimerMs = 0;
      }

      const won = score >= activeDifficulty.targetScore;
      const lost =
        !won &&
        (lives <= 0 ||
          enemyReachedPlayer ||
          (wave > activeDifficulty.maxWaves && allEnemiesCleared));

      const reason = won
        ? "Target score reached"
        : lives <= 0
          ? "Out of lives"
          : enemyReachedPlayer
            ? "Invaders reached your line"
            : wave > activeDifficulty.maxWaves && allEnemiesCleared
              ? "Wave limit reached"
              : undefined;

      const respawnPauseMs = tookHit && lives > 0 ? LIFE_LOSS_PAUSE_MS : 0;

      return {
        ...previous,
        playerX,
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
        shotCooldownMs: Math.max(0, previous.shotCooldownMs - dtMs),
        gameOver: won || lost,
        won,
        reason,
      };
    },
    [activeDifficulty],
  );

  useEffect(() => {
    if (!mode || !runtime || runtime.gameOver) {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      lastFrameAtRef.current = null;
      return;
    }

    const loop = (timestamp: number) => {
      const previousAt = lastFrameAtRef.current ?? timestamp;
      const dtMs = Math.min(50, Math.max(8, timestamp - previousAt));
      lastFrameAtRef.current = timestamp;

      setRuntime((previous) => {
        if (!previous) return previous;
        return tick(previous, dtMs);
      });

      frameRef.current = requestAnimationFrame(loop);
    };

    frameRef.current = requestAnimationFrame(loop);

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      lastFrameAtRef.current = null;
    };
  }, [mode, runtime, tick]);

  useEffect(() => {
    if (
      !runtime?.gameOver ||
      !runtime.won ||
      rewardGrantedRef.current ||
      mode !== "reward"
    ) {
      return;
    }

    submitScore({ score: runtime.score });
    portalService.send({
      type: "arcadeMinigame.ravenCoinWon",
      amount: GOBLIN_INVADERS_RAVEN_COIN_REWARD,
    });
    rewardGrantedRef.current = true;
  }, [mode, portalService, runtime]);

  if (!mode || !runtime) {
    return (
      <OuterPanel className="mx-auto w-[min(98vw,1100px)] h-[min(95vh,900px)] overflow-hidden">
        <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
          <div className="text-center space-y-2">
            <h2 className="text-4xl font-bold">GOBLIN INVADERS</h2>
            <p className="text-sm text-gray-600">
              Defend the arcade. Clear goblin invaders and hit today&apos;s
              score target.
            </p>
          </div>

          <InnerPanel className="bg-yellow-100 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  REWARD
                </div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-yellow-700">
                  {GOBLIN_INVADERS_RAVEN_COIN_REWARD}
                  <img
                    src={ravenCoinIcon}
                    alt="RavenCoin"
                    className="w-6 h-6"
                  />
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">TODAY</div>
                <div className="text-2xl font-bold text-yellow-700">
                  {todaysDifficulty.label}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  TARGET
                </div>
                <div className="text-2xl font-bold text-yellow-700">
                  {todaysDifficulty.targetScore}
                </div>
              </div>
            </div>
          </InnerPanel>

          <InnerPanel className="bg-slate-50 p-3 text-sm text-slate-700">
            <div className="font-semibold">Today&apos;s rules</div>
            <div className="mt-1">
              Reach {todaysDifficulty.targetScore} points within{" "}
              {todaysDifficulty.maxWaves} waves.
            </div>
            <div className="mt-1">
              Controls: A/D or Arrow keys to move, Space to fire.
            </div>
          </InnerPanel>

          <button
            onClick={() => startSession("reward")}
            disabled={!hasRewardRun}
            className={`w-full px-6 py-4 rounded-lg font-bold transition-all shadow-lg text-lg ${
              hasRewardRun
                ? "bg-green-500 text-white hover:bg-green-600 active:scale-95"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            <div>START REWARD RUN</div>
            <div className="mt-2 text-xs opacity-90">
              {hasRewardRun
                ? isVip
                  ? "VIP: reward run available for Goblin Invaders today."
                  : "Reward run available for the arcade today."
                : isVip
                  ? "VIP: today&apos;s Goblin Invaders reward run has already been used."
                  : "Today&apos;s arcade reward run has already been used."}
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

          {!hasRewardRun && paidAttemptsRemaining > 0 && (
            <button
              onClick={() =>
                purchase({ sfl: EXTRA_REWARD_ATTEMPT_FLOWER_COST, items: {} })
              }
              disabled={!hasEnoughFlower}
              className={`w-full px-6 py-3 rounded-lg font-bold transition-all shadow-lg text-sm ${
                hasEnoughFlower
                  ? "bg-amber-500 text-white hover:bg-amber-600 active:scale-95"
                  : "bg-gray-300 text-gray-500 cursor-not-allowed"
              }`}
            >
              BUY +1 REWARD ATTEMPT ({EXTRA_REWARD_ATTEMPT_FLOWER_COST} FLOWER)
            </button>
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
                <h3 className="text-lg font-bold">
                  Select Practice Difficulty
                </h3>
                <p className="text-sm text-slate-200">
                  Choose a difficulty to start practice mode.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {GOBLIN_INVADERS_DIFFICULTIES.map((difficulty) => (
                    <button
                      key={difficulty.name}
                      type="button"
                      onClick={() => {
                        setPracticeDifficultyName(difficulty.name);
                        startSession("practice", difficulty.name);
                      }}
                      className={`px-3 py-2 rounded border text-xs font-semibold ${
                        practiceDifficultyName === difficulty.name
                          ? "bg-blue-600 text-white border-blue-700"
                          : "bg-white text-slate-700 border-slate-300"
                      }`}
                    >
                      {difficulty.label}
                    </button>
                  ))}
                </div>
                <div className="text-xs text-slate-300">
                  Reward runs still use today&apos;s difficulty (
                  {todaysDifficulty.label}).
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    onClick={() => setShowPracticeDifficultyPrompt(false)}
                  >
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

  const isPlayerVisible =
    runtime.respawnPauseMs <= 0 ||
    Math.floor(runtime.respawnPauseMs / PLAYER_BLINK_INTERVAL_MS) % 2 === 0;

  return (
    <OuterPanel className="mx-auto w-[min(98vw,1100px)] h-[min(95vh,900px)] overflow-hidden">
      <InnerPanel className="w-full h-full p-3 md:p-4 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white overflow-auto">
        <div className="max-w-6xl mx-auto h-full flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="font-bold text-lg">
              GOBLIN INVADERS - {activeDifficulty.label}
            </div>
            <div className="flex gap-2 items-center">
              <span className="px-2 py-1 rounded bg-slate-700">
                Mode: {mode}
              </span>
              <span className="px-2 py-1 rounded bg-slate-700">
                Score: {runtime.score}
              </span>
              <span className="px-2 py-1 rounded bg-slate-700">
                Lives: {runtime.lives}
              </span>
              <span className="px-2 py-1 rounded bg-slate-700">
                Wave: {runtime.wave}/{activeDifficulty.maxWaves}
              </span>
              <span className="px-2 py-1 rounded bg-slate-700">
                Target: {activeDifficulty.targetScore}
              </span>
            </div>
          </div>

          <div
            className="relative mx-auto rounded border border-slate-500 bg-slate-950 overflow-hidden"
            style={{
              width: `${ARENA_WIDTH}px`,
              height: `${ARENA_HEIGHT}px`,
              backgroundImage: `linear-gradient(to bottom, rgba(2, 6, 23, 0.2), rgba(2, 6, 23, 0.25)), url(${arenaBackgroundUrl || SUNNYSIDE.brand.water_landing})`,
              backgroundSize: "100% 100%",
              backgroundPosition: "center",
            }}
          >
            {runtime.mysteryShip.active && (
              <img
                src={SUNNYSIDE.npcs.goblin}
                className="absolute"
                style={{
                  width: `${MYSTERY_SHIP_WIDTH}px`,
                  height: `${MYSTERY_SHIP_HEIGHT}px`,
                  left: `${runtime.mysteryShip.x}px`,
                  top: `${MYSTERY_SHIP_Y}px`,
                  imageRendering: "pixelated",
                  filter: "hue-rotate(250deg) saturate(160%) brightness(1.3)",
                }}
                alt="Mystery ship"
              />
            )}

            {runtime.enemies
              .filter((enemy) => enemy.alive)
              .map((enemy) => (
                <img
                  key={enemy.id}
                  src={SUNNYSIDE.npcs.goblin}
                  className="absolute"
                  style={{
                    width: `${ENEMY_WIDTH}px`,
                    height: `${ENEMY_HEIGHT}px`,
                    left: `${enemy.x}px`,
                    top: `${enemy.y}px`,
                    imageRendering: "pixelated",
                  }}
                  alt="Goblin invader"
                />
              ))}

            {runtime.shieldCells.map((cell) => (
              <div
                key={cell.id}
                className="absolute"
                style={{
                  width: `${SHIELD_CELL_SIZE}px`,
                  height: `${SHIELD_CELL_SIZE}px`,
                  left: `${cell.x}px`,
                  top: `${cell.y}px`,
                  background:
                    cell.hp === 3
                      ? "#86efac"
                      : cell.hp === 2
                        ? "#4ade80"
                        : "#16a34a",
                  boxShadow: "inset 0 0 0 1px rgba(2, 6, 23, 0.35)",
                }}
              />
            ))}

            {runtime.playerShots.map((shot) => (
              <div
                key={shot.id}
                className="absolute"
                style={{
                  width: "4px",
                  height: "18px",
                  left: `${shot.x}px`,
                  top: `${shot.y}px`,
                  background:
                    "linear-gradient(180deg, #ffffff 0%, #ffe066 40%, #ff8800 100%)",
                  borderRadius: "2px",
                  boxShadow: "0 0 5px 2px rgba(255, 210, 60, 0.8)",
                }}
              />
            ))}

            {runtime.enemyShots.map((shot) => (
              <img
                key={shot.id}
                src={ITEM_DETAILS.Potato.image}
                className="absolute"
                style={{
                  width: "14px",
                  height: "14px",
                  left: `${shot.x}px`,
                  top: `${shot.y}px`,
                  imageRendering: "pixelated",
                }}
                alt="Enemy projectile"
              />
            ))}

            <div
              className="absolute"
              style={{
                width: `${PLAYER_SIZE}px`,
                height: `${PLAYER_SIZE}px`,
                left: `${runtime.playerX}px`,
                top: `${PLAYER_Y}px`,
              }}
            >
              {isPlayerVisible && (
                <NPCIcon parts={playerParts} width={PLAYER_SIZE} />
              )}
            </div>

            {runtime.respawnPauseMs > 0 && (
              <div className="absolute inset-0 pointer-events-none grid place-items-center">
                <div className="px-3 py-1 rounded bg-black/60 text-xs text-yellow-300 border border-yellow-500/40">
                  Recovering...
                </div>
              </div>
            )}
          </div>

          {runtime.gameOver && (
            <div
              className={`rounded border-2 p-3 text-center ${
                runtime.won
                  ? "border-green-400 bg-green-900/40"
                  : "border-red-400 bg-red-900/30"
              }`}
            >
              <div className="font-bold text-lg">
                {runtime.won ? "Invaders Defeated!" : "Run Failed"}
              </div>
              <div className="text-sm mt-1">
                {runtime.reason}. Final score: {runtime.score}.
                {runtime.won && mode === "reward"
                  ? ` Reward granted: ${GOBLIN_INVADERS_RAVEN_COIN_REWARD} RavenCoin.`
                  : ""}
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {mode === "practice" && (
              <Button onClick={() => startSession("practice")}>
                Restart Practice Run
              </Button>
            )}
            {onClose && <Button onClick={handleInGameExit}>Exit</Button>}
          </div>

          <div className="text-xs text-slate-300">
            Move with A/D or Arrow keys. Press Space to shoot. Enemy speed and
            fire rate increase as waves progress. Use shields for cover and
            shoot the mystery ship for bonus points.
          </div>

          {showExitConfirm && (
            <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
              <div className="w-full max-w-sm bg-slate-900 rounded border border-white/30 p-5 text-white space-y-4">
                <div className="font-bold text-lg">Exit Goblin Invaders?</div>
                <div className="text-sm text-slate-300">
                  Your current progress will be lost.
                </div>
                <div className="flex gap-3 justify-end">
                  <Button onClick={() => setShowExitConfirm(false)}>
                    Cancel
                  </Button>
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
        </div>
      </InnerPanel>
    </OuterPanel>
  );
};
