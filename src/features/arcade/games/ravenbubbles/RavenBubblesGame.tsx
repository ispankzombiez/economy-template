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
import { ITEM_DETAILS } from "../adapters/itemDetails";
import { useVipAccess } from "../adapters/useVipAccess";
import { useRewardRun } from "../adapters/rewardRun";
import { PortalContext, PortalMachineState } from "../adapters/portal";
import { startAttempt, submitScore } from "../adapters/portalUtil";
import { useBootstrap } from "lib/portal/BootstrapContext";
import type { VerifiedRun } from "lib/portal/api";
import {
  writeNonce,
  getEconomyWorkerUrl,
  postEconomyWrite,
} from "lib/portal/api";
import { CHUNK_TICKS } from "@nightshade/shared/anticheat/replayBudget";
import { encodeInputLog } from "@nightshade/shared/anticheat/inputLog";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import {
  getRavenBubblesDifficulty,
  isRavenBubblesRewardRunAvailable,
  RAVEN_BUBBLES_DIFFICULTIES,
  RAVEN_BUBBLES_RAVEN_COIN_REWARD,
  type RavenBubblesDifficulty,
  type RavenBubblesDifficultyName,
  type RavenBubblesMode,
} from "./session";
import {
  CEILING_SECONDS,
  CEILING_THICKNESS,
  DANGER_LINE_Y,
  FIXED_STEP_MS,
  MAX_GUIDE_PX,
  MIN_CLUSTER,
  PLAYFIELD_HEIGHT,
  PLAYFIELD_WIDTH,
  RADIUS,
  SHOOTER_X,
  SHOOTER_Y,
  SHOTS_PER_DROP,
  cellX,
  cellY,
  ceilingLimitY,
  clampAim,
  createRuntime,
  encodeTick,
  levelToAim,
  tick,
  touchesBubble,
  type BubbleColor,
  type RavenBubblesRuntime,
} from "./engine";

/**
 * Raven Bubbles' cabinet shell — the reward plumbing, not the rules.
 *
 * ## Why this file shrank around `engine.ts`
 *
 * This is a tick-simulated cabinet now: the worker mints a Raven Coin only if
 * its own re-run of the claimed session — `(difficulty, seed, inputs)` — ends
 * `gameOver && won` at the score the claim asserts. Re-running needs one copy
 * of the rules shared by both ends, which is `engine.ts`; what stays here is
 * everything the server cannot and should not do: aiming with a pointer, the
 * keyboard, the render, and the run's *transport* — reading the issued seed,
 * writing one input byte per 16 ms step, streaming the log to the worker as it
 * grows, and claiming only from the state the loop settled. The structure
 * mirrors `GoblinInvadersGame.tsx` one-for-one for exactly the reasons its
 * header gives: a whole-log shape cannot re-simulate a run this long inside one
 * request, so the proof arrives as `verify-chunk` windows during play and parks
 * between them.
 *
 * ## The seed, the log, and the claim
 *
 * Reward runs open with a `run-seed` intent against the server-issued run: the
 * seed that fixes every `createBoard`/`pickNextColor` roll is read back, not
 * invented (`fetchRunSeed`; a failed read stops the run with the seed-error
 * card rather than starting a game that could never be paid). Practice keeps a
 * local seed because it is never verified.
 *
 * Each step samples the input (the staged aim angle, the latched fire press),
 * encodes it to its log byte *first*, then steps under the same value — so the
 * byte on the left of `encodeTick` is exactly the input the step ran under. A
 * win freezes the claim (`freezeClaim`) from the settled game before the
 * render announces it, flushes the log's unwritten tail behind the windows
 * already on the wire, and the payout effect waits for that tail to drain: the
 * worker refuses a claim whose park holds less log than the claim asserts.
 */

const _portalState = (state: PortalMachineState) => state.context.state;

// ── Bubbles (art only — the rules live in `engine.ts`) ───────────────────────

/** The SFL crop art inside each bubble — the same theming Tetris uses. */
const BUBBLE_IMAGES: Record<BubbleColor, string> = {
  Sunflower: ITEM_DETAILS.Sunflower.image,
  Carrot: ITEM_DETAILS.Carrot.image,
  Pumpkin: ITEM_DETAILS.Pumpkin.image,
  Potato: ITEM_DETAILS.Potato.image,
  Corn: ITEM_DETAILS.Corn.image,
  Wheat: ITEM_DETAILS.Wheat.image,
};

