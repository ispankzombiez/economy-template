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
import { submitScore } from "../adapters/portalUtil";
import { useVipAccess } from "../adapters/useVipAccess";
import { useRewardRun } from "../adapters/rewardRun";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { useBootstrap } from "lib/portal/BootstrapContext";
import { getEconomyWorkerUrl, writeNonce } from "lib/portal/api";
import {
  getTetrisDaySeed,
  getTetrisDifficulty,
  isTetrisRewardRunAvailable,
  TETRIS_DIFFICULTIES,
  TETRIS_RAVEN_COIN_REWARD,
  TetrisDifficulty,
  TetrisDifficultyName,
  TetrisMode,
} from "./session";
import {
  BOARD_WIDTH,
  BOARD_HEIGHT,
  FIXED_STEP_MS,
  INPUT_HARD_DROP,
  INPUT_HOLD,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_ROTATE_CCW,
  INPUT_ROTATE_CW,
  INPUT_SOFT_DROP,
  SHAPES,
  createRuntime,
  encodeInputLog,
  getCells,
  tick,
  type Cell,
  type TetrisRuntime,
  type TetrominoKind,
} from "./engine";
import { CHUNK_TICKS } from "@nightshade/shared/anticheat/replayBudget";

const _portalState = (state: PortalMachineState) => state.context.state;

const TILE_SIZE = 24;

/**
 * Keys the cabinet claims outright, so the page does not scroll or the host
 * reacts to them.
 *
 * `Q` is deliberately absent: hold/swap is `C`, and an unbound key must stay
 * unbound rather than being swallowed and doing nothing, which is what leaving
 * it here would do.
 */
const INTERCEPTED_CODES = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "KeyZ",
  "KeyX",
  "KeyC",
  "Space",
]);

