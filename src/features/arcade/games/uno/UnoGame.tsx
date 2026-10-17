/* eslint-disable react/jsx-no-literals, react/no-unescaped-entities */
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
import { SquareIcon } from "components/ui/SquareIcon";
import { ITEM_DETAILS } from "../adapters/itemDetails";
import { startAttempt, submitScore } from "../adapters/portalUtil";
import { useRewardRun } from "../adapters/rewardRun";
import { useBootstrap } from "lib/portal/BootstrapContext";
import { postEconomyWrite } from "lib/portal/api";
import { useVipAccess } from "../adapters/useVipAccess";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import { UnoCard, UnoColor, UnoFace, UnoWinner } from "./types";
import {
  UNO_RAVEN_COIN_REWARD,
  UnoMode,
  isUnoRewardRunAvailable,
} from "./session";
// The rules live in engine.ts — the same module the worker's replay imports —
// so this file holds the cabinet and the proof and nothing about how Uno is
// played. Deal, bot policy, card effects and legality all come from there.
import {
  NON_WILD_COLORS,
  PLAYER_NAMES,
  canPlay,
  createInitialState,
  playerDraw,
  playerPlayCard,
  runBotTurn,
  type UnoState,
} from "./engine";
import {
  MAX_UNO_ACTIONS,
  encodeUnoActionLog,
  encodeUnoLog,
  type UnoAction,
} from "@nightshade/shared/anticheat/unoLog";
import type { VerifiedRun } from "lib/portal/api";

// ─── Panel size ──────────────────────────────────────────────────────────────

const unoPanelClassName =
  "mx-auto w-full max-w-[1100px] h-[min(92vh,860px)] overflow-hidden";

// ─── Suit image map (matches existing games) ─────────────────────────────────

const suitImages: Record<string, string> = {
  Kale: ITEM_DETAILS.Kale.image,
  Barley: ITEM_DETAILS.Barley.image,
  Wheat: ITEM_DETAILS.Wheat.image,
  Radish: ITEM_DETAILS.Radish.image,
};

// ─── Colour palette for Uno card backgrounds ─────────────────────────────────

const colorBg: Record<UnoColor, string> = {
  Kale: "bg-green-600",
  Barley: "bg-orange-500",
  Wheat: "bg-yellow-200",
  Radish: "bg-red-500",
  Wild: "bg-gradient-to-br from-purple-600 to-pink-500",
};

const colorBorder: Record<UnoColor, string> = {
  Kale: "border-green-300",
  Barley: "border-orange-300",
  Wheat: "border-yellow-100",
  Radish: "border-red-300",
  Wild: "border-purple-300",
};

const colorText: Record<UnoColor, string> = {
  Kale: "text-white",
  Barley: "text-white",
  Wheat: "text-gray-800",
  Radish: "text-white",
  Wild: "text-white",
};

/**
 * The centre marks of the Reverse and Skip cards, drawn instead of spelled.
 *
 * Neither word ever fit the middle of a card — "Reverse" is nine characters in
 * a panel two inches wide — and both are marks every UNO player reads before
 * they read anything else:
 *
 *  - **Reverse** — the pair of arrows pointing past each other along one
 *    diagonal: one out to the upper right, one back to the lower left, their
 *    shafts hooking around the middle so each sits behind the other.
 *  - **Skip** — the ring with a slash through it.
 *
 * They are inline SVG rather than art assets for three reasons: they scale to
 * both card sizes, they take the card's own colour, and a mark this simple is
 * better drawn than shipped as a bitmap. `currentColor` is the fill, with a
 * black outline over it so the two arrows stay separate where they cross —
 * exactly how the mark is printed.
 */
const ReverseSymbol: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden="true">
    <g fill="currentColor" stroke="#000" strokeWidth={2} strokeLinejoin="round">
      <polygon points="29.5,20.7 31.2,23.1 31.8,25.4 31.8,28.7 31.1,31.1 28.0,35.0 20.5,40.9 24.3,45.9 7.2,45.9 9.8,29.6 10.2,29.3 14.4,33.2 29.4,20.8" />
      <polygon points="23.9,2.0 40.9,2.2 38.2,18.7 33.7,14.7 18.7,27.3 18.3,27.1 16.3,22.6 16.3,19.3 17.0,16.9 19.4,13.5 27.6,7.0 23.8,2.1" />
    </g>
  </svg>
);

