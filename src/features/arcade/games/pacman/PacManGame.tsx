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
import { useBootstrap } from "lib/portal/BootstrapContext";
import type { VerifiedRun } from "lib/portal/api";
import { writeNonce, getEconomyWorkerUrl } from "lib/portal/api";
import { CHUNK_TICKS } from "@nightshade/shared/anticheat/replayBudget";
import { encodeInputLog } from "@nightshade/shared/anticheat/inputLog";
import {
  getPacManDifficulty,
  isPacManRewardRunAvailable,
  PAC_MAN_DIFFICULTIES,
  PAC_MAN_RAVEN_COIN_REWARD,
  PacManDifficulty,
  PacManDifficultyName,
  PacManMode,
} from "./session";
import {
  FIXED_STEP_MS,
  FRIGHTENED_FLASH_START_MS,
  FRIGHTENED_FLASH_TOGGLE_MS,
  MAZE_COLS,
  MAZE_ROWS,
  codeFromDir,
  createRuntime,
  tick,
  type Dir,
  type PacManRuntime,
} from "./engine";

// ─────────────────────────────────────────────────────────────────────────────
// Draw-only constants (the maze itself lives in `engine.ts`)
// ─────────────────────────────────────────────────────────────────────────────
const CELL = 20; // px per tile
const ARENA_W = MAZE_COLS * CELL; // 560
const ARENA_H = MAZE_ROWS * CELL; // 620

/**
 * The floor on how far a *short window* may shrink the maze.
 *
 * It does not apply to width — `FitStage` always fits the width exactly, so a
 * floor can never push the maze off the side of its container. This is here for
 * the other case: a short landscape window where the height budget runs out
 * first. Past 0.51 the maze is a size worth playing and the panel scrolls;
 * below it there is nothing left to aim in, so the board stops shrinking and the page
 * scrolls instead.
 */