const PIECE_IMAGES: Record<TetrominoKind, string> = {
  I: ITEM_DETAILS.Corn.image,
  O: ITEM_DETAILS.Potato.image,
  T: ITEM_DETAILS.Pumpkin.image,
  S: ITEM_DETAILS.Carrot.image,
  Z: ITEM_DETAILS.Tomato.image,
  J: ITEM_DETAILS.Wheat.image,
  L: ITEM_DETAILS.Sunflower.image,
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
  const bootstrap = useBootstrap();

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
  // A one-line summary of what the verification stream did, shown on the
  // game-over card when a claim did not go through. Diagnostic only: the run's
  // outcome never depends on it, it just makes a client-side failure legible
  // instead of something the player can only infer from a missing coin.
  const [verifyDiag, setVerifyDiag] = useState<string | null>(null);

  // The simulation state lives in `gameRef`, not in React state: a step is
  // driven from a fixed-step accumulator, and re-rendering between ticks would
  // mean the log and the game could disagree for a frame.
  const gameRef = useRef<TetrisRuntime | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const accumulatorRef = useRef(0);

  // Held keys as one bitfield, exactly the byte the log records. The held bit is
  // cleared on key-up; the press bits are consumed by the step they landed on
  // and never persist, because a rotation that happened "at some point" is not a
  // claim the worker can check.
  const heldRef = useRef(0);
  const pressRef = useRef(0);

  const inputLogRef = useRef<number[]>([]);
  const activeDifficultyRef = useRef<TetrisDifficulty>(todaysDifficulty);
  const runStartedAtRef = useRef(0);
  const rewardGrantedRef = useRef(false);
  const frozenClaimRef = useRef<{
    cabinet: string;
    score: number;
    checkpoints: unknown[];
    elapsedMs: number;
    replay: { difficulty: string; ticks: number; inputs: string };
  } | null>(null);

  // The chunk stream's own bookkeeping — see `pumpVerificationChunks`.
  const chunkIndexRef = useRef(0);
  const chunkBusyRef = useRef(false);
  const chunkBrokenRef = useRef(false);
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const chunkDrainedRef = useRef<Promise<void> | null>(null);

  const held = useHeldKeys();

  const returnToMenu = useCallback(() => {
    setShowExitConfirm(false);
    setMode(null);
    setRuntime(null);
    gameRef.current = null;
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

      // One runtime instance, shared by the loop (through `gameRef`) and the
      // first render (through its snapshot): two `createRuntime` calls would be
      // two games, and the claim would describe the one nobody played.
      //
      // The seed is the day's own, not a fresh random one. The worker derives
      // the difficulty from the UTC date and only accepts today's or
      // yesterday's, so a client-chosen bag seed could not be re-derived and
      // every honest run would be refused; the date hash is what both ends
      // agree on. It is baked into the runtime rather than passed per step, so
      // a park resumed after midnight keeps dealing from the run's own bag.
      const fresh = createRuntime(runDifficulty, getTetrisDaySeed());
      gameRef.current = fresh;
      setRuntime({ ...fresh });

      setMode(nextMode);
      setActiveDifficulty(runDifficulty);
      setShowPracticeDifficultyPrompt(false);
      rewardGrantedRef.current = false;
      heldRef.current = 0;
      pressRef.current = 0;

      // Fresh run, fresh proof: the log, the claim and the stream all belong
      // to exactly one run, and a "Play Again" that inherited the previous
      // run's cursor would post its first window at an index the worker's
      // brand-new park has never heard of.
      activeDifficultyRef.current = runDifficulty;
      inputLogRef.current = [];
      // The summary is per-run, so the line on the card has to be too. Resetting
      // only the event log left the previous run's verdict standing — the card
      // read "30/30 windows acked" over a run the worker had seen as a different
      // length entirely, which is worse than showing nothing at all.
      setVerifyDiag(null);
      frozenClaimRef.current = null;
      accumulatorRef.current = 0;
      runStartedAtRef.current = Date.now();
      chunkIndexRef.current = 0;
      chunkBusyRef.current = false;
      chunkBrokenRef.current = false;
      chunkQueueRef.current = Promise.resolve();
      chunkDrainedRef.current = null;
      (window as unknown as { __verifyChunk?: unknown[] }).__verifyChunk = [];

      if (nextMode === "reward") {
        portalService.send({
          type: "arcadeMinigame.started",
          name: "tetris" as any,
        });
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

  // ── Key handling ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mode) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!INTERCEPTED_CODES.has(event.code)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      // Left and Right are *presses*, not held states: one keydown moves the piece
      // exactly one cell, and a key held down slides only because the OS repeats
      // it. Recording them as held bits instead — which is what the first cut of
      // this conversion did — makes the step function move one cell per 16 ms
      // tick for as long as the bit survives, so an ordinary 100 ms tap shunts
      // the piece six columns and the cabinet stops feeling playable.
      //
      // Auto-repeat is therefore wanted for the arrows and unwanted for
      // everything else: a player who leans on Left means to slide, but a
      // rotation held down should not log one rotation per repeat tick.
      const isRepeat = event.repeat;

      switch (event.code) {
        case "ArrowLeft":
          pressRef.current |= INPUT_LEFT;
          break;
        case "ArrowRight":
          pressRef.current |= INPUT_RIGHT;
          break;
        case "ArrowDown":
          // Soft drop is the one genuinely continuous input: it speeds the fall
          // for as long as it is down, so it stays a held bit.
          heldRef.current |= INPUT_SOFT_DROP;
          break;
        case "ArrowUp":
        case "KeyX":
          if (!isRepeat) pressRef.current |= INPUT_ROTATE_CW;
          break;
        case "KeyZ":
          if (!isRepeat) pressRef.current |= INPUT_ROTATE_CCW;
          break;
        case "KeyC":
          if (!isRepeat) pressRef.current |= INPUT_HOLD;
          break;
        case "Space":
          if (!isRepeat) pressRef.current |= INPUT_HARD_DROP;
          break;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!INTERCEPTED_CODES.has(event.code)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      // Only soft drop survives a key-up; the arrows are single presses, consumed by
      // the step they landed on, so there is nothing of theirs left to release.
      if (event.code === "ArrowDown") {
        heldRef.current &= ~INPUT_SOFT_DROP;
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      heldRef.current = 0;
      pressRef.current = 0;
    };
  }, [mode]);

  // ── Game loop ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mode || !runtime || runtime.gameOver) {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      lastFrameAtRef.current = null;
      accumulatorRef.current = 0;
      return;
    }

    accumulatorRef.current = 0;
    lastFrameAtRef.current = null;

    /**
     * What happened to the verification stream, for the client-side half of a
     * refusal the worker never sees.
     *
     * Every symptom so far has been *silent on this side*. A lost window is
     * invisible: the worker records a verdict about the claim, never about the
     * window that never arrived, so "the park holds 600 of 20764 ticks" says
     * only that something went wrong 34 windows ago. This records what each
     * window did, so the next run can be read instead of guessed at.
     *
     * Strictly an observer. It never sets `chunkBrokenRef` and never touches the
     * queue — including on the watchdog, which reports a window that never came
     * back but deliberately leaves the stream's fate unchanged.
     */
    const note = (event: Record<string, unknown>) => {
      const entry = { t: Date.now(), ...event };
      const log = (window as unknown as { __verifyChunk?: unknown[] }).__verifyChunk;
      if (Array.isArray(log)) log.push(entry);
      console.warn("[verify-chunk]", entry);
    };

    /**
     * Queue one verification window behind the ones already on the wire.
     *
     * The chain is the whole point: the worker resumes a park only at exactly
     * the cursor the next window belongs at, so two windows in flight at once
     * would arrive in whichever order the network pleased and the second would
     * void the park the first just built. Window 0 carries the run's
     * difficulty — the only engine context a run needs besides its bag — and
     * every later window inherits it from the park.
     */
    const postVerificationWindow = (chunkIndex: number, bytes: Uint8Array) => {
      const send = async () => {
        if (chunkBrokenRef.current) {
          note({ chunk: chunkIndex, outcome: "skipped-stream-already-broken" });
          return;
        }
        const jwt = bootstrap?.jwt;
        if (!jwt) {
          // The window's index has already been consumed, so this one is gone.
          // Returning quietly would leave a hole in the stream and every later
          // window would arrive at a cursor the park never reached — the run
          // would then be refused for a reason invisible from the client.
          chunkBrokenRef.current = true;
          note({ chunk: chunkIndex, outcome: "no-session-token" });
          return;
        }

        const startedAt = Date.now();
        // A window that never comes back holds `chunkBusyRef` forever and stalls
        // the stream with no error anywhere. Report it; do not act on it.
        const watchdog = setTimeout(() => {
          note({ chunk: chunkIndex, outcome: "no-response-after-20s" });
        }, 20_000);

        try {
          const res = await fetch(getEconomyWorkerUrl() + "/economy/write", {
            method: "POST",
            headers: {
              "content-type": "application/json;charset=UTF-8",
              accept: "application/json",
              Authorization: `Bearer ${jwt}`,
            },
            body: JSON.stringify({
              intent: "verify-chunk",
              nonce: writeNonce(),
              chunkIndex,
              inputs: encodeInputLog(bytes),
              ...(chunkIndex === 0
                ? { difficulty: activeDifficultyRef.current.name }
                : {}),
            }),
          });
          if (!res.ok) {
            // Surface why the worker rejected it, and stop: windows are
            // ordered, so the ones behind a refused window would be refused
            // for the cursor rather than for their contents.
            const detail = await res.text().catch(() => "");
            note({
              chunk: chunkIndex,
              outcome: "rejected",
              status: res.status,
              detail: detail.slice(0, 300),
              ms: Date.now() - startedAt,
            });
            chunkBrokenRef.current = true;
          } else {
            note({
              chunk: chunkIndex,
              outcome: "acked",
              status: res.status,
              ms: Date.now() - startedAt,
            });
          }
        } catch (error) {
          // A dropped window cannot be re-sent out of order — the next window
          // would arrive at a cursor the park no longer has — so the stream
          // ends here and the claim has to replay the run itself, which a run
          // this long will not fit in one request.
          note({
            chunk: chunkIndex,
            outcome: "threw",
            error: String(error),
            ms: Date.now() - startedAt,
          });
          chunkBrokenRef.current = true;
        } finally {
          clearTimeout(watchdog);
        }
      };

      chunkQueueRef.current = chunkQueueRef.current.then(send);
    };

    /**
     * Queue every complete window the log has grown since the last one.
     *
     * A window is the unit: one is queued whenever a full one exists, whatever
     * frame that happens to be — 600 steps is 9.6 seconds of play, so the queue
     * trails the log by seconds rather than by ticks.
     */
    const pumpVerificationChunks = () => {
      if (mode !== "reward") return;
      if (chunkBusyRef.current || chunkBrokenRef.current) return;
      // Nothing to send until we are who we are sending as. The window index is
      // consumed below, and an index consumed for a window that was never sent
      // is a hole in the stream: every later window then arrives at a cursor the
      // park never advanced to, and the whole run is refused.
      if (!bootstrap?.jwt) return;

      const start = chunkIndexRef.current * CHUNK_TICKS;
      if (inputLogRef.current.length - start < CHUNK_TICKS) return;

      const end = start + CHUNK_TICKS;
      const chunkIndex = chunkIndexRef.current;
      chunkIndexRef.current += 1;
      postVerificationWindow(
        chunkIndex,
        Uint8Array.from(inputLogRef.current.slice(start, end)),
      );

      // One window on the wire at a time: the response is what proves the park
      // took it, and the next window may only be built on a park that did.
      chunkBusyRef.current = true;
      void chunkQueueRef.current.finally(() => {
        chunkBusyRef.current = false;
      });
    };

    /**
     * Freeze the claim the moment the run settles, then close the log behind
     * it.
     *
     * Runs after the steps, against the settled game: the score recorded here
     * already contains whatever step ended the run (the engine applies the win
     * inside the step), so the claim's score, its log and its duration are all
     * read from one state of the run rather than from a later frame.
     *
     * The tail-close matters more than it looks. The worker refuses a claim
     * whose park holds less log than the claim asserts (`parked.total` must
     * equal the claim's `ticks`), because such a claim's replay cannot finish
     * inside one request — so every window still unwritten is queued behind the
     * windows already on the wire, and `chunkDrainedRef` is what the payout
     * effect waits on. A claim that overtakes its own tail would start the
     * replay from tick zero and never reach the end.
     */
    const freezeClaim = () => {
      const game = gameRef.current;
      if (!game || frozenClaimRef.current) return;
      if (!game.gameOver || !game.won || mode !== "reward") return;

      frozenClaimRef.current = {
        cabinet: "tetris",
        score: game.score,
        checkpoints: [],
        elapsedMs: Date.now() - runStartedAtRef.current,
        replay: {
          difficulty: activeDifficultyRef.current.name,
          ticks: inputLogRef.current.length,
          inputs: encodeInputLog(Uint8Array.from(inputLogRef.current)),
        },
      };

      if (!chunkBrokenRef.current) {
        const log = inputLogRef.current;
        let start = chunkIndexRef.current * CHUNK_TICKS;
        while (start < log.length) {
          const end = Math.min(start + CHUNK_TICKS, log.length);
          postVerificationWindow(
            chunkIndexRef.current,
            Uint8Array.from(log.slice(start, end)),
          );
          chunkIndexRef.current += 1;
          start = end;
        }
      } else {
        note({ outcome: "tail-not-sent-stream-broken" });
      }
      chunkDrainedRef.current = chunkQueueRef.current.catch(() => {});

      // Summarise the stream for the game-over card: how far it got, and the
      // first thing that went wrong. Read after the drain so the count is final.
      void chunkDrainedRef.current.then(() => {
        const log = (window as unknown as { __verifyChunk?: unknown[] })
          .__verifyChunk;
        const entries = Array.isArray(log) ? (log as Record<string, unknown>[]) : [];
        const acked = entries.filter((e) => e.outcome === "acked").length;
        const failure = entries.find((e) => e.outcome !== "acked" && e.outcome !== "skipped-stream-already-broken");
        const ticks = inputLogRef.current.length;
        const needed = Math.ceil(ticks / CHUNK_TICKS);
        // The tick count is stated outright. A bare "30/30" cannot be checked
        // against anything the worker said, and two numbers that disagree is how
        // a real fault got read as a stale card in the first place.
        const tally = `${acked}/${needed} windows (${ticks} ticks)`;

        setVerifyDiag(
          failure
            ? `${tally}; window ${failure.chunk ?? "?"} ${failure.outcome}` +
                (failure.status ? ` (HTTP ${failure.status})` : "") +
                (failure.error ? ` [${failure.error}]` : "") +
                (failure.detail ? ` ${String(failure.detail).slice(0, 120)}` : "")
            : tally,
        );
      });
    };

    const loop = (ts: number) => {
      frameRef.current = requestAnimationFrame(loop);

      const prevAt = lastFrameAtRef.current ?? ts;
      lastFrameAtRef.current = ts;

      let game = gameRef.current;
      if (!game) return;

      // Whole steps only, and never more simulated time than the tab was
      // actually allowed to elapse (the brawler's own clamp): a backgrounded
      // tab must not fast-forward the board on return.
      accumulatorRef.current += Math.min(ts - prevAt, 250);

      // `game` is advanced *in place* through the loop, and this is the single
      // most important line in the component.
      //
      // Reading the state once into a `const` before the loop and stepping that
      // same value on every iteration looks equivalent and is not: whenever a
      // frame delivers more than one step of accumulated time — a stutter, a GC
      // pause, a tab switch, anything the 250 ms clamp lets through — the second
      // and later iterations re-step the *pre-loop* state. The simulation stops
      // advancing while the log keeps recording a byte per iteration, so the
      // claim asserts a run that never happened. The worker's replay steps one
      // tick per byte from a correctly advancing copy of the engine, so it
      // diverges on the very first hiccup and every subsequent window lands at
      // the wrong cursor.
      //
      // It hides at 60fps. A 16 ms step against a ~16 ms frame means the loop
      // almost always runs exactly once, which is why a clean session verifies
      // and a real one does not.
      while (accumulatorRef.current >= FIXED_STEP_MS && !game.gameOver) {
        // The single-press bits belong to exactly one step, so they are read
        // into the byte and cleared before the step rather than after: a press
        // that arrived between frames is on the next step's byte, and never on
        // two.
        const inputByte = heldRef.current | pressRef.current;
        pressRef.current = 0;

        // Before the step, not after: the log records the inputs the step was
        // taken *under*, which is what the worker feeds its own copy of `tick`.
        // Sampling afterwards would round a press and a step apart.
        inputLogRef.current.push(inputByte);
        game = tick(game, FIXED_STEP_MS, inputByte);
        gameRef.current = game;
        accumulatorRef.current -= FIXED_STEP_MS;
        pumpVerificationChunks();
      }

      // The run may have ended on the step above — freeze it before the
      // render that announces it.
      freezeClaim();

      // Guarded the way `freezeClaim` guards: the loop above only steps a
      // live game, so the ref cannot be null here — but it is typed nullable,
      // and the render wants the *latest* value, after the loop's
      // reassignments.
      const latest = gameRef.current;
      if (latest !== null) setRuntime({ ...latest });
    };

    frameRef.current = requestAnimationFrame(loop);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      lastFrameAtRef.current = null;
    };
  }, [mode, runtime?.gameOver, bootstrap]);

  // ── Reward grant ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (
      !runtime?.gameOver ||
      !runtime.won ||
      rewardGrantedRef.current ||
      mode !== "reward"
    )
      return;
    rewardGrantedRef.current = true;

    // The claim was frozen by the loop the instant the run settled — score,
    // log and duration from one state. Absent means the win somehow happened
    // without the loop settling, which cannot happen while the loop is
    // running; it is still checked, because claiming with no log would burn
    // the voucher for nothing — and the voucher is the player's ticket, not
    // ours to spend.
    const claim = frozenClaimRef.current;
    if (!claim) {
      rewardGrantedRef.current = false;
      console.error("[tetris] win with no frozen claim");
      return;
    }

    submitScore({ score: runtime.score });

    // The tail windows are still on the wire when this effect runs — the
    // freeze, the tail and the `gameOver` that triggered this are all observed
    // in the same frame. The claim may only land once the park holds the
    // whole log: overtaking it makes the worker start the replay from tick
    // zero, and a run this long cannot be re-simulated inside one request, so
    // the refusal that follows would be of an honestly won coin.
    void (chunkDrainedRef.current ?? Promise.resolve()).then(() => {
      portalService.send({
        type: "arcadeMinigame.ravenCoinWon",
        amount: TETRIS_RAVEN_COIN_REWARD,
        verify: claim,
      });
    });
  }, [mode, portalService, runtime]);

  const renderedBoard = useMemo(() => {
    const board: Cell[][] = Array.from({ length: BOARD_HEIGHT }, () =>
      Array<Cell>(BOARD_WIDTH).fill(null),
    );
    if (!runtime) return board;

    // The overlay is the *rendered* board — the locked cells with the active
    // piece drawn on top — built from the engine's own `getCells` rather than a
    // second copy of the shapes, so the piece on screen and the piece in the
    // log can never be two different pieces.
    for (let y = 0; y < BOARD_HEIGHT; y++) {
      for (let x = 0; x < BOARD_WIDTH; x++) {
        board[y][x] = runtime.board[y][x];
      }
    }

    for (const cell of getCells(runtime.active)) {
      if (
        cell.y >= 0 &&
        cell.y < BOARD_HEIGHT &&
        cell.x >= 0 &&
        cell.x < BOARD_WIDTH
      ) {
        board[cell.y][cell.x] = runtime.active.kind;
      }
    }

    return board;
  }, [runtime]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Lobby
  // ─────────────────────────────────────────────────────────────────────────────
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
                <div className="text-sm text-gray-700 font-semibold">TARGET</div>
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
              Press C to hold/swap your active piece once per drop.
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
                  Reward runs use today&apos;s difficulty (
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
                  <div>C - Hold / Swap</div>
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
                  `C` is hold on the keyboard and there was no touch route to it
                  at all, so a player on a phone could not bank a piece — one of
                  the three decisions the game is built around. It sits above the
                  directional rows because it is the rarest press, so it should
                  not cost any of the space the thumb sweeps. */}
              <TouchButton
                held={held}
                code="KeyC"
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
              {verifyDiag && (
                <div className="mt-1 text-[10px] leading-tight text-amber-200/90 break-all">
                  verify: {verifyDiag}
                </div>
              )}
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
            {runtime.gameOver && mode === "reward" && hasRewardRun && (
              <Button
                onClick={rewardRun.start}
                className="flex-1 w-auto md:flex-none md:w-full"
              >
                Play Again
              </Button>
            )}
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

          {/* The "are you sure?" box for a "Play Again" that has to burn a
              ticket. The lobby's copy of it lives in a branch that is not
              rendered while a run is on screen, so the game-over case needs its
              own — the same state, the same two buttons, in the pixel-panel
              scheme the rest of the menu uses rather than a raw slate panel. */}
          {runtime.gameOver &&
            mode === "reward" &&
            rewardRun.confirming && (
              <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
                <InnerPanel className="w-full max-w-sm p-4 space-y-4">
                  <div className="font-bold text-lg text-black">
                    ARE YOU SURE?
                  </div>
                  <p className="text-sm text-gray-700">
                    Today&apos;s free reward run is already used. Starting another
                    one burns
                    <b> 1 Play Ticket</b>.
                  </p>
                  <p className="text-sm text-gray-700">
                    Play Tickets: <b>{rewardRun.tickets}</b>
                  </p>
                  <div className="flex flex-col gap-2">
                    <Button onClick={rewardRun.confirm} className="w-full">
                      CONFIRM — USE 1 PLAY TICKET
                    </Button>
                    <Button onClick={rewardRun.cancel} className="w-full">
                      CLOSE
                    </Button>
                  </div>
                </InnerPanel>
              </div>
            )}
        </div>
      </InnerPanel>
    </OuterPanel>
  );
};