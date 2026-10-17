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
import { useBootstrap } from "lib/portal/BootstrapContext";
import type { VerifiedRun } from "lib/portal/api";
import {
  writeNonce,
  getEconomyWorkerUrl,
  postEconomyWrite,
} from "lib/portal/api";
import { CHUNK_TICKS } from "@nightshade/shared/anticheat/replayBudget";
import { encodeInputLog } from "@nightshade/shared/anticheat/inputLog";
import {
  FROGGER_DIFFICULTIES,
  FROGGER_RAVEN_COIN_REWARD,
  FroggerDifficulty,
  FroggerDifficultyName,
  FroggerMode,
  getFroggerDifficulty,
  isFroggerRewardRunAvailable,
} from "./session";
import {
  ARENA_H,
  ARENA_W,
  CELL,
  FIXED_STEP_MS,
  HOME_ROW,
  PLAYER_SIZE,
  START_ROW,
  VIEWPORT_ROWS,
  WORLD_ROWS,
  createRuntime,
  encodeTick,
  getRowType,
  getWrappedCopies,
  isLogSunk,
  mod,
  tick,
  type FroggerRuntime,
  type RowType,
} from "./engine";

// ── Visual config ─────────────────────────────────────────────────────────────
const LANE_COLORS: Record<RowType, string> = {
  home: "#c8971a",
  safe: "#2d6b2d",
  road: "#3a3a3a",
  river: "#0b4fa3",
  checkpoint: "#3a6b22",
};

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

const panelClassName =
  "mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden";

const INTERCEPTED_CODES = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "KeyA",
  "KeyD",
  "KeyW",
  "KeyS",
]);

// ── xstate selector ───────────────────────────────────────────────────────────
const _portalState = (state: PortalMachineState) => state.context.state;

