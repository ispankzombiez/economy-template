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
import { SUNNYSIDE } from "example-assets/sunnyside";
import { ITEM_DETAILS } from "../adapters/itemDetails";
import spaceInvaderMap from "../../assets/space-invader-map.json";
import arcadeTilesheet from "../../assets/nightshade-arcade-tilesheet.png";
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
import {
  writeNonce,
  getEconomyWorkerUrl,
  postEconomyWrite,
} from "lib/portal/api";
import { CHUNK_TICKS } from "@nightshade/shared/anticheat/replayBudget";
import { encodeInputLog } from "@nightshade/shared/anticheat/inputLog";
import {
  getGoblinInvadersDifficulty,
  isGoblinInvadersRewardRunAvailable,
  GOBLIN_INVADERS_DIFFICULTIES,
  GOBLIN_INVADERS_RAVEN_COIN_REWARD,
  GoblinInvadersDifficulty,
  GoblinInvadersDifficultyName,
  GoblinInvadersMode,
} from "./session";
import {
  ARENA_HEIGHT,
  ARENA_WIDTH,
  ENEMY_HEIGHT,
  ENEMY_WIDTH,
  FIXED_STEP_MS,
  MYSTERY_SHIP_HEIGHT,
  MYSTERY_SHIP_WIDTH,
  MYSTERY_SHIP_Y,
  PLAYER_SIZE,
  PLAYER_Y,
  SHIELD_CELL_SIZE,
  createRuntime,
  encodeTick,
  tick,
  type GoblinInvadersRuntime,
} from "./engine";

const _portalState = (state: PortalMachineState) => state.context.state;

/**
 * How big the bumpkin is *drawn*, in pixels of visible character height.
 *
 * `PLAYER_SIZE` is the collision box, not the sprite. The animation sheet is
 * 96x64 with the character occupying only 13x18 of it, so sizing the sprite by
 * its box drew the bumpkin at a fraction of that box and it read as much
 * smaller than the character you walk around as on the arcade floor.
 * `NPCIcon` now crops to the character and scales that, so this number is the
 * height actually seen.
 *
 * Tied to `ENEMY_HEIGHT` on purpose: the player should read as the same size as
 * the goblins it is shooting at, and a hand-typed number here drifts out of step
 * with the invader sprite the moment either changes. The sprite stays
 * bottom-aligned to the 42px collision box, so none of the invaders, shots or
 * hitboxes are affected.
 */
const PLAYER_RENDER_HEIGHT = ENEMY_HEIGHT;

const PLAYER_BLINK_INTERVAL_MS = 120;

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

const panelClassName =
  "mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden";

const INTERCEPTED_CODES = new Set([
  "ArrowLeft",
  "ArrowRight",
  "KeyA",
  "KeyD",
  "Space",
]);

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

