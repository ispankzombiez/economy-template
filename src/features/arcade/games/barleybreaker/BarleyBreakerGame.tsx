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
import { TouchMoveBar, useIsTouchDevice } from "components/ui/TouchControls";
import { ITEM_DETAILS } from "../adapters/itemDetails";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { startAttempt, submitScore } from "../adapters/portalUtil";
import { useVipAccess } from "../adapters/useVipAccess";
import { useRewardRun } from "../adapters/rewardRun";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import { useBootstrap } from "lib/portal/BootstrapContext";
import type { VerifiedRun } from "lib/portal/api";
import { writeNonce, getEconomyWorkerUrl } from "lib/portal/api";
import { CHUNK_TICKS } from "@nightshade/shared/anticheat/replayBudget";
import { encodeInputLog } from "@nightshade/shared/anticheat/inputLog";
import {
  BARLEY_BREAKER_DIFFICULTIES,
  BARLEY_BREAKER_RAVEN_COIN_REWARD,
  BarleyBreakerDifficulty,
  BarleyBreakerDifficultyName,
  BarleyBreakerMode,
  getBarleyBreakerDifficulty,
  isBarleyBreakerRewardRunAvailable,
} from "./session";
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  BALL_SIZE,
  CEILING_MARGIN,
  FIXED_STEP_MS,
  PADDLE_HEIGHT,
  PADDLE_Y,
  createRuntime,
  encodeTick,
  getPaddleWidth,
  tick,
  type BarleyBreakerRuntime,
} from "./engine";

const _portalState = (state: PortalMachineState) => state.context.state;

const panelClassName =
  "mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden";

/**
 * The floor on how far a *short window* may shrink the arena.
 *
 * It does not apply to width — `FitStage` always fits the width exactly, so a
 * floor can never push the arena off the side of its container. This is here for
 * the other case: a short landscape window where the height budget runs out
 * first. Past 0.38 the arena is a size worth playing and the panel scrolls;
 * below it there is nothing left to aim in, so the board stops shrinking and the page
 * scrolls instead.
 */
const MIN_STAGE_SCALE = 0.38;

const INTERCEPTED_CODES = new Set([
  "ArrowLeft",
  "ArrowRight",
  "KeyA",
  "KeyD",
  "Space",
]);

