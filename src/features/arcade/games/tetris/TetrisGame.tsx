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
import { startAttempt, submitScore } from "../adapters/portalUtil";
import { useVipAccess } from "../adapters/useVipAccess";
import { useRewardRun } from "../adapters/rewardRun";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import {
  getTetrisDifficulty,
  isTetrisRewardRunAvailable,
  TETRIS_DIFFICULTIES,
  TETRIS_RAVEN_COIN_REWARD,
  TetrisDifficulty,
  TetrisDifficultyName,
  TetrisMode,
} from "./session";

const _portalState = (state: PortalMachineState) => state.context.state;

const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 20;
const TILE_SIZE = 24;
const SOFT_DROP_MULTIPLIER = 5;
const LINES_PER_LEVEL = 10;
const MAX_LEVEL = 12;

const getGuidelineFallIntervalMs = (level: number): number => {
  const capped = Math.min(level, MAX_LEVEL);
  return Math.pow(0.8 - (capped - 1) * 0.007, capped - 1) * 1000;
};

const INTERCEPTED_CODES = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "KeyZ",
  "KeyX",
  "KeyQ",
  "Space",
]);

type TetrominoKind = "I" | "O" | "T" | "S" | "Z" | "J" | "L";
type Cell = TetrominoKind | null;
type Board = Cell[][];
type Position = { x: number; y: number };
type Piece = { kind: TetrominoKind; rotation: number; x: number; y: number };

type TetrisRuntime = {
  board: Board;
  active: Piece;
  queue: TetrominoKind[];
  hold: TetrominoKind | null;
  holdUsed: boolean;
  level: number;
  score: number;
  linesCleared: number;
  dropAccumulatorMs: number;
  gameOver: boolean;
  won: boolean;
  reason?: string;
};

const PIECE_ORDER: TetrominoKind[] = ["I", "O", "T", "S", "Z", "J", "L"];

const PIECE_IMAGES: Record<TetrominoKind, string> = {
  I: ITEM_DETAILS.Corn.image,
  O: ITEM_DETAILS.Potato.image,
  T: ITEM_DETAILS.Pumpkin.image,
  S: ITEM_DETAILS.Carrot.image,
  Z: ITEM_DETAILS.Tomato.image,
  J: ITEM_DETAILS.Wheat.image,
  L: ITEM_DETAILS.Sunflower.image,
};

const SHAPES: Record<TetrominoKind, Position[][]> = {
  I: [
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
    ],
    [
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
      { x: 2, y: 3 },
    ],
    [
      { x: 0, y: 2 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
      { x: 3, y: 2 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 1, y: 3 },
    ],
  ],
  O: [
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
  ],
  T: [
    [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
    ],
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
    ],
    [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ],
  ],
  S: [
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ],
    [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
    ],
    [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ],
  ],
  Z: [
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 1, y: 2 },
    ],
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ],
    [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 0, y: 2 },
    ],
  ],
  J: [
    [
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ],
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 2 },
      { x: 1, y: 2 },
    ],
  ],
  L: [
    [
      { x: 2, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ],
    [
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 2 },
    ],
    [
      { x: 0, y: 1 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 0, y: 2 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
    ],
  ],
};

const createBoard = (): Board =>
  Array.from({ length: BOARD_HEIGHT }, () =>
    Array<Cell>(BOARD_WIDTH).fill(null),
  );

const spawnPiece = (kind: TetrominoKind): Piece => ({
  kind,
  rotation: 0,
  x: 3,
  y: 0,
});

const getCells = (piece: Piece) =>
  SHAPES[piece.kind][piece.rotation].map((c) => ({
    x: piece.x + c.x,
    y: piece.y + c.y,
  }));

const isValid = (board: Board, piece: Piece) => {
  return getCells(piece).every((cell) => {
    if (cell.x < 0 || cell.x >= BOARD_WIDTH) return false;
    if (cell.y < 0 || cell.y >= BOARD_HEIGHT) return false;
    return board[cell.y][cell.x] === null;
  });
};

const mergePiece = (board: Board, piece: Piece): Board => {
  const next = board.map((row) => [...row]);

  for (const cell of getCells(piece)) {
    if (
      cell.y >= 0 &&
      cell.y < BOARD_HEIGHT &&
      cell.x >= 0 &&
      cell.x < BOARD_WIDTH
    ) {
      next[cell.y][cell.x] = piece.kind;
    }
  }

  return next;
};