const SkipSymbol: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 48 48" className={className} fill="none" aria-hidden="true">
    {/* The ring: one path stroked twice — a black edge, then the card's own
        colour over it, which leaves black showing on both sides of the band. */}
    <ellipse cx={24} cy={24} rx={17} ry={14} stroke="#000" strokeWidth={7.5} />
    <ellipse cx={24} cy={24} rx={17} ry={14} stroke="currentColor" strokeWidth={4} />
    {/* The slash, outlined the same way. Its ends stop inside the ring so the
        bar reads as crossing the middle rather than poking out of it. */}
    <line
      x1={13.6}
      y1={31.8}
      x2={34.4}
      y2={16.2}
      stroke="#000"
      strokeWidth={9}
      strokeLinecap="round"
    />
    <line
      x1={13.6}
      y1={31.8}
      x2={34.4}
      y2={16.2}
      stroke="currentColor"
      strokeWidth={5}
      strokeLinecap="round"
    />
  </svg>
);

// ─── Helpers ─────────────────────────────────────────────────────────────────

const UNO_COLOR_ORDER: Record<UnoColor, number> = {
  Kale: 0,
  Barley: 1,
  Wheat: 2,
  Radish: 3,
  Wild: 4,
};

const UNO_FACE_ORDER: Record<UnoFace, number> = {
  "0": 0,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  Skip: 10,
  Reverse: 11,
  DrawTwo: 12,
  Wild: 13,
  WildDrawFour: 14,
};

// ─── Selector ────────────────────────────────────────────────────────────────

const _portalState = (state: PortalMachineState) => state.context.state;

// ─── Props ───────────────────────────────────────────────────────────────────

interface UnoGameProps {
  onClose?: () => void;
}

// ─── Component ───────────────────────────────────────────────────────────────