/** Bubble shell colour, so each crop reads at a glance before its art loads. */
const BUBBLE_SHELL: Record<BubbleColor, string> = {
  Sunflower: "#fbbf24",
  Carrot: "#fb923c",
  Pumpkin: "#c2410c",
  Potato: "#d6d3d1",
  Corn: "#fde047",
  Wheat: "#b45309",
};

/** One bubble: a glossy shell with the crop art inside. */
const Bubble: React.FC<{ color: BubbleColor; size?: number }> = ({
  color,
  size = RADIUS * 2,
}) => (
  <div
    className="rounded-full border border-black/40 flex items-center justify-center"
    style={{
      width: size,
      height: size,
      background: `radial-gradient(circle at 32% 28%, rgba(255,255,255,0.9), rgba(255,255,255,0) 44%), ${BUBBLE_SHELL[color]}`,
    }}
  >
    <img
      src={BUBBLE_IMAGES[color]}
      alt={color}
      draggable={false}
      className="rounded-full"
      style={{
        width: size - 10,
        height: size - 10,
        imageRendering: "pixelated",
      }}
    />
  </div>
);

/**
 * Where the run is, as one word for the handlers and the render.
 *
 * The engine has no `status` field — `shot: null` *is* aiming, and
 * `gameOver`/`won` carry the endings — so this derives it rather than
 * duplicating a status the step would then have to keep in sync.
 */
type ShotStatus = "aiming" | "shooting" | "won" | "lost";