const clearLines = (board: Board) => {
  const remaining = board.filter((row) => row.some((cell) => cell === null));
  const cleared = BOARD_HEIGHT - remaining.length;
  const padding = Array.from({ length: cleared }, () =>
    Array<Cell>(BOARD_WIDTH).fill(null),
  );

  return {
    board: [...padding, ...remaining],
    cleared,
  };
};

const scoreForLines = (lines: number, level: number) => {
  if (lines <= 0) return 0;
  const base = lines === 1 ? 100 : lines === 2 ? 300 : lines === 3 ? 500 : 800;
  return base * level;
};

const shuffledBag = () => {
  const bag = [...PIECE_ORDER];

  for (let index = bag.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const temp = bag[index];
    bag[index] = bag[swapIndex];
    bag[swapIndex] = temp;
  }

  return bag;
};

const ensureQueue = (queue: TetrominoKind[]) => {
  if (queue.length >= 7) return queue;
  return [...queue, ...shuffledBag()];
};

const popNextPiece = (queue: TetrominoKind[]) => {
  const prepared = ensureQueue(queue);
  const nextKind = prepared[0];
  const remaining = prepared.slice(1);

  return {
    nextKind,
    queue: ensureQueue(remaining),
  };
};

const withLockedPiece = (
  runtime: TetrisRuntime,
  difficulty: TetrisDifficulty,
): TetrisRuntime => {
  const merged = mergePiece(runtime.board, runtime.active);
  const { board, cleared } = clearLines(merged);
  const newLinesCleared = runtime.linesCleared + cleared;
  const newLevel = Math.min(
    difficulty.startLevel + Math.floor(newLinesCleared / LINES_PER_LEVEL),
    MAX_LEVEL,
  );
  const gained = scoreForLines(cleared, newLevel);
  const score = runtime.score + gained;
  const won = score >= difficulty.targetScore;

  if (won) {
    return {
      ...runtime,
      board,
      score,
      level: newLevel,
      linesCleared: newLinesCleared,
      gameOver: true,
      won: true,
      reason: "Target score reached",
    };
  }

  const { nextKind, queue } = popNextPiece(runtime.queue);
  const nextPiece = spawnPiece(nextKind);

  if (!isValid(board, nextPiece)) {
    return {
      ...runtime,
      board,
      score,
      level: newLevel,
      linesCleared: newLinesCleared,
      queue,
      active: nextPiece,
      gameOver: true,
      won: false,
      reason: "Board overflow",
    };
  }

  return {
    ...runtime,
    board,
    score,
    level: newLevel,
    linesCleared: newLinesCleared,
    queue,
    active: nextPiece,
    holdUsed: false,
    dropAccumulatorMs: 0,
  };
};

const movePiece = (runtime: TetrisRuntime, dx: number, dy: number) => {
  const moved: Piece = {
    ...runtime.active,
    x: runtime.active.x + dx,
    y: runtime.active.y + dy,
  };

  if (!isValid(runtime.board, moved)) {
    return null;
  }

  return {
    ...runtime,
    active: moved,
  };
};

const rotatePiece = (
  runtime: TetrisRuntime,
  direction: 1 | -1,
): TetrisRuntime => {
  const nextRotation = (runtime.active.rotation + direction + 4) % 4;
  const rotated = {
    ...runtime.active,
    rotation: nextRotation,
  };

  const kicks = [0, -1, 1, -2, 2];

  for (const kick of kicks) {
    const candidate = {
      ...rotated,
      x: rotated.x + kick,
    };

    if (isValid(runtime.board, candidate)) {
      return {
        ...runtime,
        active: candidate,
      };
    }
  }

  return runtime;
};

const hardDrop = (
  runtime: TetrisRuntime,
  difficulty: TetrisDifficulty,
): TetrisRuntime => {
  let dropped = runtime;
  let distance = 0;

  for (let step = 0; step < BOARD_HEIGHT; step++) {
    const moved = movePiece(dropped, 0, 1);
    if (!moved) break;
    dropped = moved;
    distance += 1;
  }

  const withDropScore = {
    ...dropped,
    score: dropped.score + distance * 2,
  };

  return withLockedPiece(withDropScore, difficulty);
};

const createInitialRuntime = (startLevel: number): TetrisRuntime => {
  const initialQueue = ensureQueue(shuffledBag());
  const { nextKind, queue } = popNextPiece(initialQueue);

  return {
    board: createBoard(),
    active: spawnPiece(nextKind),
    queue,
    hold: null,
    holdUsed: false,
    level: startLevel,
    score: 0,
    linesCleared: 0,
    dropAccumulatorMs: 0,
    gameOver: false,
    won: false,
  };
};