// ── Component ─────────────────────────────────────────────────────────────────
export const FroggerGame: React.FC<{ onClose?: () => void }> = ({
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });
  const bootstrap = useBootstrap();

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
  // True from the moment a reward run is confirmed until its first step is
  // taken. Opening a paid run waits on a server round-trip (burn the ticket,
  // then read back the issued seed) — so without this the menu just sits
  // looking frozen, and "START REWARD RUN" stays live underneath, where a
  // second click would burn a *second* run.
  const [startingRun, setStartingRun] = useState(false);
  // True when a reward run could not read the seed the server issued for it.
  // The run is never started from a local substitute: the claim only mints
  // against the issued seed, so playing on would be a win that pays nothing.
  const [seedError, setSeedError] = useState(false);

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
  // arrangement as `BarleyBreakerGame.tsx`'s `gameRef`, whose chunk plumbing
  // below is mirrored one-for-one).
  const gameRef = useRef<FroggerRuntime | null>(null);

  /** One byte per 16ms step: the input the step was taken *under*. */
  const inputLogRef = useRef<number[]>([]);

  /** Real time not yet spent on whole `FIXED_STEP_MS` steps. */
  const accumulatorRef = useRef(0);

  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  /** When the current run opened — the claim's `elapsedMs`. */
  const runStartedAtRef = useRef<number>(0);

  /** The run's difficulty, readable from inside the loop effect. */
  const activeDifficultyRef = useRef<FroggerDifficulty>(todaysDifficulty);

  /** The claim, frozen the instant the run settles — see `freezeClaim`. */
  const frozenClaimRef = useRef<VerifiedRun | null>(null);

  /**
   * The QUIT dialog's forfeit, requested by the button and settled by the
   * loop.
   *
   * The game ends *inside* a step — deaths, wins and forfeits all pass
   * through `gameRef` so the frozen claim, its log and the render's snapshot
   * are read from one state of the run. A direct `setRuntime` here would flip
   * the render while the loop kept stepping a different object, and the claim
   * would describe the run nobody played.
   */
  const forfeitRequestedRef = useRef(false);

  const chunkIndexRef = useRef(0);
  const chunkBusyRef = useRef(false);
  const chunkBrokenRef = useRef(false);
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const chunkDrainedRef = useRef<Promise<void> | null>(null);

  const returnToMenu = useCallback(() => {
    pressedKeysRef.current.clear();
    setMode(null);
    setRuntime(null);
    setShowPracticePrompt(false);
    setShowExitConfirm(false);
    setStartingRun(false);
    setSeedError(false);
    rewardGrantedRef.current = false;
    gameRef.current = null;
    inputLogRef.current = [];
    frozenClaimRef.current = null;
    forfeitRequestedRef.current = false;
    chunkDrainedRef.current = null;
  }, []);

  /**
   * Read the seed the server issued for the run that is open.
   *
   * Returns null on any error — a reward run then stops and reports it rather
   * than ever stepping from a seed the server did not issue. Retries until the
   * returned runKey is recent (within ~15s), to avoid racing the server's
   * `active_runs` row creation: the ticket burn that opens the run is
   * fire-and-forget, so this poll is usually the thing *waiting* on that
   * round-trip to settle.
   */
  const fetchRunSeed = useCallback(
    async (jwt: string | undefined): Promise<number | null> => {
      if (!jwt) return null;
      const startedAt = Date.now();
      const maxWaitMs = 10_000;
      // Tight on purpose: the seed is written after the ticket burn settles, so
      // a coarse interval would stack its own latency on top of the round trip
      // once the row lands.
      const pollIntervalMs = 150;

      while (Date.now() - startedAt < maxWaitMs) {
        try {
          const res = await postEconomyWrite({ token: jwt, intent: "run-seed" });
          const payload = res.data as
            | { seed?: number; runKey?: number }
            | undefined;
          if (payload?.seed !== undefined && payload?.runKey) {
            const runAgeMs = Date.now() - payload.runKey;
            if (runAgeMs <= 15_000) return Number(payload.seed);
            // Stale runKey (an older, already-played run): wait for the new
            // one to be written before trusting the seed beside it.
          }
        } catch {
          // Transient — retry.
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      return null;
    },
    [],
  );

  const startSession = useCallback(
    async (
      nextMode: FroggerMode,
      practiceDifficultyOverride?: FroggerDifficultyName,
    ) => {
      if (nextMode === "reward" && !hasRewardRun) return;
      // From here a paid run is already being opened on the server (the confirm
      // handler burned the ticket / spent the allowance before calling in), so
      // flip the loading card immediately — before the seed round-trip below —
      // so the menu never sits frozen while we wait.
      if (nextMode === "reward") setStartingRun(true);
      setSeedError(false);

      const selectedPracticeDifficultyName =
        practiceDifficultyOverride ?? practiceDifficultyName;
      const selectedPracticeDifficulty =
        FROGGER_DIFFICULTIES.find(
          (difficulty) => difficulty.name === selectedPracticeDifficultyName,
        ) ?? todaysDifficulty;
      const difficulty =
        nextMode === "reward" ? todaysDifficulty : selectedPracticeDifficulty;

      // Reward run: the seed is issued by the server at run-open and read back
      // here — no local substitute, because the claim only mints against the
      // issued seed. A failed read stops the run and says so. Practice: a
      // local seed, because it is never verified.
      let seed: number;
      if (nextMode === "reward") {
        const issued = await fetchRunSeed(bootstrap?.jwt);
        if (issued === null) {
          setStartingRun(false);
          setSeedError(true);
          return;
        }
        seed = issued;
      } else {
        seed = (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
      }

      // One runtime instance, shared by the loop (through `gameRef`) and the
      // first render (through its snapshot): two `createRuntime` calls would be
      // two games, and the claim would describe the one nobody played.
      pressedKeysRef.current.clear();
      const fresh = createRuntime(difficulty, seed);
      gameRef.current = fresh;
      setRuntime({ ...fresh });

      setActiveDifficulty(difficulty);
      setMode(nextMode);
      setShowPracticePrompt(false);
      setShowExitConfirm(false);
      setStartingRun(false);
      rewardGrantedRef.current = false;

      // Fresh run, fresh proof: the log, the claim and the stream all belong
      // to exactly one run, and a "Play Again" that inherited the previous
      // run's cursor would post its first window at an index the worker's
      // brand-new park has never heard of.
      activeDifficultyRef.current = difficulty;
      inputLogRef.current = [];
      frozenClaimRef.current = null;
      forfeitRequestedRef.current = false;
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
          name: "frogger" as any,
        });
        startAttempt();
      }
    },
    [
      bootstrap,
      hasRewardRun,
      practiceDifficultyName,
      portalService,
      todaysDifficulty,
      fetchRunSeed,
    ],
  );

  // Free run first, then 1 burned Play Ticket per attempt — with the "are you
  // sure?" box in between. `hasRewardRun` is kept as the availability check so
  // the button and the store can never disagree.
  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "frogger",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!INTERCEPTED_CODES.has(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
      pressedKeysRef.current.add(event.code);
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      pressedKeysRef.current.delete(event.code);
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
    };
  }, [!!runtime]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Game loop ─────────────────────────────────────────────────────────────
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
     * difficulty — the only engine context the claim repeats — and every later
     * window inherits the seed from the park, which the worker opened from the
     * ledger rather than from this request.
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
     * already contains whatever step ended the run (the engine applies deaths
     * inside the step), so the claim's score, its log and its duration are all
     * read from one state of the run rather than from a later frame.
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
        cabinet: "frogger",
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

      // A forfeit from the QUIT dialog settles here, through the same door
      // every other run end comes through — the loop, in place of `gameRef`,
      // one frame after the button was pressed.
      if (forfeitRequestedRef.current && !game.gameOver) {
        forfeitRequestedRef.current = false;
        game = {
          ...game,
          gameOver: true,
          won: game.score >= activeDifficultyRef.current.targetScore,
          reason: "Run forfeited.",
        };
        gameRef.current = game;
      }

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
        const keys = pressedKeysRef.current;
        const input = {
          up: keys.has("ArrowUp") || keys.has("KeyW"),
          down: keys.has("ArrowDown") || keys.has("KeyS"),
          left: keys.has("ArrowLeft") || keys.has("KeyA"),
          right: keys.has("ArrowRight") || keys.has("KeyD"),
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
  }, [mode, runtime?.gameOver, bootstrap]);

  // ── Reward submission ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!runtime?.gameOver || rewardGrantedRef.current || mode !== "reward") {
      return;
    }
    rewardGrantedRef.current = true;

    // The leaderboard score is written for every settled run — a loss still
    // played, and the board is the record of it.
    submitScore({ score: runtime.score });

    if (!runtime.won) return;

    // The claim was frozen by the loop the instant the run settled — score,
    // log and duration from one state. Absent means the win somehow happened
    // without the loop settling, which cannot happen while the loop is
    // running; it is still checked, because claiming with no log would burn
    // the voucher for nothing — and the voucher is the player's ticket, not
    // ours to spend.
    const claim = frozenClaimRef.current;
    if (!claim) {
      console.error("[frogger] win with no frozen claim");
      return;
    }

    // The tail windows are still on the wire when this effect runs — the
    // freeze, the tail and the `gameOver` that triggered this are all observed
    // in the same frame. The claim may only land once the park holds the
    // whole log: overtaking it makes the worker start the replay from tick
    // zero, and a run this long cannot be re-simulated inside one request, so
    // the refusal that follows would be of an honestly won coin.
    void (chunkDrainedRef.current ?? Promise.resolve()).then(() => {
      portalService.send({
        type: "arcadeMinigame.ravenCoinWon",
        amount: FROGGER_RAVEN_COIN_REWARD,
        verify: claim,
      });
    });
  }, [mode, portalService, runtime]);

  // ── Unmount cleanup ────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  // ── Menu ──────────────────────────────────────────────────────────────────
  if (!mode || !runtime) {
    return (
      <OuterPanel className={panelClassName}>
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
              Bonus: +100 pts for reaching the mid checkpoint &bull; +500 pts
              for reaching home
            </div>
          </InnerPanel>

          <button
            onClick={rewardRun.start}
            disabled={!hasRewardRun || startingRun}
            className={`w-full px-6 py-4 rounded-lg font-bold transition-all shadow-lg text-lg ${
              hasRewardRun && !startingRun
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

          {startingRun && (
            <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-sm rounded border border-white/30 bg-slate-900 p-6 space-y-3 text-white text-center">
                <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-white" />
                <h3 className="text-lg font-bold">Starting your run…</h3>
                <p className="text-sm text-slate-300">
                  Opening a reward run on the server and seeding today&apos;s
                  traffic. Hold tight — this only takes a moment.
                </p>
              </div>
            </div>
          )}

          {seedError && (
            <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-sm rounded border border-red-500/50 bg-slate-900 p-6 space-y-3 text-white text-center">
                <h3 className="text-lg font-bold text-red-400">
                  Couldn&apos;t start your run
                </h3>
                <p className="text-sm text-slate-300">
                  The server didn&apos;t send this run&apos;s seed, so we
                  stopped instead of starting a game that couldn&apos;t be
                  verified or paid out. Refresh the page and try again — if it
                  keeps happening, your connection may be dropping.
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="w-full px-6 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 active:scale-95 transition-all"
                >
                  REFRESH THE PAGE
                </button>
              </div>
            </div>
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
  const portrait = bumpkinPortraitBox(PLAYER_RENDER_HEIGHT);
  const playerParts =
    portalGameState.bumpkin?.equipped ?? NPC_WEARABLES["pumpkin' pete"];

  return (
    <OuterPanel className={panelClassName}>
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
              is width-bound and the floor is what keeps it from being scaled
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
                    // Settled by the loop on its next frame, through the same
                    // door every other run end comes through — a direct
                    // `setRuntime` here would flip the render while the loop
                    // kept stepping a different object.
                    forfeitRequestedRef.current = true;
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