export const UnoGame: React.FC<UnoGameProps> = ({ onClose }) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState, type: "full" });
  const bootstrap = useBootstrap();

  const [sessionMode, setSessionMode] = useState<UnoMode | null>(null);
  const [gameState, setGameState] = useState<UnoState | null>(null);
  const [rewardRunStarted, setRewardRunStarted] = useState(false);
  const [rewardSubmitted, setRewardSubmitted] = useState(false);
  const [rewardGranted, setRewardGranted] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  // True from the moment a reward run is confirmed until its deal exists.
  // Opening a paid run waits on a server round-trip (burn the ticket, then
  // read back the issued seed) — so without this the lobby just sits looking
  // frozen, and "START REWARD RUN" stays live underneath, where a second
  // click would burn a *second* run.
  const [startingRun, setStartingRun] = useState(false);
  // True when a reward run could not read the seed the server issued for it.
  // The deal is never built from a local substitute: the claim only mints
  // against the issued seed, so playing on would be a win that pays nothing.
  const [seedError, setSeedError] = useState(false);
  // When player plays a Wild, we pause to let them pick a colour
  const [pendingWildCard, setPendingWildCard] = useState<UnoCard | null>(null);
  // Bot turn loop running flag
  const botTurnActiveRef = useRef(false);

  /**
   * The run's proof, captured as it happens rather than reconstructed after.
   *
   * `moveLogRef` holds every choice the engine actually applied (a play or
   * draw the engine refuses logs nothing — the component only appends when
   * the state changed), `runSeedRef` the seed the deck was shuffled from, and
   * `runStartedAtRef` when the session opened. The claim is built from these
   * the moment the game ends.
   */
  const moveLogRef = useRef<UnoAction[]>([]);
  const runSeedRef = useRef<number | null>(null);
  const runStartedAtRef = useRef(0);

  const hasRewardRun = useMemo(
    () => isUnoRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  /**
   * Read the shuffle seed the server issued for the run that is open.
   *
   * Returns null on any error — a reward run then stops and reports it rather
   * than ever dealing from a seed the server did not issue. Retries until the
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
          const payload = res.data as { seed?: number; runKey?: number } | undefined;
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

  /** A local seed for practice runs, which are never verified. */
  const getPracticeSeed = useCallback(() => {
    return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  }, []);

  const returnToMenu = useCallback(() => {
    setShowQuitConfirm(false);
    setSessionMode(null);
    setGameState(null);
    setPendingWildCard(null);
    setStartingRun(false);
    setSeedError(false);
    botTurnActiveRef.current = false;
    moveLogRef.current = [];
    runSeedRef.current = null;
  }, []);

  // ─── Session start ────────────────────────────────────────────────────────

  const startSession = useCallback(
    async (mode: UnoMode) => {
      // From here a paid run is already being opened on the server (the confirm
      // handler burned the ticket / spent the allowance before calling in), so
      // flip the loading card immediately — before the seed round-trip below —
      // so the lobby never sits frozen while we wait. Cleared once the deal
      // exists and the mode flips.
      if (mode === "reward") setStartingRun(true);
      setSeedError(false);

      // Reward run: the shuffle seed is issued by the server at run-open and
      // read back here — no local substitute, because the claim only mints
      // against the issued seed. A failed read stops the run and says so.
      // Practice: a local seed, because it is never verified.
      //
      // The seed the deck is actually dealt from. Uno has no difficulty walk,
      // so this seed *is* the run's — issued by the server so a caller cannot
      // shop a shuffle. Everything after the shuffle (bot colour picks,
      // refills) draws from the same stream, so the worker rebuilds this
      // exact game from the seed plus the player's choices.
      let seed: number;
      if (mode === "reward") {
        const issued = await fetchRunSeed(bootstrap?.jwt);
        if (issued === null) {
          setStartingRun(false);
          setSeedError(true);
          return;
        }
        seed = issued;
      } else {
        seed = getPracticeSeed();
      }

      setSessionMode(mode);
      runSeedRef.current = seed;
      runStartedAtRef.current = Date.now();
      moveLogRef.current = [];
      setGameState(createInitialState(seed));
      setRewardSubmitted(false);
      setRewardGranted(false);
      setPendingWildCard(null);
      botTurnActiveRef.current = false;

      if (mode === "reward" && !rewardRunStarted) {
        portalService.send({ type: "arcadeMinigame.started", name: "uno" });
        startAttempt();
        setRewardRunStarted(true);
      }

      // Clear the flag after the mode has flipped: the lobby only renders while
      // `sessionMode` is null, so once it flips the loading card is gone
      // regardless — but a later return-to-menu must not inherit a stale
      // "starting" state.
      setStartingRun(false);
    },
    [bootstrap, fetchRunSeed, getPracticeSeed, portalService, rewardRunStarted],
  );

  /**
   * Settle the reward run the moment the game ends — win or loss.
   *
   * This fires in the same render the game reached `gameOver`, following Go
   * Fish's `completeRewardIfNeeded`: the log cannot grow past the end of the
   * game (the engine refuses every play and draw once it is over), so the
   * proof carried here is the whole game and nothing after it. Calling
   * settlement from the EXIT button instead left a player who won and then
   * closed the cabinet through the arcade chrome unclaimed entirely.
   *
   * The claim carries the seed and the full choice log; the worker rebuilds
   * the deal, re-applies the choices — re-simulating the three bots in
   * between from the same seed — and mints only if *its* game ends with the
   * player's hand empty. The coin is paid on proof, not assertion.
   */
  const completeRewardIfNeeded = useCallback(() => {
    if (!gameState || !gameState.gameOver || sessionMode !== "reward") {
      return;
    }

    if (!rewardSubmitted) {
      submitScore({ score: gameState.winner === "player" ? 1 : 0 });
      setRewardSubmitted(true);
    }

    if (gameState.winner !== "player" || rewardGranted) {
      return;
    }

    // A log past the codec's ceiling could not be encoded, hence not
    // verified, hence not paid — sending it would burn the reward run for a
    // claim the worker must refuse. Unreachable in honest play (a game is a
    // few dozen choices; the ceiling is 600); guarded because the failure
    // mode is a silently-unpayable reward run, not a crash.
    if (moveLogRef.current.length > MAX_UNO_ACTIONS) {
      console.error("[uno] action log exceeded the replay ceiling");
      return;
    }

    const verify: VerifiedRun = {
      cabinet: "uno",
      score: 1,
      // Turn-based, so there are no wave checkpoints or pace floor to sample:
      // the choice log below is the verification — full coverage of the game
      // rather than sampled moments of it. No difficulty either: this cabinet
      // has no daily difficulty to re-derive, so the replay names only the
      // seed and the choices.
      checkpoints: [],
      elapsedMs: Date.now() - runStartedAtRef.current,
      replay: {
        seed: runSeedRef.current ?? 0,
        actions: encodeUnoLog(encodeUnoActionLog(moveLogRef.current)),
      },
    };

    portalService.send({
      type: "arcadeMinigame.ravenCoinWon",
      amount: UNO_RAVEN_COIN_REWARD,
      verify,
    });
    setRewardGranted(true);
  }, [gameState, sessionMode, rewardSubmitted, rewardGranted, portalService]);

  // Free run first, then 1 burned Play Ticket per attempt — with the "are you
  // sure?" box in between. `isUnoRewardRunAvailable` is kept as the availability
  // check so the button and the store can never disagree.
  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "uno",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  // ─── Bot turn loop (single bot step) ─────────────────────────────────────

  useEffect(() => {
    if (!gameState || gameState.gameOver || gameState.currentPlayer === 0) {
      return;
    }

    if (botTurnActiveRef.current) return;
    botTurnActiveRef.current = true;

    const timeout = setTimeout(() => {
      setGameState((prev) => {
        if (!prev || prev.gameOver || prev.currentPlayer === 0) {
          botTurnActiveRef.current = false;
          return prev;
        }

        const next = runBotTurn(prev);
        botTurnActiveRef.current = false;
        return next;
      });
    }, 700);

    return () => clearTimeout(timeout);
  }, [gameState]);

  // ─── Player: the two doors a choice goes through ─────────────────────────

  /**
   * Draw one card (voluntarily, or take a pending penalty).
   *
   * Two jobs, in the order they matter: ask the engine, and only then record
   * the choice. An engine that returns its input unchanged is a draw that
   * cannot happen — not the player's turn, game over, nothing left to draw —
   * and the update stops there, so the log contains exactly the draws that
   * happened. The worker treats a no-op entry as a dead action at its index.
   */
  const handlePlayerDraw = useCallback(() => {
    if (!gameState || gameState.currentPlayer !== 0 || gameState.gameOver) {
      return;
    }

    const next = playerDraw(gameState);
    if (next === gameState) {
      return;
    }

    moveLogRef.current.push({ kind: "draw" });
    setGameState(next);
  }, [gameState]);

  /** Play a card from the player's hand (a Wild pauses for its colour). */
  const handlePlayerPlay = useCallback(
    (card: UnoCard) => {
      if (!gameState || gameState.currentPlayer !== 0 || gameState.gameOver)
        return;

      // The position in the *engine's* hand order — the action log records
      // this, never the sorted display order and never a card id, so the
      // worker can resolve the same card out of the state it rebuilds.
      const index = gameState.hands[0].findIndex((c) => c.id === card.id);
      if (index < 0) return;

      const topCard = gameState.discard[gameState.discard.length - 1];

      // Pending draw — must counter or take penalty
      if (gameState.pendingDrawCount > 0) {
        const canCounter =
          (topCard.face === "DrawTwo" && card.face === "DrawTwo") ||
          (topCard.face === "WildDrawFour" && card.face === "WildDrawFour");

        if (!canCounter) return;
      } else if (!canPlay(card, topCard, gameState.currentColor)) {
        return;
      }

      if (card.color === "Wild") {
        setPendingWildCard(card);
        return;
      }

      const next = playerPlayCard(gameState, index);
      if (next === gameState) return;

      moveLogRef.current.push({ kind: "play", index });
      setGameState(next);
    },
    [gameState],
  );

  /** Commit the paused Wild play once the player has named a colour. */
  const handleWildColorChosen = useCallback(
    (color: Exclude<UnoColor, "Wild">) => {
      if (!pendingWildCard || !gameState) return;

      setPendingWildCard(null);

      // Nothing can have changed the hand while the picker was up — it is
      // the player's turn and the overlay covers the board — but resolve the
      // index again rather than assuming it.
      const index = gameState.hands[0].findIndex(
        (c) => c.id === pendingWildCard.id,
      );
      if (index < 0) return;

      const next = playerPlayCard(gameState, index, color);
      if (next === gameState) return;

      moveLogRef.current.push({
        kind: "play",
        index,
        color: NON_WILD_COLORS.indexOf(color),
      });
      setGameState(next);
    },
    [pendingWildCard, gameState],
  );

  // ─── Practice: play again ────────────────────────────────────────────────

  const handlePlayAgain = useCallback(() => {
    if (sessionMode !== "practice") return;

    const seed = getPracticeSeed();
    runSeedRef.current = seed;
    runStartedAtRef.current = Date.now();
    moveLogRef.current = [];
    setGameState(createInitialState(seed));
    setPendingWildCard(null);
    setRewardSubmitted(false);
    setRewardGranted(false);
    botTurnActiveRef.current = false;
  }, [getPracticeSeed, sessionMode]);

  const sortedPlayerHand = useMemo(() => {
    const hand = gameState?.hands[0] ?? [];

    return [...hand].sort((a, b) => {
      const byColor = UNO_COLOR_ORDER[a.color] - UNO_COLOR_ORDER[b.color];

      if (byColor !== 0) {
        return byColor;
      }

      const byFace = UNO_FACE_ORDER[a.face] - UNO_FACE_ORDER[b.face];

      if (byFace !== 0) {
        return byFace;
      }

      return a.id.localeCompare(b.id);
    });
  }, [gameState]);

  // ─── Render helpers ───────────────────────────────────────────────────────

  const renderCard = (
    card: UnoCard,
    opts: {
      faceDown?: boolean;
      small?: boolean;
      onClick?: () => void;
      disabled?: boolean;
      highlight?: boolean;
    } = {},
  ) => {
    const { faceDown, small, onClick, disabled, highlight } = opts;
    const w = small ? "w-10 h-14" : "w-14 h-20";
    const centerFaceClass = small ? "text-base" : "text-2xl";
    const cornerIconWidth = small ? 6 : 8;
    const cornerBonusClass = small ? "text-[9px]" : "text-xs";

    const isDrawTwo = card.face === "DrawTwo";
    const isWildDrawFour = card.face === "WildDrawFour";
    const cornerBonus = isDrawTwo ? "+2" : isWildDrawFour ? "+4" : null;
    const centerLabel = isWildDrawFour ? "Wild" : isDrawTwo ? "+2" : card.face;

    if (faceDown) {
      return (
        <div
          key={card.id}
          className={`${w} border border-white/30 rounded bg-slate-700 grid place-items-center ${small ? "text-xs" : "text-sm"}`}
        >
          ?
        </div>
      );
    }

    return (
      <button
        type="button"
        key={card.id}
        onClick={onClick}
        disabled={disabled}
        className={`${w} border-2 ${colorBorder[card.color]} ${colorBg[card.color]} ${colorText[card.color]} rounded p-1 relative transition-transform ${
          onClick && !disabled
            ? "hover:-translate-y-2 cursor-pointer"
            : "cursor-default"
        } ${highlight ? "ring-2 ring-yellow-400" : ""} ${disabled ? "opacity-50" : ""}`}
      >
        {card.color !== "Wild" && !cornerBonus && (
          <div className="absolute top-1 left-1">
            <SquareIcon icon={suitImages[card.color]} width={cornerIconWidth} />
          </div>
        )}
        {card.color !== "Wild" && !cornerBonus && (
          <div className="absolute bottom-1 right-1 rotate-180">
            <SquareIcon icon={suitImages[card.color]} width={cornerIconWidth} />
          </div>
        )}
        {cornerBonus && (
          <span
            className={`absolute top-1 left-1 font-bold ${cornerBonusClass} leading-none`}
          >
            {cornerBonus}
          </span>
        )}
        {cornerBonus && (
          <span
            className={`absolute bottom-1 right-1 rotate-180 font-bold ${cornerBonusClass} leading-none`}
          >
            {cornerBonus}
          </span>
        )}
        <span
          className={`absolute inset-0 grid place-items-center font-bold ${centerFaceClass} leading-none`}
        >
          {card.face === "Reverse" ? (
            <>
              <ReverseSymbol className={small ? "h-5 w-5" : "h-8 w-8"} />
              {/* The mark is decorative; the name still has to reach a
                  screen reader. */}
              <span className="sr-only">Reverse</span>
            </>
          ) : card.face === "Skip" ? (
            <>
              <SkipSymbol className={small ? "h-5 w-5" : "h-8 w-8"} />
              <span className="sr-only">Skip</span>
            </>
          ) : (
            centerLabel
          )}
        </span>
      </button>
    );
  };

  // ─── Lobby screen ─────────────────────────────────────────────────────────

  if (!gameState || !sessionMode) {
    return (
      <OuterPanel className={unoPanelClassName}>
        <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
          <div className="text-center space-y-2">
            <h2 className="text-4xl font-bold">UNO</h2>
            <p className="text-sm text-gray-600">
              Match the colour or face of the top card. First to empty their
              hand wins!
            </p>
          </div>

          <InnerPanel className="bg-yellow-100 p-4">
            <div className="grid grid-cols-2 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  REWARD
                </div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-yellow-700">
                  {UNO_RAVEN_COIN_REWARD}
                  <img
                    src={ravenCoinIcon}
                    alt="RavenCoin"
                    className="w-6 h-6"
                  />
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  PLAYERS
                </div>
                <div className="text-2xl font-bold text-yellow-700">
                  1 + 3 Bots
                </div>
              </div>
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
            <div>{startingRun ? "STARTING…" : "START REWARD RUN"}</div>
            <div className="mt-2 text-xs opacity-90">
              {!hasRewardRun
                ? "No reward runs left today — buy Play Tickets in the shop."
                : startingRun
                  ? "Opening a reward run on the server…"
                  : rewardRun.freeAvailable
                    ? isVip
                      ? "VIP: reward run available for Uno today."
                      : "Reward run available for the arcade today."
                    : `Uses 1 Play Ticket (you have ${rewardRun.tickets}).`}
            </div>
          </button>

          <button
            onClick={() => startSession("practice")}
            disabled={startingRun}
            className="w-full px-6 py-4 bg-blue-500 text-white font-bold rounded-lg hover:bg-blue-600 active:scale-95 transition-all shadow-lg text-lg disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            <div>START PRACTICE MODE</div>
            <div className="mt-2 text-xs font-semibold opacity-90">
              Play without spending today's reward attempt.
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
                  Opening a reward run on the server and dealing the cards.
                  Hold tight — this only takes a moment.
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
        </div>
      </OuterPanel>
    );
  }

  // Settle in the same render the game ends — the `completeRewardIfNeeded`
  // pattern shared by the verified cabinets. The log cannot grow past this
  // point (the engine refuses every choice once the game is over), so the
  // proof this builds is the complete game, nothing before or after it.
  if (gameState.gameOver) {
    completeRewardIfNeeded();
  }

  // ─── In-game screen ───────────────────────────────────────────────────────

  const topCard = gameState.discard[gameState.discard.length - 1];
  const playerHand = gameState.hands[0];
  const isPlayerTurn = gameState.currentPlayer === 0 && !gameState.gameOver;
  const deckRemaining = gameState.deck.length;

  return (
    <OuterPanel className={unoPanelClassName}>
      {/* `overflow-y-auto`, not `overflow-hidden`, and the hand row below is
          `flex-none` below `md`. Both were measured at a 358px viewport.

          `hidden` clipped the ~300px by which the column overflowed the panel,
          which put the discard pile and the game log out of reach. Making the
          panel scroll is only half of it, though: the hand row was
          `flex-1 min-h-0`, which is right on a desktop panel because it has
          leftover space to grow into — but on a phone every other row already
          exceeds the panel, so `flex-1` (basis 0, shrink 1) had nothing to
          grow into and collapsed to **zero height**. Your own hand, the only
          thing you tap, rendered at 0px. `flex-none` lets it take its natural
          height below `md` and keeps the desktop fill-the-gap behaviour above
          it. */}
      <InnerPanel className="relative w-full h-full p-4 md:p-5 overflow-y-auto bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
        <div className="max-w-6xl mx-auto h-full flex flex-col gap-3">
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2">
            <div>
              <h2 className="text-4xl font-bold leading-none">UNO</h2>
              <p className="text-sm text-slate-300 mt-1">
                Match colour or face · First to empty hand wins
              </p>
            </div>
            <div className="flex gap-2">
              {gameState.gameOver ? (
                <>
                  {sessionMode === "practice" && (
                    <Button onClick={handlePlayAgain}>PLAY AGAIN</Button>
                  )}
                  <Button
                    onClick={() => {
                      // The claim was already built and sent the moment the
                      // game ended — see `completeRewardIfNeeded`. Exiting is
                      // navigation now, not settlement, so winning and then
                      // closing the cabinet through the arcade chrome claims
                      // the same as pressing this button.
                      returnToMenu();
                    }}
                  >
                    EXIT
                  </Button>
                </>
              ) : (
                <Button onClick={() => setShowQuitConfirm(true)}>QUIT</Button>
              )}
            </div>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="bg-black/30 border border-white/20 p-2 rounded text-center">
              <p className="text-xs uppercase tracking-wide text-slate-400">
                Mode
              </p>
              <p className="text-base font-bold capitalize">{sessionMode}</p>
            </div>
            <div className="bg-black/30 border border-white/20 p-2 rounded text-center">
              <p className="text-xs uppercase tracking-wide text-slate-400">
                Deck Left
              </p>
              <p className="text-base font-bold">{deckRemaining}</p>
            </div>
            <div className="bg-black/30 border border-white/20 p-2 rounded text-center">
              <p className="text-xs uppercase tracking-wide text-slate-400">
                Active Colour
              </p>
              <p
                className={`text-base font-bold ${colorText[gameState.currentColor]}`}
              >
                {gameState.currentColor}
              </p>
            </div>
            <div className="bg-black/30 border border-white/20 p-2 rounded text-center">
              <p className="text-xs uppercase tracking-wide text-slate-400">
                Turn
              </p>
              <p className="text-base font-bold">
                {PLAYER_NAMES[gameState.currentPlayer]}
              </p>
            </div>
          </div>

          {/* Game over banner */}
          {gameState.gameOver && (
            <div className="bg-emerald-900/30 border border-emerald-300/30 p-3 rounded text-sm">
              {gameState.winner === "player"
                ? sessionMode === "reward"
                  ? `You win! Reward run completed for ${UNO_RAVEN_COIN_REWARD} RavenCoin.`
                  : "You win! 🎉"
                : `${PLAYER_NAMES[["player", "bot1", "bot2", "bot3"].indexOf(gameState.winner!)]} wins!`}
            </div>
          )}

          {/* Pending draw warning */}
          {gameState.pendingDrawCount > 0 && !gameState.gameOver && (
            <div className="bg-red-900/40 border border-red-400/40 p-2 rounded text-sm text-red-200">
              {isPlayerTurn
                ? `You must draw ${gameState.pendingDrawCount} cards (or counter with a matching draw card).`
                : `Next player must draw ${gameState.pendingDrawCount} cards!`}
            </div>
          )}

          {/* Bot hands */}
          <div className="grid grid-cols-3 gap-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className={`bg-black/25 border rounded p-2 ${gameState.currentPlayer === i ? "border-yellow-400" : "border-white/15"}`}
              >
                <p className="text-xs font-semibold mb-1 text-slate-300">
                  {PLAYER_NAMES[i]}{" "}
                  <span className="text-slate-400">
                    ({gameState.hands[i].length} cards)
                  </span>
                </p>
                <div className="flex flex-wrap gap-1">
                  {gameState.hands[i].map((c) =>
                    renderCard(c, { faceDown: true, small: true }),
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Discard pile + action buttons */}
          <div className="flex items-center gap-4">
            <div>
              <p className="text-xs uppercase text-slate-400 mb-1">Discard</p>
              {renderCard(topCard)}
            </div>
            {isPlayerTurn && (
              /* `py-3`, not `py-2`: this is the only other control in the game
                 besides the cards themselves, and at `py-2` it measured 36px
                 tall — under the 44px a thumb can be relied on to hit. */
              <button
                type="button"
                onClick={handlePlayerDraw}
                className="px-4 py-3 bg-slate-600 text-white rounded hover:bg-slate-500 active:scale-95 transition-all text-sm font-semibold"
              >
                {gameState.pendingDrawCount > 0
                  ? `Draw ${gameState.pendingDrawCount}`
                  : "Draw Card"}
              </button>
            )}
          </div>

          {/* Player hand. `flex-none` below `md` — see the panel above: at phone
              width `flex-1` had no free space to grow into and gave this row
              a 0px height, hiding the hand off the bottom of the panel. */}
          <div className="flex-none md:flex-1 md:min-h-0">
            <p className="text-xs uppercase text-slate-400 mb-1">
              Your Hand ({playerHand.length} cards)
              {isPlayerTurn && (
                <span className="ml-2 text-yellow-400 font-semibold">
                  — your turn
                </span>
              )}
            </p>
            <div className="flex flex-wrap gap-1 overflow-y-auto max-h-36 pb-1">
              {sortedPlayerHand.map((card) => {
                const isPlayable =
                  isPlayerTurn &&
                  (gameState.pendingDrawCount > 0
                    ? (topCard.face === "DrawTwo" && card.face === "DrawTwo") ||
                      (topCard.face === "WildDrawFour" &&
                        card.face === "WildDrawFour")
                    : canPlay(card, topCard, gameState.currentColor));

                return renderCard(card, {
                  onClick: isPlayable
                    ? () => handlePlayerPlay(card)
                    : undefined,
                  disabled: !isPlayable,
                  highlight: isPlayable,
                });
              })}
            </div>
          </div>

          {/* Game log */}
          <div className="bg-black/40 border border-white/20 rounded p-3">
            <h3 className="font-bold text-sm mb-1">Game Log</h3>
            <div className="space-y-0.5 max-h-16 overflow-hidden text-xs text-slate-300">
              {gameState.log.slice(0, 5).map((entry, i) => (
                <p key={`log-${i}`}>{entry}</p>
              ))}
            </div>
          </div>
        </div>

        {/* Wild colour picker overlay */}
        {pendingWildCard && (
          <div className="absolute inset-0 z-30 bg-black/70 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded border border-white/30 bg-slate-900 p-6 space-y-4">
              <h3 className="text-xl font-bold text-center">Choose a Colour</h3>
              <div className="grid grid-cols-2 gap-3">
                {NON_WILD_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    onClick={() => handleWildColorChosen(color)}
                    className={`py-3 px-4 rounded-lg font-bold text-sm ${colorBg[color as UnoColor]} ${colorText[color as UnoColor]} hover:opacity-90 active:scale-95 transition-all`}
                  >
                    {color}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Quit confirmation overlay */}
        {showQuitConfirm && (
          <div className="absolute inset-0 z-30 bg-black/60 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded border border-white/30 bg-slate-900 p-4 space-y-4">
              <h3 className="text-lg font-bold">Quit Uno?</h3>
              <p className="text-sm text-slate-200">
                Are you sure you want to quit? Current game progress will be
                lost.
              </p>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setShowQuitConfirm(false)}>
                  CANCEL
                </Button>
                <Button onClick={() => onClose?.()}>QUIT</Button>
              </div>
            </div>
          </div>
        )}
      </InnerPanel>
    </OuterPanel>
  );
};
