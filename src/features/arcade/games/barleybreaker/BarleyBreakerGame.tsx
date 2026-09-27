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
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { startAttempt, submitScore } from "../adapters/portalUtil";
import { useVipAccess } from "../adapters/useVipAccess";
import { useRewardRun } from "../adapters/rewardRun";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import {
  BARLEY_BREAKER_DIFFICULTIES,
  BARLEY_BREAKER_RAVEN_COIN_REWARD,
  BarleyBreakerDifficulty,
  BarleyBreakerDifficultyName,
  BarleyBreakerMode,
  getBarleyBreakerDifficulty,
  isBarleyBreakerRewardRunAvailable,
  PowerUpType,
} from "./session";

const _portalState = (state: PortalMachineState) => state.context.state;

const panelClassName =
  "mx-auto w-[min(98vw,1100px)] h-[min(95vh,900px)] overflow-hidden";

const ARENA_WIDTH = 760;
const ARENA_HEIGHT = 560;
const SIDE_GUTTER = 24;
const CEILING_MARGIN = 20;
const BRICK_FIELD_TOP = 52;
const PADDLE_Y = 506;
const PADDLE_WIDTH = 96;
const WIDE_PADDLE_WIDTH = 130;
const PADDLE_HEIGHT = 16;
const PADDLE_SPEED = 540;
const BALL_SIZE = 18;
const BALL_WAVE_SPEED_STEP = 18;
const BALL_WAVE_SPEED_CAP = 72;
const WIDE_PADDLE_DURATION_MS = 18000;
const SLOW_BALL_DURATION_MS = 12000;
const SLOW_BALL_MULTIPLIER = 0.82;
const DROP_SPEED = 140;
const POWERUP_MAX_BALLS = 3;
const BRICK_COLS = 13;
const BRICK_WIDTH = 50;
const BRICK_HEIGHT = 18;
const BRICK_GAP = 4;
const MAX_BOUNCE_ANGLE = Math.PI / 3;

const INTERCEPTED_CODES = new Set([
  "ArrowLeft",
  "ArrowRight",
  "KeyA",
  "KeyD",
  "Space",
]);

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