export const GoblinInvadersGame: React.FC<{ onClose?: () => void }> = ({
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });
  const bootstrap = useBootstrap();

  const hasRewardRun = useMemo(
    () => isGoblinInvadersRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const todaysDifficulty = useMemo(() => getGoblinInvadersDifficulty(), []);

  const isTouchDevice = useIsTouchDevice();

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
  /** A Space press latched until the next keyboard step consumes it. */
  const firePendingRef = useRef(false);
  /** The last touch scrub ratio, consumed by the next step that can carry it. */
  const scrubPendingRef = useRef<number | null>(null);

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
  const gameRef = useRef<GoblinInvadersRuntime | null>(null);

  /** One byte per 16ms step: the input the step was taken *under*. */
  const inputLogRef = useRef<number[]>([]);

  /** Real time not yet spent on whole `FIXED_STEP_MS` steps. */
  const accumulatorRef = useRef(0);

  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  /** When the current run opened — the claim's `elapsedMs`. */
  const runStartedAtRef = useRef<number>(0);

  /** The run's difficulty, readable from inside the loop effect. */
  const activeDifficultyRef = useRef<GoblinInvadersDifficulty>(todaysDifficulty);

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

  const playerParts =
    portalGameState.bumpkin?.equipped ?? NPC_WEARABLES["pumpkin' pete"];

  /** Centering box for the portrait, whose own width is measured at runtime. */
  const portrait = useMemo(() => bumpkinPortraitBox(PLAYER_RENDER_HEIGHT), []);

  const returnToMenu = useCallback(() => {
    pressedKeysRef.current.clear();
    firePendingRef.current = false;
    scrubPendingRef.current = null;
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
      nextMode: GoblinInvadersMode,
      practiceDifficultyOverride?: GoblinInvadersDifficultyName,
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
        GOBLIN_INVADERS_DIFFICULTIES.find(
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
      firePendingRef.current = false;
      scrubPendingRef.current = null;
      const fresh = createRuntime(difficulty, seed);
      gameRef.current = fresh;
      setRuntime({ ...fresh });

      setActiveDifficulty(difficulty);
      setMode(nextMode);
      setShowPracticeDifficultyPrompt(false);
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
          name: "goblin-invaders" as any,
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
    minigame: "goblin-invaders",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  // The touch bar's fire button stands in for `Space`. The keyboard is the one
  // place that already knows how to shoot — it owns the one-shot-in-flight rule
  // and the respawn pause, so the button dispatches the same `keydown`/`keyup`
  // pair the key itself sends and the handler above latches it. No second fire
  // path, and therefore nothing to keep in step with the first.
  const shootFromTouch = useCallback(() => {
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

  // `TouchMoveBar` reports where the finger sits across the strip as an
  // absolute 0..1 ratio, latched for the next step to consume — a scrub byte,
  // not a runtime write, so the ratio the step moves under is exactly the one
  // the log records (see `encodeTick`).
  const scrubPlayer = useCallback((ratio: number) => {
    scrubPendingRef.current = Math.max(0, Math.min(1, ratio));
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

      pressedKeysRef.current.add(event.code);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      // Latched rather than fired here: the step consumes it, so a press lands
      // on exactly one step's byte — and a `Space` pair dispatched by the touch
      // FIRE button (both events synchronous, possibly between two steps) is
      // still caught, which a pure per-step poll of the key would miss.
      if (event.code === "Space") {
        firePendingRef.current = true;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!INTERCEPTED_CODES.has(event.code)) return;

      pressedKeysRef.current.delete(event.code);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      pressedKeysRef.current.clear();
      firePendingRef.current = false;
      scrubPendingRef.current = null;
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
        cabinet: "goblin-invaders",
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
        // Sampling afterwards would round a press and a step apart.
        const scrub = scrubPendingRef.current;
        scrubPendingRef.current = null;
        // A scrub byte cannot carry the fire bit (bit 7 owns the byte), so a
        // fire pending behind a dragging finger rides the next keyboard byte —
        // the pending flag is only consumed when it goes out.
        const fire = scrub === null && firePendingRef.current;
        if (fire) firePendingRef.current = false;

        const keys = pressedKeysRef.current;
        const movingLeft = keys.has("ArrowLeft") || keys.has("KeyA");
        const movingRight = keys.has("ArrowRight") || keys.has("KeyD");
        const input = {
          dir: ((movingRight ? 1 : 0) - (movingLeft ? 1 : 0)) as -1 | 0 | 1,
          fire,
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
      console.error("[goblin-invaders] win with no frozen claim");
      return;
    }
    rewardGrantedRef.current = true;

    // The leaderboard score is written for every settled run — a loss still
    // played, and the board is the record of it.
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
        amount: GOBLIN_INVADERS_RAVEN_COIN_REWARD,
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
              {/* Touch players never see the keyboard, so naming it here would
                  describe controls they cannot reach. */}
              {isTouchDevice
                ? "Controls: drag the bar to move, tap FIRE to shoot."
                : "Controls: A/D or Arrow keys to move, Space to fire."}
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
                    ? "VIP: reward run available for Goblin Invaders today."
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
                  Opening a reward run on the server and seeding today&apos;s
                  invaders. Hold tight — this only takes a moment.
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
    <OuterPanel className={panelClassName}>
      <InnerPanel className="w-full h-full p-3 md:p-4 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white overflow-auto">
        <div className="max-w-6xl mx-auto h-full flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <div className="font-bold text-lg">
              GOBLIN INVADERS - {activeDifficulty.label}
            </div>
            <div className="flex flex-wrap gap-2 items-center">
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

          {/* Arena */}
          {/* `FitStage` scales the arena down to whatever is actually left for
              it, and measures the chrome it shares the screen with rather than
              assuming a size: the arena is 760px wide, so on a phone it was
              being laid out at full size inside a phone-width popup and clipped
              by it. Invaders, shields, shots and the ship are all positioned in
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
                  // Centred on the collision box and bottom-aligned so the bumpkin
                  // sits on the same line. The box is `bumpkinPortraitBox(...)`
                  // wide so the canvas - whose width is measured from the sheet -
                  // can be centred inside it.
                  width: `${portrait.width}px`,
                  height: `${PLAYER_RENDER_HEIGHT}px`,
                  left: `${runtime.playerX + PLAYER_SIZE / 2 - portrait.width / 2}px`,
                  top: `${PLAYER_Y + PLAYER_SIZE - PLAYER_RENDER_HEIGHT}px`,
                }}
              >
                {isPlayerVisible && (
                  <NPCIcon
                    parts={playerParts}
                    height={PLAYER_RENDER_HEIGHT}
                    facing={runtime.playerFacing}
                  />
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
          </FitStage>

          {/* Touch controls */}
          {/* Goblin Invaders was keyboard-only, which made the cabinet
              unplayable on a phone. `TouchMoveBar` is deliberately not a second
              input path: its fire button sends the `Space` pair the keyboard
              already handles, and its scrub is latched into the next step's
              byte, so the ship behaves identically whichever one drives it.
              It is a *sibling* of the stage rather than a child of it, which is
              the point: `FitStage` sums the height of the board's siblings, so
              the bar's height is already being held back from the arena and
              adding a `reserve` for it as well would count it twice.
              `shrink-0` keeps the flex column from squashing it. Gated on
              `(pointer: coarse)` so a desktop player keeps the keyboard, and on
              `!gameOver` so the bar is not sitting under a finished run. */}
          {isTouchDevice && !runtime.gameOver && (
            /* `sticky bottom-0`: on a short phone the panel scrolls, and a
               control bar that scrolls off the bottom is a control bar the
               player cannot reach. */
            <div className="sticky bottom-0 z-10 shrink-0 bg-slate-950/95 py-1">
              <TouchMoveBar
                onScrub={scrubPlayer}
                onFire={shootFromTouch}
                fireLabel="FIRE"
              />
            </div>
          )}

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
            {runtime.gameOver && (
              <Button onClick={returnToMenu}>MENU</Button>
            )}
            {runtime.gameOver && onClose && (
              <Button onClick={() => onClose()}>Exit</Button>
            )}
            {!runtime.gameOver && (
              <button
                onClick={() => setShowExitConfirm(true)}
                className="px-3 py-1 text-xs bg-gray-700 text-slate-300 rounded hover:bg-gray-600"
              >
                QUIT RUN
              </button>
            )}
          </div>

          <div className="text-xs text-slate-300">
            {isTouchDevice
              ? "Drag the bar to move, tap FIRE to shoot."
              : "Move with A/D or Arrow keys. Press Space to shoot."}{" "}
            Enemy speed and fire rate increase as waves progress. Use shields
            for cover and shoot the mystery ship for bonus points.
          </div>

          {showExitConfirm && !runtime.gameOver && (
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
        </div>
      </InnerPanel>
    </OuterPanel>
  );
};