const MIN_STAGE_SCALE = 0.51;

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
  const bootstrap = useBootstrap();

  const hasRewardRun = useMemo(
    () => isPacManRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const todaysDifficulty = useMemo(() => getPacManDifficulty(), []);

  const isTouchDevice = useIsTouchDevice();

  const [mode, setMode] = useState<PacManMode | null>(null);
  const [runtime, setRuntime] = useState<PacManRuntime | null>(null);
  const [showPracticePrompt, setShowPracticePrompt] = useState(false);
  const [activeDifficulty, setActiveDifficulty] =
    useState<PacManDifficulty>(todaysDifficulty);
  const [practiceDifficultyName, setPracticeDifficultyName] =
    useState<PacManDifficultyName>(todaysDifficulty.name);
  const [showExitConfirm, setShowExitConfirm] = useState(false);

  /** Centering box for the portrait, whose own width is measured at runtime. */
  const portrait = useMemo(() => bumpkinPortraitBox(PLAYER_RENDER_HEIGHT), []);

  const playerParts =
    portalGameState.bumpkin?.equipped ?? NPC_WEARABLES["pumpkin' pete"];

  const nextDirRef = useRef<Dir>("none");
  const rewardGrantedRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  // ── The run, its proof log, and the streamed verification ────────────────
  //
  // The simulation state lives in `gameRef`, not in React state: a step is
  // read from the settled previous step and produces the next one, possibly
  // several times per frame, and the input log must be written exactly once
  // per step — both are side effects, and running them inside a `setState`
  // updater would double-write them under StrictMode's double-invoke. React
  // state carries a per-frame *snapshot* for rendering only, exactly as the
  // brawler's `matchRef` does (see `SunflowerBrawlerGame.tsx`, whose chunk
  // plumbing below is mirrored one-for-one).
  const gameRef = useRef<PacManRuntime | null>(null);

  /** One byte per 20ms step: the direction held *before* that step ran. */
  const inputLogRef = useRef<number[]>([]);

  /** Real time not yet spent on whole `FIXED_STEP_MS` steps. */
  const accumulatorRef = useRef(0);

  /** When the current run opened — the claim's `elapsedMs`. */
  const runStartedAtRef = useRef<number>(0);

  /** The run's difficulty, readable from inside the loop effect. */
  const activeDifficultyRef = useRef<PacManDifficulty>(todaysDifficulty);

  /** The claim, frozen the instant the run settles — see `freezeClaim`. */
  const frozenClaimRef = useRef<VerifiedRun | null>(null);

  const chunkIndexRef = useRef(0);
  const chunkBusyRef = useRef(false);
  const chunkBrokenRef = useRef(false);
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const chunkDrainedRef = useRef<Promise<void> | null>(null);

  const returnToMenu = useCallback(() => {
    setShowExitConfirm(false);
    setMode(null);
    setRuntime(null);
    nextDirRef.current = "none";
    gameRef.current = null;
    inputLogRef.current = [];
    frozenClaimRef.current = null;
    chunkDrainedRef.current = null;
  }, []);

  // ── Start session ───────────────────────────────────────────────────────────
  const startSession = useCallback(
    (nextMode: PacManMode, practiceOverride?: PacManDifficultyName) => {
      if (nextMode === "reward" && !hasRewardRun) return;

      const practiceName = practiceOverride ?? practiceDifficultyName;
      const practiceDiff =
        PAC_MAN_DIFFICULTIES.find((d) => d.name === practiceName) ??
        todaysDifficulty;
      const runDiff = nextMode === "reward" ? todaysDifficulty : practiceDiff;

      // One runtime instance, shared by the loop (through `gameRef`) and the
      // first render (through its snapshot): two `createRuntime` calls would be
      // two games, and the claim would describe the one nobody played.
      const fresh = createRuntime(runDiff);
      gameRef.current = fresh;
      setRuntime({ ...fresh });

      setMode(nextMode);
      setActiveDifficulty(runDiff);
      setShowPracticePrompt(false);
      rewardGrantedRef.current = false;
      nextDirRef.current = "none";

      // Fresh run, fresh proof: the log, the claim and the stream all belong
      // to exactly one run, and a "Play Again" that inherited the previous
      // run's cursor would post its first window at an index the worker's
      // brand-new park has never heard of.
      activeDifficultyRef.current = runDiff;
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
     * frame that happens to be — 600 steps is 12 seconds of play, so the queue
     * trails the log by seconds rather than by ticks.
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
     * and deaths inside the step), so the claim's score, its log and its
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
        cabinet: "pac-man",
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

      const game = gameRef.current;
      if (!game) return;

      // Whole steps only, and never more simulated time than the tab was
      // actually allowed to elapse (the brawler's own clamp): a backgrounded
      // tab must not fast-forward the maze on return.
      accumulatorRef.current += Math.min(ts - prevAt, 250);
      while (accumulatorRef.current >= FIXED_STEP_MS && !game.gameOver) {
        // Before the step, not after: the log records the direction the step
        // was taken *under*, which is what the worker feeds its own copy of
        // `tick`. Sampling afterwards would round a press and step apart.
        inputLogRef.current.push(codeFromDir(nextDirRef.current));
        gameRef.current = tick(game, FIXED_STEP_MS, nextDirRef.current);
        accumulatorRef.current -= FIXED_STEP_MS;
        pumpVerificationChunks();
        if (gameRef.current.gameOver) break;
      }

      // The run may have ended on the step above — freeze it before the
      // render that announces it.
      freezeClaim();

      // Guarded the way `freezeClaim` guards: the loop above only steps a
      // live game (421), so the ref cannot be null here — but it is typed
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
      console.error("[pac-man] win with no frozen claim");
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
        amount: PAC_MAN_RAVEN_COIN_REWARD,
        verify: claim,
      });
    });
  }, [mode, portalService, runtime]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Lobby
  // ─────────────────────────────────────────────────────────────────────────────
  if (!mode || !runtime) {
    return (
      <OuterPanel className="mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden">
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
              {/* Touch players never see the keyboard, so naming it here would
                  describe controls they cannot reach. */}
              {isTouchDevice
                ? "Move with the on-screen pad."
                : "Move with W/A/S/D or Arrow Keys."}
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
              <div className="w-full max-w-md rounded border border-white/30 bg-slate-900 p-5 text-white space-y-4">
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
    <OuterPanel className="mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden">
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
          {/* `FitStage` scales the maze down to whatever is actually left for
              it, and measures the chrome it shares the screen with rather than
              assuming a size: the maze is 560px wide, so on a phone it was being
              laid out at full size inside a phone-width popup and clipped by it.
              Walls, pellets, goblins and the player are all positioned in
              `CELL`-sized steps from the top-left of this element, so nothing
              downstream changes — only the scale the whole maze is drawn at. */}
          <FitStage width={ARENA_W} height={ARENA_H} minScale={MIN_STAGE_SCALE}>
            <div className="relative h-full w-full border border-blue-700 bg-black overflow-hidden">
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
                      // Same tile-centre convention as the player portrait: a
                      // tile's middle is `col * CELL + CELL / 2`. Both were half a
                      // tile off before, which lined them up with each other but
                      // not with the corridor they moved down.
                      left: wrapCol * CELL + CELL / 2 - CELL,
                      top: g.row * CELL + CELL / 2 - CELL,
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
                    // Centred on the tile's own centre. A tile spans
                    // `[col * CELL, col * CELL + CELL)`, so its middle is
                    // `col * CELL + CELL / 2` - which is where the pellets, kale
                    // and walls are already drawn. Centring the portrait on
                    // `col * CELL` instead put it half a tile up and to the left
                    // of the corridor it was travelling down.
                    //
                    // Purely visual: the collision checks compare tile
                    // coordinates (`dist({x: g.col, ...}, {x: playerCol, ...})`),
                    // never pixels, so nothing about the game changes.
                    left:
                      (((runtime.playerCol % MAZE_COLS) + MAZE_COLS) %
                        MAZE_COLS) *
                        CELL +
                      CELL / 2 -
                      portrait.width / 2,
                    top:
                      runtime.playerRow * CELL +
                      CELL / 2 -
                      PLAYER_RENDER_HEIGHT / 2,
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
          </FitStage>

          {/* Touch controls */}
          {/* Bumpkin-Man was keyboard-only, which made the cabinet unplayable on
              a phone. `TouchDPad` is not a second input path: each button
              dispatches the real `ArrowLeft`/`ArrowRight`/`ArrowUp`/`ArrowDown`
              keydown and keyup on `window`, which is exactly what the key
              handler above already turns into a heading — so a held pad direction
              is the same continuous heading a held arrow key gives, and the pad
              is driveable with no game code behind it. It is a *sibling* of the
              stage rather than a child of it, which is the point: `FitStage` sums
              the height of the maze's siblings, so the pad's 168px is already
              being held back from the maze and adding a `reserve` for it as well
              would count it twice. `shrink-0` keeps the flex column from
              squashing it. Gated on `(pointer: coarse)`, so a desktop player
              keeps the keyboard and gets no pad in front of them. */}
          {isTouchDevice && !runtime.gameOver && (
            <div className="sticky bottom-0 z-10 flex justify-center shrink-0 bg-slate-950/95 py-1">
              <TouchDPad />
            </div>
          )}

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
            {isTouchDevice
              ? "Use the pad to move."
              : "W/A/S/D or Arrow Keys to move."}{" "}
            Collect{" "}
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