export const RavenBubblesGame: React.FC<{ onClose?: () => void }> = ({
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });
  const bootstrap = useBootstrap();

  const hasRewardRun = useMemo(
    () => isRavenBubblesRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const todaysDifficulty = useMemo(() => getRavenBubblesDifficulty(), []);

  const isTouchDevice = useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches,
    [],
  );

  const [mode, setMode] = useState<RavenBubblesMode | null>(null);
  const [runtime, setRuntime] = useState<RavenBubblesRuntime | null>(null);
  const [practiceDifficultyName, setPracticeDifficultyName] =
    useState<RavenBubblesDifficultyName>(todaysDifficulty.name);
  const [showPracticeDifficultyPrompt, setShowPracticeDifficultyPrompt] =
    useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [scale, setScale] = useState(1);
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

  const scaleRef = useRef(1);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);

  const rewardGrantedRef = useRef(false);
  const playfieldRef = useRef<HTMLDivElement | null>(null);
  const touchAimingRef = useRef(false);

  /**
   * The aim angle as last *pointed at*, staged for the next step.
   *
   * A ref, not state: the pointer handlers only aim, the step samples it, and
   * what the render shows is the step's quantised `runtime.aimLevel` — so the
   * indicator, the guide dots and the shot all describe the same 128-level
   * angle the byte carries, never a float the byte could not.
   */
  const aimRef = useRef(0);
  /** A fire press latched until the next step consumes it. */
  const firePendingRef = useRef(false);

  // ── The run, its proof log, and the streamed verification ─────────────────
  //
  // The simulation state lives in `gameRef`, not in React state: a step is
  // read from the settled previous step and produces the next one, possibly
  // several times per frame, and the input log must be written exactly once
  // per step — both are side effects, and running them inside a `setState`
  // updater would double-write them under StrictMode's double-invoke. React
  // state carries a per-frame *snapshot* for rendering only (the same
  // arrangement as `FroggerGame.tsx`'s `gameRef`, whose chunk plumbing below
  // is mirrored one-for-one).
  const gameRef = useRef<RavenBubblesRuntime | null>(null);

  /** One byte per 16ms step: the input the step was taken *under*. */
  const inputLogRef = useRef<number[]>([]);

  /** Real time not yet spent on whole `FIXED_STEP_MS` steps. */
  const accumulatorRef = useRef(0);

  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  /** When the current run opened — the claim's `elapsedMs`. */
  const runStartedAtRef = useRef<number>(0);

  /** The run's difficulty, readable from inside the loop effect. */
  const activeDifficultyRef = useRef<RavenBubblesDifficulty>(todaysDifficulty);

  /** The claim, frozen the instant the run settles — see `freezeClaim`. */
  const frozenClaimRef = useRef<VerifiedRun | null>(null);

  /**
   * The QUIT dialog's forfeit, requested by the button and settled by the
   * loop.
   *
   * The game ends *inside* a step — losses, wins and forfeits all pass through
   * `gameRef` so the frozen claim, its log and the render's snapshot are read
   * from one state of the run. A direct `setRuntime` here would flip the
   * render while the loop kept stepping a different object, and the claim
   * would describe the run nobody played.
   */
  const forfeitRequestedRef = useRef(false);

  const chunkIndexRef = useRef(0);
  const chunkBusyRef = useRef(false);
  const chunkBrokenRef = useRef(false);
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve());
  const chunkDrainedRef = useRef<Promise<void> | null>(null);

  // Derived from the one runtime — see `ShotStatus`. `aim` and the clock are
  // the same story: the render shows the step's values, not a parallel copy.
  const status: ShotStatus = !runtime
    ? "aiming"
    : runtime.gameOver
      ? runtime.won
        ? "won"
        : "lost"
      : runtime.shot
        ? "shooting"
        : "aiming";
  const aim = runtime ? levelToAim(runtime.aimLevel) : 0;
  const ceilingSeconds = runtime
    ? Math.ceil(runtime.ceilingMs / 1000)
    : CEILING_SECONDS;

  const returnToMenu = useCallback(() => {
    aimRef.current = 0;
    firePendingRef.current = false;
    touchAimingRef.current = false;
    setMode(null);
    setRuntime(null);
    setShowPracticeDifficultyPrompt(false);
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
      nextMode: RavenBubblesMode,
      practiceDifficultyOverride?: RavenBubblesDifficultyName,
    ) => {
      if (nextMode === "reward" && !hasRewardRun) return;
      // From here a paid run is already being opened on the server (the confirm
      // handler burned the ticket / spent the allowance before calling in), so
      // flip the loading card immediately — before the seed round-trip below —
      // so the menu never sits frozen while we wait.
      if (nextMode === "reward") setStartingRun(true);
      setSeedError(false);

      const chosenPracticeName =
        practiceDifficultyOverride ?? practiceDifficultyName;
      const selectedPracticeDifficulty =
        RAVEN_BUBBLES_DIFFICULTIES.find(
          (difficulty) => difficulty.name === chosenPracticeName,
        ) ?? todaysDifficulty;
      const runDifficulty =
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
      aimRef.current = 0;
      firePendingRef.current = false;
      touchAimingRef.current = false;
      const fresh = createRuntime(runDifficulty, seed);
      gameRef.current = fresh;
      setRuntime({ ...fresh });

      setMode(nextMode);
      setShowPracticeDifficultyPrompt(false);
      setShowExitConfirm(false);
      setStartingRun(false);
      rewardGrantedRef.current = false;

      // Fresh run, fresh proof: the log, the claim and the stream all belong
      // to exactly one run, and a "Play Again" that inherited the previous
      // run's cursor would post its first window at an index the worker's
      // brand-new park has never heard of.
      activeDifficultyRef.current = runDifficulty;
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
          name: "raven-bubbles" as any,
        });
        startAttempt();
      }
    },
    [
      bootstrap,
      hasRewardRun,
      portalService,
      practiceDifficultyName,
      todaysDifficulty,
      fetchRunSeed,
    ],
  );

  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "raven-bubbles",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  // Keyboard: arrows stage the aim, Space latches a fire. The press is *not*
  // fired here — the next step consumes it, so a press lands on exactly one
  // step's byte (see `encodeTick`), and holding the arrow key still repeats
  // the way it did against the live game's own key handler.
  useEffect(() => {
    if (!mode) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "ArrowLeft") {
        aimRef.current = clampAim(aimRef.current - 0.07);
        event.preventDefault();
      } else if (event.code === "ArrowRight") {
        aimRef.current = clampAim(aimRef.current + 0.07);
        event.preventDefault();
      } else if (event.code === "Space") {
        firePendingRef.current = true;
        event.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      aimRef.current = 0;
      firePendingRef.current = false;
    };
  }, [mode]);

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
     * already contains whatever step ended the run (the engine applies losses
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
        cabinet: "raven-bubbles",
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
          won: game.score >= game.difficulty.targetScore,
          reason: "Run forfeited.",
          shot: null,
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
        // Sampling afterwards would round a press and a step apart.
        const fire = firePendingRef.current;
        if (fire) firePendingRef.current = false;
        const input = { aim: aimRef.current, fire };

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
    if (
      !runtime?.gameOver ||
      !runtime.won ||
      rewardGrantedRef.current ||
      mode !== "reward"
    ) {
      return;
    }

    // The claim was frozen by the loop the instant the run settled — score,
    // log and duration from one state. Absent means the win somehow happened
    // without the loop settling, which cannot happen while the loop is
    // running; it is still checked, because claiming with no log would burn
    // the voucher for nothing — and the voucher is the player's ticket, not
    // ours to spend.
    const claim = frozenClaimRef.current;
    if (!claim) {
      console.error("[raven-bubbles] win with no frozen claim");
      return;
    }
    rewardGrantedRef.current = true;

    // The leaderboard score is written for every settled win — the board is
    // the record of it.
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
        amount: RAVEN_BUBBLES_RAVEN_COIN_REWARD,
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

  const aimFromPoint = useCallback((clientX: number, clientY: number) => {
    const playfield = playfieldRef.current;
    if (!playfield) return;

    const rect = playfield.getBoundingClientRect();
    const s = scaleRef.current;
    // The rendered box is scaled, so undo it to get logical board coordinates.
    const dx = (clientX - rect.left) / s - SHOOTER_X;
    const dy = SHOOTER_Y - (clientY - rect.top) / s;

    aimRef.current = clampAim(Math.atan2(dx, dy));
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (status !== "aiming") return;
      aimFromPoint(event.clientX, event.clientY);
    },
    [aimFromPoint, status],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (status !== "aiming") return;

      aimFromPoint(event.clientX, event.clientY);

      // Touch players drag to aim and lift to fire, so a tap never shoots
      // before they have pointed at anything. The press is latched, not fired:
      // the next step consumes it (see the keyboard effect above), so pointer
      // and keyboard are the same one-shot door.
      if (event.pointerType === "touch") {
        touchAimingRef.current = true;
        return;
      }

      firePendingRef.current = true;
    },
    [aimFromPoint, status],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== "touch" || !touchAimingRef.current) return;
      touchAimingRef.current = false;
      if (status !== "aiming") return;

      aimFromPoint(event.clientX, event.clientY);
      firePendingRef.current = true;
    },
    [aimFromPoint, status],
  );

  /**
   * Dotted aim guide, bounced off the walls, stopped by the first bubble, the
   * ceiling slab, or {@link MAX_GUIDE_PX}.
   *
   * The cap is what keeps it a guide. Traced to the ceiling it ran the full
   * height of the board, which read as a laser sight rather than a hint at
   * where the shot is pointed.
   *
   * Traced from `aim` — the step's quantised angle — so the dots describe the
   * same shot the byte carries. (This is the *render's* trace: trig is
   * allowed here because nothing the worker replays ever runs it.)
   */
  const aimDots = useMemo(() => {
    if (status !== "aiming" || !runtime) return [];

    const dots: { x: number; y: number }[] = [];
    let x = SHOOTER_X;
    let y = SHOOTER_Y;
    let dx = Math.sin(aim);
    let dy = -Math.cos(aim);

    for (let step = 0; step < 60; step++) {
      x += dx * 9;
      y += dy * 9;

      if (x < RADIUS) {
        x = RADIUS;
        dx = -dx;
      } else if (x > PLAYFIELD_WIDTH - RADIUS) {
        x = PLAYFIELD_WIDTH - RADIUS;
        dx = -dx;
      }

      if (y - RADIUS <= ceilingLimitY(runtime.ceilingRow)) break;
      if (touchesBubble(runtime.grid, x, y, runtime.ceilingRow)) break;

      dots.push({ x, y });

      const travelled = Math.hypot(x - SHOOTER_X, y - SHOOTER_Y);
      if (travelled >= MAX_GUIDE_PX) break;
    }

    return dots;
  }, [aim, runtime, status]);

  // ── Lobby ──────────────────────────────────────────────────────────────────

  if (!mode || !runtime) {
    return (
      <OuterPanel className="mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden">
        <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
          <div className="text-center space-y-2">
            <h2 className="text-4xl font-bold">RAVEN BUBBLES</h2>
            <p className="text-sm text-gray-600">
              Pop crop bubbles, outlast the ceiling, and hit today&apos;s target
              score.
            </p>
          </div>

          <InnerPanel className="bg-amber-50 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">REWARD</div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-amber-800">
                  {RAVEN_BUBBLES_RAVEN_COIN_REWARD}
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
              {isTouchDevice
                ? "Touch: drag to aim, lift to shoot."
                : "Mouse: move to aim, click to shoot."}
            </div>
            <div className="mt-1">
              Keyboard: left/right arrows to aim, Space to shoot.
            </div>
            <div className="mt-1">
              Match {MIN_CLUSTER} or more of a colour to pop them. The ceiling
              drops a row every {SHOTS_PER_DROP} shots or every {CEILING_SECONDS}{" "}
              seconds, whichever comes first — if the cluster reaches the line,
              the run is over.
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
                    ? "VIP: reward run available for Raven Bubbles today."
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

          {startingRun && (
            <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-sm rounded border border-white/30 bg-slate-900 p-6 space-y-3 text-white text-center">
                <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-white" />
                <h3 className="text-lg font-bold">Starting your run…</h3>
                <p className="text-sm text-slate-300">
                  Opening a reward run on the server and dealing today&apos;s
                  bubbles. Hold tight — this only takes a moment.
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

          {showPracticeDifficultyPrompt && (
            <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-md rounded border border-white/30 bg-slate-900 p-4 space-y-4 text-white">
                <h3 className="text-lg font-bold">Select Practice Difficulty</h3>
                <p className="text-sm text-slate-200">
                  Reward runs still use today&apos;s difficulty (
                  {todaysDifficulty.label}).
                </p>
                <div className="space-y-2">
                  {RAVEN_BUBBLES_DIFFICULTIES.map((difficulty) => (
                    <button
                      key={difficulty.name}
                      onClick={() => {
                        setPracticeDifficultyName(difficulty.name);
                        startSession("practice", difficulty.name);
                      }}
                      className={`w-full px-4 py-3 rounded-lg font-bold text-sm transition-all ${
                        practiceDifficultyName === difficulty.name
                          ? "bg-green-500 text-white"
                          : "bg-slate-700 text-slate-200 hover:bg-slate-600"
                      }`}
                    >
                      {difficulty.label} — {difficulty.targetScore} points
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setShowPracticeDifficultyPrompt(false)}
                  className="w-full px-4 py-2 rounded-lg font-semibold text-sm bg-gray-500 text-white hover:bg-gray-400"
                >
                  CANCEL
                </button>
              </div>
            </div>
          )}
        </div>
      </OuterPanel>
    );
  }

  // ── Run ────────────────────────────────────────────────────────────────────

  return (
    <OuterPanel className="mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden">
      <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-4">
            <div>
              <div className="text-xs font-semibold text-gray-600">SCORE</div>
              <div className="text-2xl font-bold text-amber-800">
                {runtime.score}
              </div>
            </div>
            <div>
              <div className="text-xs font-semibold text-gray-600">TARGET</div>
              <div className="text-2xl font-bold text-amber-800">
                {runtime.difficulty.targetScore}
              </div>
            </div>
          </div>

          <div className="text-center">
            <div className="text-xs font-semibold text-gray-600">
              CEILING DROPS IN
            </div>
            <div className="flex items-center justify-center gap-3">
              <div className="flex gap-1">
                {Array.from({ length: SHOTS_PER_DROP }, (_, index) => (
                  <div
                    key={index}
                    className={`h-3 w-3 rounded-full border border-black/30 ${
                      index < runtime.shotsLeft ? "bg-red-500" : "bg-gray-300"
                    }`}
                  />
                ))}
              </div>
              {/* The second trigger on the same drop: firing is not the only
                  way the clock runs out, so dawdling is not a strategy. */}
              <div
                className={`text-sm font-bold tabular-nums ${
                  ceilingSeconds <= 5 ? "text-red-600" : "text-amber-800"
                }`}
              >
                {ceilingSeconds}s
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-center">
              <div className="text-xs font-semibold text-gray-600">NEXT</div>
              <Bubble color={runtime.next} size={30} />
            </div>
            {mode === "practice" && status !== "won" && status !== "lost" && (
              <Button onClick={() => startSession("practice")}>
                Restart Practice
              </Button>
            )}
            {status !== "won" && status !== "lost" && onClose && (
              <button
                onClick={() => setShowExitConfirm(true)}
                className="px-3 py-1 text-xs bg-gray-700 text-slate-300 rounded hover:bg-gray-600"
              >
                QUIT RUN
              </button>
            )}
          </div>
        </div>

        {/* `FitStage` scales the board to fit and measures the space it shares
            the screen with, rather than guessing a reserve. */}
        <FitStage
          width={PLAYFIELD_WIDTH}
          height={PLAYFIELD_HEIGHT}
          minScale={0.5}
          onScale={setScale}
        >
          <div
            ref={playfieldRef}
            onPointerMove={handlePointerMove}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerUp}
            className="relative h-full w-full overflow-hidden rounded border-2 border-amber-900/40 bg-slate-900/90"
          >
          {/* The ceiling: a solid slab the shot bounces off. It moves down with
              the board, and nothing can come to rest behind it. */}
          <div
            className="absolute left-0 right-0 bg-slate-700 border-b-4 border-amber-400/80"
            style={{
              top: ceilingLimitY(runtime.ceilingRow) - CEILING_THICKNESS,
              height: CEILING_THICKNESS,
            }}
          />

          {/* The line the cluster must not reach. */}
          <div
            className="absolute left-0 right-0 border-t-2 border-dashed border-red-500/80"
            style={{ top: DANGER_LINE_Y }}
          />

          {runtime.grid.map((row, rowIndex) =>
            row.map((cell, colIndex) =>
              cell ? (
                <div
                  key={`${rowIndex}-${colIndex}`}
                  className="absolute"
                  style={{
                    left: cellX(rowIndex, colIndex, runtime.ceilingRow) - RADIUS,
                    top: cellY(rowIndex) - RADIUS,
                  }}
                >
                  <Bubble color={cell} />
                </div>
              ) : null,
            ),
          )}

          {aimDots.map((dot, index) => (
            <div
              key={index}
              className="absolute rounded-full bg-white/50"
              style={{
                left: dot.x - 2,
                top: dot.y - 2,
                width: 4,
                height: 4,
              }}
            />
          ))}

          {runtime.shot && (
            <div
              className="absolute"
              style={{
                left: runtime.shot.x - RADIUS,
                top: runtime.shot.y - RADIUS,
              }}
            >
              <Bubble color={runtime.shot.color} />
            </div>
          )}

          {/* Shooter. */}
          <div
            className="absolute"
            style={{
              left: SHOOTER_X - RADIUS,
              top: SHOOTER_Y - RADIUS,
            }}
          >
            <Bubble color={runtime.current} />
          </div>
          <div
            className="absolute bg-amber-200/80"
            style={{
              left: SHOOTER_X - 2,
              top: SHOOTER_Y - RADIUS - 26,
              width: 4,
              height: 26,
              transformOrigin: "50% 100%",
              transform: `rotate(${aim}rad)`,
            }}
          />

          {(status === "won" || status === "lost") && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70 p-4">
              <div
                className={`w-full max-w-sm rounded border-2 p-4 text-center ${
                  status === "won"
                    ? "border-green-400 bg-green-900/50"
                    : "border-red-400 bg-red-900/40"
                }`}
              >
                <div className="font-bold text-xl text-white">
                  {status === "won" ? "Screens Cleared!" : "Bubbles Crossed the Line"}
                </div>
                <div className="mt-1 text-sm text-slate-200">
                  {runtime.reason} {runtime.score} of{" "}
                  {runtime.difficulty.targetScore} points.
                  {status === "won" && mode === "reward"
                    ? ` Reward granted: ${RAVEN_BUBBLES_RAVEN_COIN_REWARD} RavenCoin.`
                    : ""}
                </div>
                <div className="mt-3 flex flex-col gap-2">
                  {mode === "practice" && (
                    <Button onClick={() => startSession("practice")}>
                      Play Again
                    </Button>
                  )}
                  {onClose && (
                    <Button onClick={returnToMenu}>Back to Arcade</Button>
                  )}
                </div>
              </div>
            </div>
          )}
          </div>
        </FitStage>

        <p className="text-center text-xs text-gray-600">
          {isTouchDevice
            ? "Drag to aim, lift to shoot. Arrows and Space work too."
            : "Move to aim, click to shoot. Arrows and Space work too."}
        </p>
      </div>

      {showExitConfirm && status !== "won" && status !== "lost" && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-sm bg-slate-900 rounded border border-white/30 p-5 text-white space-y-4">
            <div className="font-bold text-lg">Quit the run?</div>
            <div className="text-sm text-slate-300">
              {mode === "reward"
                ? "Quitting will submit your current score and count the run as used."
                : "Your progress will be lost."}
            </div>
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
    </OuterPanel>
  );
};
