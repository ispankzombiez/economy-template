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
import {
  TouchButton,
  useHeldKeys,
  useIsTouchDevice,
} from "components/ui/TouchControls";
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

  // The box and the cells inside it are one number, `--cell`, read by both, so
  // they can never disagree. It is 14 on a desktop and 10 on a phone because the
  // phone preview column is 44px rather than 64px — 44 is the smallest box a
  // whole four-wide tetromino fits into at a recognisable cell size
  // (3 x 10 + 2 x 2 = 34, plus the 10px cell = 44), and the previews are
  // informational: the board is the thing a thumb has to read.
  //
  // The phone size is also load-bearing in the other direction. `FitStage`
  // reserves the height of its siblings, so this column's height comes *out* of
  // the board's: taller previews mean a smaller board, and vice versa. See the
  // play row's note for the numbers that fix it in the middle.
  return (
    <div className="relative w-[var(--cell-size)] h-[var(--cell-size)] bg-slate-900/60 border border-slate-600 rounded [--cell-size:44px] [--cell:10px] [--cell-inset:2px] md:[--cell-size:64px] md:[--cell:14px] md:[--cell-inset:4px]">
      {cells.map((cell, index) => (
        <img
          key={`${kind}-${index}`}
          src={PIECE_IMAGES[kind]}
          className="absolute w-[var(--cell)] h-[var(--cell)]"
          alt={`${kind} piece preview`}
          style={{
            left: `calc(${cell.x} * var(--cell) + var(--cell-inset))`,
            top: `calc(${cell.y} * var(--cell) + var(--cell-inset))`,
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

  // Tetris is keyboard-only, which made the cabinet unplayable on a phone.
  // Gated on `(pointer: coarse)` so a desktop player keeps the keyboard and
  // gets no pad in front of them.
  const isTouchDevice = useIsTouchDevice();

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

  // One key set shared by the four touch buttons, so a press that overlaps
  // (thumb rolling from LEFT to ROTATE) releases the key it left rather than
  // leaving it stuck down.
  const held = useHeldKeys();

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
      <OuterPanel className="mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden">
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

  // The three upcoming pieces, rendered into whichever of the two places the
  // current breakpoint puts them: the column beside the board on a phone, the
  // 64px strip to its right from `md` up. One element rather than two copies
  // of the same markup, so the two can never drift apart.
  const nextQueue = (
    <>
      <div className="text-xs font-semibold text-slate-300">NEXT</div>
      <div className="flex flex-col gap-2 justify-center">
        {runtime.queue.slice(0, 3).map((kind, index) => (
          <MiniPiece key={`${kind}-${index}`} kind={kind} />
        ))}
      </div>
    </>
  );

  return (
    <OuterPanel className="mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden">
      <InnerPanel className="w-full h-full p-3 md:p-4 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white overflow-auto">
        <div className="max-w-6xl mx-auto h-full flex flex-col gap-2 md:gap-3">
          {/* The run header. Compressed on a phone — measured, not guessed.

              At 320x640 the chips were `px-2 py-1 text-sm`, which wrapped onto two
              28px rows and put the header at 100px of a 578px column: a sixth of
              the vertical budget spent on five labels. At `text-[11px] px-1.5
              py-0` a chip is a 17px row, so the whole header is ~40px and the
              board gets the difference. Desktop keeps `px-2 py-1 text-sm`
              because a monitor has height to spare and this is where the run
              detail belongs. */}
          <div className="order-1 flex flex-wrap items-center justify-between gap-1 md:gap-2 text-sm">
            <div className="font-bold text-sm md:text-lg">
              TETRIS - {activeDifficulty.label}
            </div>
            <div className="flex flex-wrap gap-1 md:gap-2 items-center">
              <span className="px-1.5 md:px-2 py-0 md:py-1 text-[11px] md:text-sm rounded bg-slate-700">
                Mode: {mode}
              </span>
              <span className="px-1.5 md:px-2 py-0 md:py-1 text-[11px] md:text-sm rounded bg-slate-700">
                Lvl: {runtime.level}
              </span>
              <span className="px-1.5 md:px-2 py-0 md:py-1 text-[11px] md:text-sm rounded bg-slate-700">
                Score: {runtime.score}
              </span>
              <span className="px-1.5 md:px-2 py-0 md:py-1 text-[11px] md:text-sm rounded bg-slate-700">
                Lines: {runtime.linesCleared}
              </span>
              <span className="px-1.5 md:px-2 py-0 md:py-1 text-[11px] md:text-sm rounded bg-slate-700">
                Target: {activeDifficulty.targetScore}
              </span>
            </div>
          </div>

          {/* The play row: HOLD + NEXT in one narrow column, the board beside
              them.

              ## Why HOLD and NEXT stay beside the board on a phone

              Measured on the layout this replaces, at 320x640 and 358x844: the
              row was `flex-col` below `md`, so the column cost
              header 100 + gap 12 + HOLD 91 + gap 16 + board 429 + gap 16 +
              NEXT 88 = 752px against a 578px column — 174px of scroll, with
              Restart and Exit 231px and 289px below the fold. At 358x844 the
              same stack was 1007px against 772px, 235px of scroll.

              The three panels cannot simply be made thinner: HOLD is a piece and
              NEXT is three, and 64px apiece is already the smallest box a
              four-wide tetromino fits into legibly. And stacking is not free
              either — the whole point of `FitStage` is that it measures its
              siblings and hands the board what is left, and a sibling stacked
              *below* the board costs the board height it could have used. So on
              a phone they go in one 48px column beside the board instead: they
              occupy no height at all, and what they do cost is the 236px
              `FitStage` reserves for them, which is what brings the board from
              480px down to 388px at 320x640.

              That over-reservation is deliberate and is why this layout fits
              rather than overflows. `FitStage` budgets `window.innerHeight`
              against its siblings' `offsetHeight`, and on a phone the panels are
              its siblings whether they sit beside it or below it — so a
              `position: absolute` or `flex-wrap` trick that moved them out of
              the row's flow would take them *out* of the measurement as well,
              hand the board the full 480px, and overflow the column by ~170px.
              Measured side by side: the column lands at 548px of 578 at
              320x640 (30px spare) and 640px of 772 at 358x844, where the board
              is back at its full 240x480.

              From `md` up nothing moves: the 190px legend panel stays left of the
              board and the 64px NEXT column stays right of it, at the same
              526px row and the same 0.66 board scale as before. */}
          <div className="order-3 flex flex-row gap-2 md:gap-4 justify-center items-start">
            {/* 56px on a phone (`p-1` plus the border leaves 46px of inner width for the
                44px preview box), 190px from `md` up. */}
            <div className="w-14 md:w-[190px] shrink-0 space-y-2 md:space-y-3 rounded border border-slate-600 bg-slate-900/70 p-1 md:p-3">
              {/* The key legend is desktop-only. It is a static block of help
                  text about keys, and on a phone the touch buttons below
                  already carry their own labels — so it was ~150px of the
                  vertical budget spent on instructions for hardware the player
                  does not have, which is what pushed the board and the buttons
                  off the screen. The keyboard player still sees it. */}
              <div className="hidden md:block">
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

              <div className="border-t-0 md:border-t border-slate-600 pt-2 md:pt-0">
                <div className="text-xs font-semibold text-slate-300">HOLD</div>
                <div className="mt-1 md:mt-2 flex justify-center md:justify-start">
                  <MiniPiece kind={runtime.hold} />
                </div>
              </div>

              {/* The phone's copy of the queue. On a phone it is the second
                  block of the column beside the board; from `md` up the panel to
                  the right of the board carries it instead, so this one is not
                  rendered at all. Same markup either way — the `nextQueue`
                  element below — so the two can never drift apart. */}
              <div className="md:hidden">{nextQueue}</div>
            </div>

            {/* The board is the one element that has to give.

                A 20-row board is 480px tall. Stacked on a phone next to the
                HOLD panel, the NEXT queue, the touch buttons and the header, the
                column came to ~1010px against an 844px screen — so the player
                had to scroll to reach the buttons at all.

                So the board, and only the board, is scaled to whatever height is
                left over. Its neighbours (HOLD, NEXT) and the button row below
                are siblings in the column, and `FitStage` measures them, so the
                board is never scaled into them.

                Not scaled by hand: `TILE_SIZE` is 24px in the drop logic, the
                piece matrix and the rendering, so the board has to stay exactly
                10 x 20 cells. A transform leaves that untouched, whereas
                re-deriving the tile size from a measured container would change
                the game mid-piece. */}
            {/* `reserve` covers the game-over banner, which is the one sibling
                that only appears once the run has ended. `FitStage` reads its
                height on mount and on resize, so without this the banner would
                land in a column the board had already filled. */}
            <FitStage
              width={BOARD_WIDTH * TILE_SIZE}
              height={BOARD_HEIGHT * TILE_SIZE}
              minScale={0.4}
              reserve={runtime.gameOver ? 56 : 0}
            >
              <div className="relative h-full w-full rounded border border-slate-500 bg-slate-950 overflow-hidden">
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
            </FitStage>

            {/* The desktop's copy of the queue: the 64px strip to the right of
                the board, exactly where it always was. `hidden` below `md`,
                because on a phone the queue lives in the column beside the
                board — see the play row's note for why it has to be a sibling
                of the board and not a strip of its own. */}
            <div className="hidden md:block md:w-[64px] shrink-0 space-y-2">
              {nextQueue}
            </div>
          </div>

          {/* Touch controls */}
          {/* Tetris was keyboard-only, which made the cabinet unplayable on a
              phone. These buttons are not a second input path: each dispatches
              the real `ArrowLeft` / `ArrowRight` / `ArrowDown` / `ArrowUp`
              keydown and keyup on `window`, which is exactly what the
              handler above already reads — so the strip is driveable with no
              game code behind it, and a desktop player's keyboard is
              untouched.

              Four buttons in a row rather than `TouchDPad`'s 3x3 plus: the
              d-pad is built for *direction*, and in Tetris the thumb
              alternates between sliding the piece sideways and rotating it,
              which wants a flat strip where every button is one hop from the
              last. It is also 64px of chrome instead of the d-pad's 168px.
              LEFT/RIGHT sit under the left thumb, ROTATE under the right;
              rotate is the accent because it is by far the most pressed of the
              four.

              `h-12 md:h-16` with no vertical padding on a phone. At `h-16` plus
              `py-1` the strip was 72px of a 578px column, and a button a thumb
              has to hit mid-drop wants every millimetre that is not the board.
              48px still clears the 44px tap floor, and at 320px wide the four
              buttons come out 62px each. Desktop is unchanged at `h-16` + `py-1`. */}
          {isTouchDevice && !runtime.gameOver && (
            /* `sticky bottom-0` is now a safety net rather than the mechanism:
               the column fits at 320x640 and 358x844 without it, so the strip
               never actually sticks. It stays because `minScale` floors the
               board on a viewport shorter than a landscape phone — a 568px-tall
               one, say — and there the buttons still have to be pressable
               rather than scrolled off. */
            <div className="order-5 md:order-3 sticky bottom-0 z-10 shrink-0 bg-slate-950/95 py-1 flex flex-col gap-1.5">
              {/* Row 1: HOLD on its own, above the rest.
                  `Q` is hold on the keyboard and there was no touch route to it
                  at all, so a player on a phone could not bank a piece — one of
                  the three decisions the game is built around. It sits above the
                  directional rows because it is the rarest press, so it should
                  not cost any of the space the thumb sweeps. */}
              <TouchButton
                held={held}
                code="KeyQ"
                label={
                  <span className="flex items-center justify-center gap-1.5 leading-tight">
                    <span className="text-base">⇄</span>
                    <span className="text-[11px] font-semibold">HOLD</span>
                  </span>
                }
                className="h-11 md:h-12 w-full"
              />

              {/* Row 2: soft drop, rotate, hard drop.
                  Rotate is the tallest of the three because it is by far the
                  most pressed — it happens several times per piece, while drop
                  and hard drop happen at the player's discretion — and it keeps
                  the accent tone it had when it was the only labelled button. */}
              <div className="grid grid-cols-3 gap-2 items-center">
                <TouchButton
                  held={held}
                  code="ArrowDown"
                  label={
                    <span className="flex flex-col items-center leading-tight">
                      <span className="text-base">▼</span>
                      <span className="text-[10px] font-semibold">SOFT</span>
                    </span>
                  }
                  className="h-11 md:h-12"
                />
                <TouchButton
                  held={held}
                  code="ArrowUp"
                  tone="accent"
                  label={
                    <span className="flex flex-col items-center leading-tight">
                      <span className="text-xl">⟳</span>
                      <span className="text-[10px] font-semibold">ROTATE</span>
                    </span>
                  }
                  className="h-14 md:h-16"
                />
                <TouchButton
                  held={held}
                  code="Space"
                  label={
                    <span className="flex flex-col items-center leading-tight">
                      <span className="text-base">⤓</span>
                      <span className="text-[10px] font-semibold">HARD</span>
                    </span>
                  }
                  className="h-11 md:h-12"
                />
              </div>

              {/* Row 3: the two moves, side by side and equal.

                  These are the only buttons held down rather than tapped, so
                  they get the full width of the row split evenly — a slide kept
                  under one thumb needs the surface area, not a third of it. */}
              <div className="grid grid-cols-2 gap-2">
                <TouchButton
                  held={held}
                  code="ArrowLeft"
                  label={
                    <span className="flex items-center justify-center gap-1.5 leading-tight">
                      <span className="text-xl">◀</span>
                      <span className="text-[11px] font-semibold">MOVE</span>
                    </span>
                  }
                  className="h-14 md:h-16"
                />
                <TouchButton
                  held={held}
                  code="ArrowRight"
                  label={
                    <span className="flex items-center justify-center gap-1.5 leading-tight">
                      <span className="text-xl">▶</span>
                      <span className="text-[11px] font-semibold">MOVE</span>
                    </span>
                  }
                  className="h-14 md:h-16"
                />
              </div>
            </div>
          )}

          {/* The run's result, and the one thing in the column that changes the
              budget: it appears where the touch strip was, so it has to cost no
              more than the 48px it replaces or the board and the buttons get
              pushed down.

              Measured at 320x640 in the game-over state, the column came to
              596 of a 578px box — the banner at 80px (`p-3` plus `text-lg` and
              a wrapped two-line reason) against a strip that had been 48, and
              the Restart/Exit row was 619px down with 601px of panel under it:
              18px of scroll on the screen that reports the score. `p-1.5` and
              a 10px reason bring it to 56px, and `reserve` below hands the
              board the difference so the two cannot both claim the space. */}
          {runtime.gameOver && (
            <div
              className={`order-4 rounded border-2 p-1.5 md:p-3 text-center ${
                runtime.won
                  ? "border-green-400 bg-green-900/40"
                  : "border-red-400 bg-red-900/30"
              }`}
            >
              <div className="font-bold text-sm md:text-lg">
                {runtime.won ? "Harvest Complete!" : "Run Failed"}
              </div>
              <div className="text-[10px] md:text-sm leading-tight mt-0.5 md:mt-1">
                {runtime.reason}. Final score: {runtime.score}.
                {runtime.won && mode === "reward"
                  ? ` Reward granted: ${TETRIS_RAVEN_COIN_REWARD} RavenCoin.`
                  : ""}
              </div>
            </div>
          )}

          {/* One row on a phone, two stacked from `md` up.

              `Button` renders `w-full` unless its `className` carries a width,
              so the two controls were each a full-width 50px button and wrapped
              onto two rows — 108px, measured, for a row of text that fits in
              50px. `flex-1 w-auto` splits the width between them instead, which
              needs `items-start` and a phone-length label: half of 274px is 133,
              and "Restart Practice Run" does not fit in the ~101px that leaves
              after the button's own border and padding, so it wrapped and
              stretched its row to 70px.

              `md:flex-none` is what puts the desktop back: `flex-1` sets
              `flex-basis: 0%`, which wins over `width` on a flex item, so
              `md:w-full` on its own left both desktop buttons sharing one row at
              half the panel width rather than the full-width rows they have
              always been.

              ## Moved to the top on a phone

              `order-2 md:order-5` lifts this row above the board on a phone and
              leaves it at the bottom from `md` up, where it has always been.
              Two reasons: the run controls are the first thing a player reaches
              for after a mistake, and every pixel the row occupied at the bottom
              is a pixel the board does not get — it was competing with the touch
              pad for the last of the column. The sibling rows carry their own
              orders (header `1`, board `3`, banner `4`, pad `5`) because `order`
              has to be stated on all of them to place one out of sequence; from
              `md` the pad is not rendered at all, so its order is irrelevant
              there and desktop resolves to header, board, banner, controls.

              The phone copy is shortened to "Restart" for the same reason it
              always was: half of 274px does not fit "Restart Practice Run". */}
          <div className="order-2 md:order-5 flex flex-nowrap md:flex-wrap items-start gap-2">
            {mode === "practice" && (
              <Button
                onClick={() => startSession("practice")}
                className="flex-1 w-auto md:flex-none md:w-full"
              >
                <span className="md:hidden">Restart</span>
                <span className="hidden md:inline">Restart Practice Run</span>
              </Button>
            )}
            {onClose && (
              <Button
                onClick={handleInGameExit}
                className="flex-1 w-auto md:flex-none md:w-full"
              >
                Exit
              </Button>
            )}
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