type Brick = {
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

type Ball = {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  stuck: boolean;
};

type Drop = {
  id: number;
  type: PowerUpType;
  x: number;
  y: number;
  vy: number;
};

type Runtime = {
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

const getPaddleWidth = (runtime: Runtime) => {
  return runtime.widePaddleMs > 0 ? WIDE_PADDLE_WIDTH : PADDLE_WIDTH;
};

const getTemplateForWave = (wave: number) => {
  return WAVE_TEMPLATES[(wave - 1) % WAVE_TEMPLATES.length];
};

const getPseudoRandom = (
  wave: number,
  row: number,
  col: number,
  salt: number,
) => {
  const value =
    Math.sin(wave * 971 + row * 173 + col * 271 + salt * 37) * 43758.5453;
  return value - Math.floor(value);
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

const createHeldBall = (paddleX: number, paddleWidth: number): Ball => ({
  id: Date.now() + Math.floor(Math.random() * 100000),
  x: paddleX + paddleWidth / 2 - BALL_SIZE / 2,
  y: PADDLE_Y - BALL_SIZE - 4,
  vx: 0,
  vy: 0,
  stuck: true,
});

const createInitialRuntime = (difficulty: BarleyBreakerDifficulty): Runtime => {
  const paddleX = ARENA_WIDTH / 2 - PADDLE_WIDTH / 2;

  return {
    paddleX,
    balls: [createHeldBall(paddleX, PADDLE_WIDTH)],
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

export const BarleyBreakerGame: React.FC<{ onClose?: () => void }> = ({
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });

  const hasRewardRun = useMemo(
    () => isBarleyBreakerRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const todaysDifficulty = useMemo(() => getBarleyBreakerDifficulty(), []);

  const [mode, setMode] = useState<BarleyBreakerMode | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [showPracticeDifficultyPrompt, setShowPracticeDifficultyPrompt] =
    useState(false);
  const [practiceDifficultyName, setPracticeDifficultyName] =
    useState<BarleyBreakerDifficultyName>(todaysDifficulty.name);
  const [activeDifficulty, setActiveDifficulty] =
    useState<BarleyBreakerDifficulty>(todaysDifficulty);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const rewardGrantedRef = useRef(false);

  const pressedKeysRef = useRef(new Set<string>());

  const returnToMenu = useCallback(() => {
    pressedKeysRef.current.clear();
    setMode(null);
    setRuntime(null);
    setShowPracticeDifficultyPrompt(false);
    setShowExitConfirm(false);
    rewardGrantedRef.current = false;
  }, []);

  const startSession = useCallback(
    (
      nextMode: BarleyBreakerMode,
      practiceDifficultyOverride?: BarleyBreakerDifficultyName,
    ) => {
      if (nextMode === "reward" && !hasRewardRun) return;

      const selectedPracticeDifficultyName =
        practiceDifficultyOverride ?? practiceDifficultyName;
      const selectedPracticeDifficulty =
        BARLEY_BREAKER_DIFFICULTIES.find(
          (difficulty) => difficulty.name === selectedPracticeDifficultyName,
        ) ?? todaysDifficulty;
      const difficulty =
        nextMode === "reward" ? todaysDifficulty : selectedPracticeDifficulty;

      pressedKeysRef.current.clear();
      setActiveDifficulty(difficulty);
      setMode(nextMode);
      setRuntime(createInitialRuntime(difficulty));
      setShowPracticeDifficultyPrompt(false);
      setShowExitConfirm(false);
      rewardGrantedRef.current = false;

      if (nextMode === "reward") {
        portalService.send({
          type: "arcadeMinigame.started",
          name: "barley-breaker" as any,
        });
        startAttempt();
      }
    },
    [hasRewardRun, practiceDifficultyName, portalService, todaysDifficulty],
  );

  // Free run first, then 1 burned Play Ticket per attempt — with the "are you
  // sure?" box in between. `hasRewardRun` is kept as the availability check so
  // the button and the store can never disagree.
  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "barley-breaker",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  const launchBall = useCallback(() => {
    setRuntime((previous) => {
      if (!previous || previous.gameOver) return previous;

      const speed =
        getWaveBallSpeed(activeDifficulty, previous.wave) *
        previous.speedMultiplier;
      let launched = false;

      const balls = previous.balls.map((ball, index) => {
        if (!ball.stuck) return ball;

        launched = true;
        const direction = index % 2 === 0 ? 1 : -1;
        return {
          ...ball,
          vx: speed * 0.55 * direction,
          vy: -Math.sqrt(
            Math.max(speed * speed - Math.pow(speed * 0.55, 2), 1),
          ),
          stuck: false,
        };
      });

      if (!launched) return previous;

      return {
        ...previous,
        balls,
      };
    });
  }, [activeDifficulty]);

  const tick = useCallback(
    (dtMs: number) => {
      setRuntime((previous) => {
        if (!previous || previous.gameOver) return previous;

        const dt = dtMs / 1000;
        const currentPaddleWidth = getPaddleWidth(previous);
        const movingLeft =
          pressedKeysRef.current.has("ArrowLeft") ||
          pressedKeysRef.current.has("KeyA");
        const movingRight =
          pressedKeysRef.current.has("ArrowRight") ||
          pressedKeysRef.current.has("KeyD");
        const direction = (movingRight ? 1 : 0) - (movingLeft ? 1 : 0);
        const paddleX = clamp(
          previous.paddleX + direction * PADDLE_SPEED * dt,
          SIDE_GUTTER,
          ARENA_WIDTH - SIDE_GUTTER - currentPaddleWidth,
        );

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
        let balls: Ball[] = [];
        const paddleWidth = currentPaddleWidth;
        const paddleRight = paddleX + paddleWidth;
        let collectedWide = false;
        let collectedSlow = false;
        let collectedMultiball = false;
        let collectedExtraLife = false;

        for (const sourceBall of previous.balls) {
          const ball = { ...sourceBall };

          if (ball.stuck) {
            balls.push({
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
            const speed = Math.hypot(nextVx, nextVy);
            const paddleCenter = paddleX + paddleWidth / 2;
            const ballCenter = nextX + BALL_SIZE / 2;
            const normalizedImpact = clamp(
              (ballCenter - paddleCenter) / (paddleWidth / 2),
              -1,
              1,
            );
            const angle = normalizedImpact * MAX_BOUNCE_ANGLE;
            nextVx = speed * Math.sin(angle);
            nextVy = -Math.max(120, Math.abs(speed * Math.cos(angle)));
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
                activeDifficulty.powerUpChance
              ) {
                drops.push({
                  id:
                    Date.now() +
                    hitBrickIndex +
                    Math.floor(Math.random() * 1000),
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

          balls.push({
            ...ball,
            x: nextX,
            y: nextY,
            vx: nextVx,
            vy: nextVy,
          });
        }

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
          lives = Math.min(activeDifficulty.startingLives + 1, lives + 1);
        }
        if (
          collectedMultiball &&
          balls.length > 0 &&
          balls.length < POWERUP_MAX_BALLS
        ) {
          const referenceBall = balls.find((ball) => !ball.stuck) ?? balls[0];
          const speed = Math.max(
            160,
            Math.hypot(referenceBall.vx, referenceBall.vy) ||
              getWaveBallSpeed(activeDifficulty, wave),
          );
          const centerX = referenceBall.x;
          const centerY = referenceBall.y;
          balls = [
            {
              id: referenceBall.id,
              x: centerX,
              y: centerY,
              vx: -speed * 0.7,
              vy: -Math.abs(speed * 0.72),
              stuck: false,
            },
            {
              id: Date.now() + 101,
              x: centerX,
              y: centerY,
              vx: 0,
              vy: -speed,
              stuck: false,
            },
            {
              id: Date.now() + 202,
              x: centerX,
              y: centerY,
              vx: speed * 0.7,
              vy: -Math.abs(speed * 0.72),
              stuck: false,
            },
          ].slice(0, POWERUP_MAX_BALLS);
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

        if (score >= activeDifficulty.targetScore) {
          won = true;
          gameOver = true;
          reason = "Target score reached";
        }

        const remainingBricks = bricks.filter((brick) => brick.alive);
        if (!gameOver && remainingBricks.length === 0) {
          wave += 1;
          bricks = createWaveBricks(wave, activeDifficulty);
          drops = [];
          widePaddleMs = 0;
          slowBallMs = 0;
          balls = [createHeldBall(paddleX, PADDLE_WIDTH)];
        }

        if (!gameOver && balls.length === 0) {
          lives -= 1;

          if (lives <= 0) {
            gameOver = true;
            won = false;
            reason = "Out of lives";
          } else {
            balls = [createHeldBall(paddleX, PADDLE_WIDTH)];
          }
        }

        return {
          ...previous,
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
      });
    },
    [activeDifficulty],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!INTERCEPTED_CODES.has(event.code)) return;
      event.preventDefault();

      pressedKeysRef.current.add(event.code);

      if (event.code === "Space" && mode && runtime && !showExitConfirm) {
        launchBall();
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      pressedKeysRef.current.delete(event.code);
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [launchBall, mode, runtime, showExitConfirm]);

  useEffect(() => {
    if (!mode || showExitConfirm || runtime?.gameOver) return;

    let frame = 0;
    let previousTime = performance.now();

    const loop = (now: number) => {
      const dtMs = Math.min(32, now - previousTime);
      previousTime = now;
      tick(dtMs);
      frame = window.requestAnimationFrame(loop);
    };

    frame = window.requestAnimationFrame(loop);

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [mode, runtime?.gameOver, showExitConfirm, tick]);

  useEffect(() => {
    if (
      mode !== "reward" ||
      !runtime?.gameOver ||
      !runtime.won ||
      rewardGrantedRef.current
    ) {
      return;
    }

    submitScore({ score: runtime.score });
    portalService.send({
      type: "arcadeMinigame.ravenCoinWon",
      amount: BARLEY_BREAKER_RAVEN_COIN_REWARD,
    });
    rewardGrantedRef.current = true;
  }, [mode, portalService, runtime]);

  const brickSummary = useMemo(() => {
    if (!runtime) return 0;
    return runtime.bricks.filter((brick) => brick.alive).length;
  }, [runtime]);

  if (!mode || !runtime) {
    return (
      <OuterPanel className={panelClassName}>
        <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
          <div className="text-center space-y-2">
            <h2 className="text-4xl font-bold">BARLEY BREAKER</h2>
            <p className="text-sm text-gray-600">
              Arkanoid-style block breaker with a barley ball, wave-based walls,
              and score-chase reward runs.
            </p>
          </div>

          <InnerPanel className="bg-yellow-100 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  REWARD
                </div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-yellow-700">
                  {BARLEY_BREAKER_RAVEN_COIN_REWARD}
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
              Reach {todaysDifficulty.targetScore} points. Starting lives:{" "}
              {todaysDifficulty.startingLives}. Ball speed:{" "}
              {todaysDifficulty.baseBallSpeed}.
            </div>
            <div className="mt-1">
              Practice lets you choose the difficulty. Reward mode uses
              today&apos;s daily difficulty.
            </div>
            <div className="mt-1">
              Controls: Arrow keys or A/D to move, Space to launch the barley.
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
                    ? "VIP: reward run available for Barley Breaker today."
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
              Practice the waves without consuming today&apos;s reward attempt.
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
                <h3 className="text-lg font-bold">
                  Select Practice Difficulty
                </h3>
                <p className="text-sm text-slate-200">
                  Choose a difficulty to start practice mode.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {BARLEY_BREAKER_DIFFICULTIES.map((difficulty) => (
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
                      <div className="mt-1 opacity-75">
                        {difficulty.targetScore} pts ·{" "}
                        {difficulty.startingLives} lives
                      </div>
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

  return (
    <OuterPanel className={panelClassName}>
      <InnerPanel className="w-full h-full p-3 md:p-4 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white overflow-auto">
        <div className="max-w-7xl mx-auto h-full flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="font-bold text-lg">
              BARLEY BREAKER - {activeDifficulty.label}
            </div>
            <div className="flex gap-2 items-center flex-wrap">
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
                Wave: {runtime.wave}
              </span>
              <span className="px-2 py-1 rounded bg-slate-700">
                Target: {activeDifficulty.targetScore}
              </span>
            </div>
          </div>

          <div className="mx-auto flex flex-col md:flex-row items-start gap-3">
            <div className="w-full md:w-[190px] rounded border border-white/20 bg-black/40 px-3 py-3 text-xs text-slate-200 space-y-1">
              <div className="font-semibold text-slate-100">Controls</div>
              <div>Move Left: A / Left</div>
              <div>Move Right: D / Right</div>
              <div>Launch: Space</div>
              <div>Exit: Exit Button</div>
            </div>

            <div
              className="relative rounded border border-slate-500 bg-slate-950 overflow-hidden"
              style={{
                width: `${ARENA_WIDTH}px`,
                height: `${ARENA_HEIGHT}px`,
                background:
                  "linear-gradient(180deg, rgba(15, 23, 42, 0.95) 0%, rgba(2, 6, 23, 1) 100%)",
              }}
            >
              <div
                className="absolute inset-x-0"
                style={{
                  top: `${CEILING_MARGIN - 2}px`,
                  height: "2px",
                  background: "rgba(255,255,255,0.15)",
                }}
              />

              {runtime.bricks.map((brick) => {
                if (!brick.alive) return null;

                const background =
                  brick.points === 40
                    ? "#ef4444"
                    : brick.points === 30
                      ? "#f97316"
                      : brick.points === 20
                        ? "#22c55e"
                        : "#eab308";

                return (
                  <div
                    key={brick.id}
                    className="absolute rounded-sm border border-black/20"
                    style={{
                      left: `${brick.x}px`,
                      top: `${brick.y}px`,
                      width: `${brick.width}px`,
                      height: `${brick.height}px`,
                      background: background,
                      boxShadow:
                        brick.maxHp > 1
                          ? "inset 0 0 0 2px rgba(255,255,255,0.45)"
                          : "inset 0 0 0 1px rgba(255,255,255,0.25)",
                      opacity: brick.hp === 2 ? 1 : 0.92,
                    }}
                  />
                );
              })}

              {runtime.drops.map((drop) => (
                <div
                  key={drop.id}
                  className="absolute rounded-full border border-white/30 text-[10px] font-bold text-white grid place-items-center"
                  style={{
                    width: "28px",
                    height: "28px",
                    left: `${drop.x}px`,
                    top: `${drop.y}px`,
                    background:
                      drop.type === "wide-paddle"
                        ? "#2563eb"
                        : drop.type === "slow-ball"
                          ? "#0f766e"
                          : drop.type === "extra-life"
                            ? "#dc2626"
                            : "#7c3aed",
                  }}
                >
                  {drop.type === "wide-paddle"
                    ? "W"
                    : drop.type === "slow-ball"
                      ? "S"
                      : drop.type === "extra-life"
                        ? "+1"
                        : "M"}
                </div>
              ))}

              {runtime.balls.map((ball) => (
                <div
                  key={ball.id}
                  className="absolute rounded-full overflow-hidden border border-white/40"
                  style={{
                    width: `${BALL_SIZE}px`,
                    height: `${BALL_SIZE}px`,
                    left: `${ball.x}px`,
                    top: `${ball.y}px`,
                    boxShadow: "0 0 10px rgba(255, 244, 179, 0.45)",
                    background: "rgba(255,255,255,0.15)",
                  }}
                >
                  <img
                    src={ITEM_DETAILS.Barley.image}
                    alt="Barley ball"
                    className="w-full h-full"
                    style={{ imageRendering: "pixelated" }}
                  />
                </div>
              ))}

              <div
                className="absolute rounded bg-white"
                style={{
                  width: `${getPaddleWidth(runtime)}px`,
                  height: `${PADDLE_HEIGHT}px`,
                  left: `${runtime.paddleX}px`,
                  top: `${PADDLE_Y}px`,
                  background:
                    "linear-gradient(180deg, #f8fafc 0%, #cbd5e1 100%)",
                  boxShadow: "0 2px 10px rgba(255,255,255,0.25)",
                }}
              />

              <div className="absolute left-4 bottom-4 text-xs text-slate-300 space-y-1">
                <div>Bricks left: {brickSummary}</div>
                <div>
                  Effects: {runtime.widePaddleMs > 0 ? "Wide " : ""}
                  {runtime.slowBallMs > 0 ? "Slow " : ""}
                  {runtime.widePaddleMs <= 0 && runtime.slowBallMs <= 0
                    ? "None"
                    : ""}
                </div>
              </div>

              {runtime.gameOver && (
                <div className="absolute inset-0 bg-black/65 flex items-center justify-center p-4">
                  <div className="w-full max-w-sm rounded border border-white/30 bg-slate-900 p-4 space-y-4 text-white text-center">
                    <h3 className="text-2xl font-bold">
                      {runtime.won ? "Board Cleared" : "Run Over"}
                    </h3>
                    <p className="text-sm text-slate-200">{runtime.reason}</p>
                    <div className="text-sm text-slate-300">
                      Final score: {runtime.score}
                    </div>
                    <div className="flex justify-center gap-2">
                      <Button onClick={returnToMenu}>MENU</Button>
                      <Button
                        onClick={() =>
                          startSession(mode, activeDifficulty.name)
                        }
                      >
                        PLAY AGAIN
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="rounded border border-slate-700 bg-slate-900/70 p-3 text-xs text-slate-300 flex flex-wrap items-center justify-between gap-2">
            <div>
              Score by row: 10 / 20 / 30 / 40 from bottom to top. Reach the
              target score to win the run.
            </div>
            <div className="flex gap-2">
              <Button onClick={launchBall}>LAUNCH</Button>
              <Button onClick={() => setShowExitConfirm(true)}>EXIT</Button>
            </div>
          </div>
        </div>

        {showExitConfirm && (
          <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded border border-white/30 bg-slate-900 p-4 space-y-4 text-white">
              <h3 className="text-lg font-bold">Exit Barley Breaker?</h3>
              <p className="text-sm text-slate-200">
                Are you sure you want to exit? Current progress will be lost.
              </p>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setShowExitConfirm(false)}>
                  CANCEL
                </Button>
                <Button onClick={returnToMenu}>EXIT</Button>
              </div>
            </div>
          </div>
        )}
      </InnerPanel>
    </OuterPanel>
  );
};