export const BarleyBreakerGame: React.FC<{ onClose?: () => void }> = ({
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });
  const bootstrap = useBootstrap();

  const hasRewardRun = useMemo(
    () => isBarleyBreakerRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const todaysDifficulty = useMemo(() => getBarleyBreakerDifficulty(), []);

  const isTouchDevice = useIsTouchDevice();

  const [mode, setMode] = useState<BarleyBreakerMode | null>(null);
  const [runtime, setRuntime] = useState<BarleyBreakerRuntime | null>(null);
  const [showPracticeDifficultyPrompt, setShowPracticeDifficultyPrompt] =
    useState(false);
  const [practiceDifficultyName, setPracticeDifficultyName] =
    useState<BarleyBreakerDifficultyName>(todaysDifficulty.name);
  const [activeDifficulty, setActiveDifficulty] =
    useState<BarleyBreakerDifficulty>(todaysDifficulty);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const rewardGrantedRef = useRef(false);

  const pressedKeysRef = useRef(new Set<string>());

  // ── The run, its proof log, and the streamed verification ─────────────────
  //
  // The simulation state lives in `gameRef`, not in React state: a step is
  // read from the settled previous step and produces the next one, possibly
  // several times per frame, and the input log must be written exactly once
  // per step — both are side effects, and running them inside a `setState`
  // updater would double-write them under StrictMode's double-invoke. React
  // state carries a per-frame *snapshot* for rendering only (the same
  // arrangement as `SunflowerBrawlerGame.tsx`'s `matchRef` and `PacManGame.tsx`'s
  // `gameRef`, whose chunk plumbing below is mirrored one-for-one).
  const gameRef = useRef<BarleyBreakerRuntime | null>(null);

  /** One byte per 16ms step: the input the step was taken *under*. */
  const inputLogRef = useRef<number[]>([]);

  /** Real time not yet spent on whole `FIXED_STEP_MS` steps. */
  const accumulatorRef = useRef(0);

  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  /** When the current run opened — the claim's `elapsedMs`. */
  const runStartedAtRef = useRef<number>(0);

  /** The run's difficulty, readable from inside the loop effect. */
  const activeDifficultyRef = useRef<BarleyBreakerDifficulty>(todaysDifficulty);

  /** The claim, frozen the instant the run settles — see `freezeClaim`. */
  const frozenClaimRef = useRef<VerifiedRun | null>(null);

  // Input is *parked* for the next step rather than applied to state: an event
  // that lands between steps (a launch keydown, a finger moving on the touch
  // bar) cannot be replayed, but a value consumed at step N can — the step
  // encodes it into the log before the engine reads it, and the worker's
  // replay feeds the same byte to the same `tick`.
  const launchPendingRef = useRef(false);
  const scrubPendingRef = useRef<number | null>(null);

  const chunkIndexRef = useRef(0);
  const chunkBusyRef = useRef(false);
  const chunkBrokenRef = useRef(false);
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const chunkDrainedRef = useRef<Promise<void> | null>(null);

  const returnToMenu = useCallback(() => {
    pressedKeysRef.current.clear();
    setMode(null);
    setRuntime(null);
    setShowPracticeDifficultyPrompt(false);
    setShowExitConfirm(false);
    rewardGrantedRef.current = false;
    gameRef.current = null;
    inputLogRef.current = [];
    frozenClaimRef.current = null;
    launchPendingRef.current = false;
    scrubPendingRef.current = null;
    chunkDrainedRef.current = null;
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

      // One runtime instance, shared by the loop (through `gameRef`) and the
      // first render (through its snapshot): two `createRuntime` calls would be
      // two games, and the claim would describe the one nobody played.
      const fresh = createRuntime(difficulty);
      gameRef.current = fresh;
      setRuntime({ ...fresh });

      pressedKeysRef.current.clear();
      setActiveDifficulty(difficulty);
      setMode(nextMode);
      setShowPracticeDifficultyPrompt(false);
      setShowExitConfirm(false);
      rewardGrantedRef.current = false;
      launchPendingRef.current = false;
      scrubPendingRef.current = null;

      // Fresh run, fresh proof: the log, the claim and the stream all belong
      // to exactly one run, and a "Play Again" that inherited the previous
      // run's cursor would post its first window at an index the worker's
      // brand-new park has never heard of.
      activeDifficultyRef.current = difficulty;
      inputLogRef.current = [];
      frozenClaimRef.current = null;
      accumulatorRef.current = 0;
      runStartedAtRef.current = Date.now();
      chunkIndexRef.current = 0;
      chunkBusyRef.current = false;
      chunkBrokenRef.current = false;
      chunkQueueRef.current = Promise.resolve();
      chunkDrainedRef.current = null;

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

  // A launch is not an event that lands *between* steps any more — the next
  // step has to consume it, because that is what the log records and what the
  // replay re-runs (see `engine.ts` on why `launchBall` moved into the tick).
  const requestLaunch = useCallback(() => {
    launchPendingRef.current = true;
  }, []);

  // The touch bar's fire button stands in for `Space`. The keyboard is the one
  // place that already knows how to launch, so the button dispatches the same
  // `keydown`/`keyup` pair the key itself sends and the handler above marks the
  // launch pending — no second launch path to keep in step with the first.
  const launchFromTouch = useCallback(() => {
    for (const type of ["keydown", "keyup"] as const) {
      window.dispatchEvent(
        new KeyboardEvent(type, {
          code: "Space",
          key: "Space",
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, []);

  // `TouchMoveBar` reports where the finger is across the strip as an absolute
  // 0..1 ratio, and that maps straight onto the paddle's travel — absolute
  // rather than the per-step nudge the polled `ArrowLeft`/`ArrowRight` give,
  // because a paddle that creeps sideways is a paddle that is always behind the
  // ball. The ratio is parked for the *next* step instead of being written into
  // React state: the step encodes it (bit 7 + 7 bits of position, see
  // `engine.ts`), applies it as the same absolute position, and the replay
  // reproduces it byte for byte.
  const scrubPaddle = useCallback((ratio: number) => {
    scrubPendingRef.current = Math.max(0, Math.min(1, ratio));
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!INTERCEPTED_CODES.has(event.code)) return;
      event.preventDefault();

      pressedKeysRef.current.add(event.code);

      if (event.code === "Space" && mode && gameRef.current && !showExitConfirm) {
        launchPendingRef.current = true;
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
  }, [mode, showExitConfirm]);

  // ── Game loop ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mode || !runtime || runtime.gameOver || showExitConfirm) {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      lastFrameAtRef.current = null;
      accumulatorRef.current = 0;
      return;
    }

    accumulatorRef.current = 0;
    lastFrameAtRef.current = null;

    /**
     * Queue one verification window behind the ones already on the wire.
     *
     * The chain is the whole point: the worker resumes a park only at exactly
     * the cursor the next window belongs at, so two windows in flight at once
     * would arrive in whichever order the network pleased and the second would
     * void the park the first just built. Window 0 carries the run's
     * difficulty — the only engine context a zero-RNG run needs — and every
     * later window inherits it from the park.
     */
    const postVerificationWindow = (chunkIndex: number, bytes: Uint8Array) => {
      const send = async () => {
        if (chunkBrokenRef.current) return;
        const jwt = bootstrap?.jwt;
        if (!jwt) return;

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
            console.warn(`[verify-chunk] ${res.status}`, detail);
            chunkBrokenRef.current = true;
          }
        } catch {
          // A dropped window cannot be re-sent out of order — the next window
          // would arrive at a cursor the park no longer has — so the stream
          // ends here and the claim has to replay the run itself, which a run
          // this long will not fit in one request.
          chunkBrokenRef.current = true;
        }
      };

      chunkQueueRef.current = chunkQueueRef.current.then(send);
    };

    /**
     * Queue every complete window the log has grown since the last one.
     *
     * A window is the unit: one is queued whenever a full one exists, whatever
     * frame that happens to be — 600 steps is 9.6 seconds of play at 16ms a
     * step, so the queue trails the log by seconds rather than by ticks.
     */
    const pumpVerificationChunks = () => {
      if (mode !== "reward") return;
      if (chunkBusyRef.current || chunkBrokenRef.current) return;

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
     * already contains whatever step ended the run (the engine applies wins
     * and losses inside the step), so the claim's score, its log and its
     * duration are all read from one state of the run rather than from a later
     * frame.
     *
     * The tail-close matters more than it looks. The worker refuses a claim
     * whose park holds less log than the claim asserts (`parked.total` must
     * equal the claim's `ticks`), because such a claim's replay cannot finish
     * inside one request — so every window still unwritten is queued behind
     * the windows already on the wire, and `chunkDrainedRef` is what the
     * payout effect waits on. A claim that overtakes its own tail would start
     * the replay from tick zero and never reach the end.
     */
    const freezeClaim = () => {
      const game = gameRef.current;
      if (!game || frozenClaimRef.current) return;
      if (!game.gameOver || !game.won || mode !== "reward") return;

      frozenClaimRef.current = {
        cabinet: "barley-breaker",
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
      }
      chunkDrainedRef.current = chunkQueueRef.current.catch(() => {});
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

      // `game` is advanced *in place* through the loop. Reading the state once
      // into a `const` before the loop and stepping that same value every
      // iteration looks equivalent and is not: whenever a frame delivers more
      // than one step of accumulated time — a stutter, a GC pause, a tab
      // switch, anything the 250 ms clamp lets through — the second and later
      // iterations re-step the *pre-loop* state, so the board stops advancing
      // while the log keeps recording a byte per iteration. The claim then
      // asserts a run that never happened, the worker's replay steps one tick
      // per byte from a correctly advancing engine, and the two diverge on the
      // first hiccup.
      while (accumulatorRef.current >= FIXED_STEP_MS && !game.gameOver) {
        // Sample the step's input, encode it, step under it — in that order,
        // so the byte on the left is exactly the input the step ran under.
        // Sampling afterwards would round a press and a step apart.
        const scrub = scrubPendingRef.current;
        scrubPendingRef.current = null;
        // A scrub byte cannot carry the launch bit (bit 7 owns the byte), so
        // a launch pending behind a dragging finger rides the next keyboard
        // byte — the pending flag is only consumed when it goes out.
        const launch = scrub === null && launchPendingRef.current;
        if (launch) launchPendingRef.current = false;

        const movingLeft =
          pressedKeysRef.current.has("ArrowLeft") ||
          pressedKeysRef.current.has("KeyA");
        const movingRight =
          pressedKeysRef.current.has("ArrowRight") ||
          pressedKeysRef.current.has("KeyD");
        const input = {
          dir: ((movingRight ? 1 : 0) - (movingLeft ? 1 : 0)) as -1 | 0 | 1,
          launch,
          scrub,
        };

        inputLogRef.current.push(encodeTick(input));
        game = tick(game, FIXED_STEP_MS, input);
        gameRef.current = game;
        accumulatorRef.current -= FIXED_STEP_MS;
        pumpVerificationChunks();
        if (game.gameOver) break;
      }

      // The run may have ended on the step above — freeze it before the
      // render that announces it.
      freezeClaim();

      // Guarded the way `freezeClaim` guards: the loop above only steps a
      // live game, so the ref cannot be null here — but it is typed
      // nullable, and the render wants the *latest* value, after the loop's
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
  }, [mode, runtime?.gameOver, showExitConfirm, bootstrap]);

  // ── Reward grant ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (
      !runtime?.gameOver ||
      !runtime.won ||
      rewardGrantedRef.current ||
      mode !== "reward"
    ) {
      return;
    }
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
      console.error("[barley-breaker] win with no frozen claim");
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
        amount: BARLEY_BREAKER_RAVEN_COIN_REWARD,
        verify: claim,
      });
    });
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
              {/* Touch players never see the keyboard, so naming it here would
                  describe controls they cannot reach. */}
              {isTouchDevice
                ? "Controls: drag the bar to move, tap LAUNCH to fire the barley."
                : "Controls: Arrow keys or A/D to move, Space to launch the barley."}
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

          {/* Controls */}
          {/* Sits in the same column as the arena rather than beside it, so
              `FitStage` counts it as chrome: it sums the height of the board's
              siblings, and stacked above the board on a phone that height is
              real screen the arena has to be measured against. */}
          <div className="flex justify-center md:justify-start shrink-0">
            <div className="w-full md:w-[190px] rounded border border-white/20 bg-black/40 px-3 py-3 text-xs text-slate-200 space-y-1">
              <div className="font-semibold text-slate-100">Controls</div>
              {/* The panel sits directly above the arena, so on a phone it is
                  the first thing read — it must not describe a keyboard the
                  player has not got. */}
              {isTouchDevice ? (
                <>
                  <div>Move: drag the bar</div>
                  <div>Launch: tap LAUNCH</div>
                </>
              ) : (
                <>
                  <div>Move Left: A / Left</div>
                  <div>Move Right: D / Right</div>
                  <div>Launch: Space</div>
                </>
              )}
              <div>Exit: Exit Button</div>
            </div>
          </div>

          {/* Arena */}
          {/* `FitStage` scales the arena down to whatever is actually left for
              it, and measures the chrome it shares the screen with rather than
              assuming a size: the arena is 760px wide, so on a phone it was
              being laid out at full size inside a phone-width popup and clipped
              by it. Bricks, drops, balls and the paddle are all positioned in
              arena pixels from the top-left of this element, so nothing
              downstream changes — only the scale the whole board is drawn at. */}
          <FitStage
            width={ARENA_WIDTH}
            height={ARENA_HEIGHT}
            minScale={MIN_STAGE_SCALE}
          >
            <div
              className="relative h-full w-full rounded border border-slate-500 bg-slate-950 overflow-hidden"
              style={{
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
          </FitStage>

          {/* Touch controls */}
          {/* Barley Breaker was keyboard-only, which made the cabinet
              unplayable on a phone. `TouchMoveBar` is deliberately not a second
              input path for the keys: its fire button sends the `Space` pair the
              keyboard already handles, and its scrub maps the finger onto the
              same `clampPaddleX` range the `ArrowLeft`/`ArrowRight` poll moves
              within, so the paddle behaves identically whichever one drives it.
              It is a *sibling* of the stage rather than a child of it, which is
              the point: `FitStage` sums the height of the board's siblings, so
              the bar's height is already being held back from the arena and
              adding a `reserve` for it as well would count it twice.
              `shrink-0` keeps the flex column from squashing it. Gated on
              `(pointer: coarse)`, so a desktop player keeps the keyboard and
              gets no bar in front of them. */}
          {isTouchDevice && !runtime.gameOver && (
            /* `sticky bottom-0`: on a short phone the panel scrolls, and a
               control bar that scrolls off the bottom is a control bar the
               player cannot reach. Verified at 320×640, where Pac-Man's down
               key sat 26px below the fold and simply stopped responding. */
            <div className="sticky bottom-0 z-10 shrink-0 bg-slate-950/95 py-1">
              <TouchMoveBar onScrub={scrubPaddle} onFire={launchFromTouch} />
            </div>
          )}

          <div className="rounded border border-slate-700 bg-slate-900/70 p-3 text-xs text-slate-300 flex flex-wrap items-center justify-between gap-2">
            <div>
              Score by row: 10 / 20 / 30 / 40 from bottom to top. Reach the
              target score to win the run.
            </div>
            <div className="flex gap-2">
              <Button onClick={requestLaunch}>LAUNCH</Button>
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