const MiniPiece: React.FC<{ kind: TetrominoKind | null }> = ({ kind }) => {
  if (!kind) {
    return <div className="text-xs text-slate-300">-</div>;
  }

  const cells = SHAPES[kind][0];

  return (
    <div className="relative w-[64px] h-[64px] bg-slate-900/60 border border-slate-600 rounded">
      {cells.map((cell, index) => (
        <img
          key={`${kind}-${index}`}
          src={PIECE_IMAGES[kind]}
          className="absolute"
          alt={`${kind} piece preview`}
          style={{
            width: "14px",
            height: "14px",
            left: `${cell.x * 14 + 4}px`,
            top: `${cell.y * 14 + 4}px`,
            imageRendering: "pixelated",
          }}
        />
      ))}
    </div>
  );
};

export const TetrisGame: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });

  const hasRewardRun = useMemo(
    () => isTetrisRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const todaysDifficulty = useMemo(() => getTetrisDifficulty(), []);

  const [mode, setMode] = useState<TetrisMode | null>(null);
  const [runtime, setRuntime] = useState<TetrisRuntime | null>(null);
  const [showPracticeDifficultyPrompt, setShowPracticeDifficultyPrompt] =
    useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [activeDifficulty, setActiveDifficulty] =
    useState<TetrisDifficulty>(todaysDifficulty);
  const [practiceDifficultyName, setPracticeDifficultyName] =
    useState<TetrisDifficultyName>(todaysDifficulty.name);

  const rewardGrantedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const softDropPressedRef = useRef(false);

  const returnToMenu = useCallback(() => {
    setShowExitConfirm(false);
    setMode(null);
    setRuntime(null);
    softDropPressedRef.current = false;
  }, []);

  const handleInGameExit = useCallback(() => {
    if (runtime?.gameOver) {
      returnToMenu();
      return;
    }

    setShowExitConfirm(true);
  }, [returnToMenu, runtime?.gameOver]);

  const startSession = useCallback(
    (
      nextMode: TetrisMode,
      practiceDifficultyOverride?: TetrisDifficultyName,
    ) => {
      if (nextMode === "reward" && !hasRewardRun) return;

      const chosenPracticeName =
        practiceDifficultyOverride ?? practiceDifficultyName;
      const selectedPracticeDifficulty =
        TETRIS_DIFFICULTIES.find(
          (difficulty) => difficulty.name === chosenPracticeName,
        ) ?? todaysDifficulty;

      const runDifficulty =
        nextMode === "reward" ? todaysDifficulty : selectedPracticeDifficulty;

      setMode(nextMode);
      setActiveDifficulty(runDifficulty);
      setShowPracticeDifficultyPrompt(false);
      setRuntime(createInitialRuntime(runDifficulty.startLevel));
      rewardGrantedRef.current = false;
      softDropPressedRef.current = false;

      if (nextMode === "reward") {
        portalService.send({
          type: "arcadeMinigame.started",
          name: "tetris" as any,
        });
        startAttempt();
      }
    },
    [hasRewardRun, portalService, practiceDifficultyName, todaysDifficulty],
  );

  // Free run first, then 1 burned Play Ticket per attempt — with the "are you
  // sure?" box in between. `hasRewardRun` is kept as the availability check so
  // the button and the store can never disagree.
  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "tetris",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  const tryMove = useCallback((dx: number, dy: number, onLock?: () => void) => {
    setRuntime((previous) => {
      if (!previous || previous.gameOver) return previous;

      const moved = movePiece(previous, dx, dy);
      if (!moved) {
        onLock?.();
        return previous;
      }

      const bonusScore = dy > 0 ? 1 : 0;

      return {
        ...moved,
        score: moved.score + bonusScore,
      };
    });
  }, []);

  const tryRotate = useCallback((direction: 1 | -1) => {
    setRuntime((previous) => {
      if (!previous || previous.gameOver) return previous;
      return rotatePiece(previous, direction);
    });
  }, []);

  const tryHold = useCallback(() => {
    setRuntime((previous) => {
      if (!previous || previous.gameOver || previous.holdUsed) return previous;

      const nextHold = previous.active.kind;

      if (!previous.hold) {
        const { nextKind, queue } = popNextPiece(previous.queue);
        const active = spawnPiece(nextKind);

        if (!isValid(previous.board, active)) {
          return {
            ...previous,
            gameOver: true,
            reason: "Board overflow",
          };
        }

        return {
          ...previous,
          hold: nextHold,
          queue,
          active,
          holdUsed: true,
        };
      }

      const swapped = spawnPiece(previous.hold);
      if (!isValid(previous.board, swapped)) {
        return {
          ...previous,
          gameOver: true,
          reason: "Board overflow",
        };
      }

      return {
        ...previous,
        hold: nextHold,
        active: swapped,
        holdUsed: true,
      };
    });
  }, []);

  const doHardDrop = useCallback(() => {
    setRuntime((previous) => {
      if (!previous || previous.gameOver) return previous;
      return hardDrop(previous, activeDifficulty);
    });
  }, [activeDifficulty]);

  useEffect(() => {
    if (!mode) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!INTERCEPTED_CODES.has(event.code)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.code === "ArrowDown") {
        softDropPressedRef.current = true;
        if (!event.repeat) {
          tryMove(0, 1);
        }
        return;
      }

      if (
        event.repeat &&
        event.code !== "ArrowLeft" &&
        event.code !== "ArrowRight"
      ) {
        return;
      }

      if (event.code === "ArrowLeft") {
        tryMove(-1, 0);
        return;
      }

      if (event.code === "ArrowRight") {
        tryMove(1, 0);
        return;
      }

      if (event.code === "ArrowUp" || event.code === "KeyX") {
        tryRotate(1);
        return;
      }

      if (event.code === "KeyZ") {
        tryRotate(-1);
        return;
      }

      if (event.code === "KeyQ") {
        tryHold();
        return;
      }

      if (event.code === "Space") {
        doHardDrop();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!INTERCEPTED_CODES.has(event.code)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      if (event.code === "ArrowDown") {
        softDropPressedRef.current = false;
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      softDropPressedRef.current = false;
    };
  }, [doHardDrop, mode, tryHold, tryMove, tryRotate]);

  const tick = useCallback(
    (previous: TetrisRuntime, dtMs: number): TetrisRuntime => {
      if (previous.gameOver) return previous;

      const baseDropInterval = getGuidelineFallIntervalMs(previous.level);

      const dropInterval = softDropPressedRef.current
        ? baseDropInterval / SOFT_DROP_MULTIPLIER
        : baseDropInterval;

      let working = {
        ...previous,
        dropAccumulatorMs: previous.dropAccumulatorMs + dtMs,
      };

      while (working.dropAccumulatorMs >= dropInterval && !working.gameOver) {
        working = {
          ...working,
          dropAccumulatorMs: working.dropAccumulatorMs - dropInterval,
        };

        const moved = movePiece(working, 0, 1);

        if (!moved) {
          working = withLockedPiece(working, activeDifficulty);
        } else {
          working = moved;
        }
      }

      return working;
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
      const dtMs = Math.min(60, Math.max(8, timestamp - previousAt));
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
      amount: TETRIS_RAVEN_COIN_REWARD,
    });
    rewardGrantedRef.current = true;
  }, [mode, portalService, runtime]);

  const renderedBoard = useMemo(() => {
    if (!runtime) return createBoard();

    const overlay = runtime.board.map((row) => [...row]);

    for (const cell of getCells(runtime.active)) {
      if (
        cell.y >= 0 &&
        cell.y < BOARD_HEIGHT &&
        cell.x >= 0 &&
        cell.x < BOARD_WIDTH
      ) {
        overlay[cell.y][cell.x] = runtime.active.kind;
      }
    }

    return overlay;
  }, [runtime]);

  if (!mode || !runtime) {
    return (
      <OuterPanel className="mx-auto w-[min(98vw,1100px)] h-[min(95vh,900px)] overflow-hidden">
        <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
          <div className="text-center space-y-2">
            <h2 className="text-4xl font-bold">TETRIS</h2>
            <p className="text-sm text-gray-600">
              Stack crop blocks, clear rows, and hit today&apos;s score target.
            </p>
          </div>

          <InnerPanel className="bg-amber-50 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  REWARD
                </div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-amber-800">
                  {TETRIS_RAVEN_COIN_REWARD}
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

          <InnerPanel className="bg-slate-50 p-3 text-sm text-slate-700">
            <div className="font-semibold">Controls</div>
            <div className="mt-1">
              Left/Right to move, Down to soft drop, Space for hard drop.
            </div>
            <div className="mt-1">
              Up or X rotates clockwise, Z rotates counter-clockwise.
            </div>
            <div className="mt-1">
              Press Q to hold/swap your active piece once per drop.
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
                    ? "VIP: reward run available for Tetris today."
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
                <h3 className="text-lg font-bold">
                  Select Practice Difficulty
                </h3>
                <p className="text-sm text-slate-200">
                  Choose a difficulty to start practice mode.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {TETRIS_DIFFICULTIES.map((difficulty) => (
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

  return (
    <OuterPanel className="mx-auto w-[min(98vw,1100px)] h-[min(95vh,900px)] overflow-hidden">
      <InnerPanel className="w-full h-full p-3 md:p-4 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white overflow-auto">
        <div className="max-w-6xl mx-auto h-full flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="font-bold text-lg">
              TETRIS - {activeDifficulty.label}
            </div>
            <div className="flex gap-2 items-center">
              <span className="px-2 py-1 rounded bg-slate-700">
                Mode: {mode}
              </span>
              <span className="px-2 py-1 rounded bg-slate-700">
                Lvl: {runtime.level}
              </span>
              <span className="px-2 py-1 rounded bg-slate-700">
                Score: {runtime.score}
              </span>
              <span className="px-2 py-1 rounded bg-slate-700">
                Lines: {runtime.linesCleared}
              </span>
              <span className="px-2 py-1 rounded bg-slate-700">
                Target: {activeDifficulty.targetScore}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap gap-4 justify-center items-start">
            <div className="w-[190px] space-y-3 rounded border border-slate-600 bg-slate-900/70 p-3">
              <div>
                <div className="text-xs font-semibold tracking-wide text-slate-300">
                  CONTROLS
                </div>
                <div className="mt-2 space-y-1 text-xs text-slate-100">
                  <div>Left / Right - Move</div>
                  <div>Down - Soft Drop</div>
                  <div>Space - Hard Drop</div>
                  <div>Up or X - Rotate CW</div>
                  <div>Z - Rotate CCW</div>
                  <div>Q - Hold / Swap</div>
                </div>
              </div>

              <div className="border-t border-slate-600 pt-3">
                <div className="text-xs font-semibold text-slate-300">HOLD</div>
                <div className="mt-2">
                  <MiniPiece kind={runtime.hold} />
                </div>
              </div>
            </div>

            <div
              className="relative rounded border border-slate-500 bg-slate-950 overflow-hidden"
              style={{
                width: `${BOARD_WIDTH * TILE_SIZE}px`,
                height: `${BOARD_HEIGHT * TILE_SIZE}px`,
              }}
            >
              {renderedBoard.map((row, y) =>
                row.map((cell, x) => {
                  if (!cell) {
                    return (
                      <div
                        key={`${x}-${y}`}
                        className="absolute border border-slate-800/60"
                        style={{
                          left: `${x * TILE_SIZE}px`,
                          top: `${y * TILE_SIZE}px`,
                          width: `${TILE_SIZE}px`,
                          height: `${TILE_SIZE}px`,
                        }}
                      />
                    );
                  }

                  return (
                    <div
                      key={`${x}-${y}`}
                      className="absolute border border-black/30 bg-emerald-200/20"
                      style={{
                        left: `${x * TILE_SIZE}px`,
                        top: `${y * TILE_SIZE}px`,
                        width: `${TILE_SIZE}px`,
                        height: `${TILE_SIZE}px`,
                      }}
                    >
                      <img
                        src={PIECE_IMAGES[cell]}
                        alt={`${cell} tile`}
                        className="w-full h-full p-[2px]"
                        style={{ imageRendering: "pixelated" }}
                      />
                    </div>
                  );
                }),
              )}
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold text-slate-300">NEXT</div>
              <div className="space-y-2">
                {runtime.queue.slice(0, 3).map((kind, index) => (
                  <MiniPiece key={`${kind}-${index}`} kind={kind} />
                ))}
              </div>
            </div>
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
                {runtime.won ? "Harvest Complete!" : "Run Failed"}
              </div>
              <div className="text-sm mt-1">
                {runtime.reason}. Final score: {runtime.score}.
                {runtime.won && mode === "reward"
                  ? ` Reward granted: ${TETRIS_RAVEN_COIN_REWARD} RavenCoin.`
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

          {showExitConfirm && (
            <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
              <div className="w-full max-w-sm bg-slate-900 rounded border border-white/30 p-5 text-white space-y-4">
                <div className="font-bold text-lg">Exit Tetris?</div>
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
