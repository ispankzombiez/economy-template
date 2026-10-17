/* eslint-disable react/jsx-no-literals, react/no-unescaped-entities */
import React, {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSelector } from "../adapters/useSelector";
import { Card } from "../poker/types";
import { OuterPanel, InnerPanel } from "components/ui/Panel";
import { ITEM_DETAILS } from "../adapters/itemDetails";
import { startAttempt, submitScore } from "../adapters/portalUtil";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { useBootstrap } from "lib/portal/BootstrapContext";
import { postEconomyWrite } from "lib/portal/api";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import { useRewardRun } from "../adapters/rewardRun";
import { ConfirmPanel } from "../adapters/ConfirmPanel";
import { useVipAccess } from "../adapters/useVipAccess";
import {
  BLACKJACK_BET_AMOUNTS,
  BlackjackBetAmount,
  BlackjackResult,
} from "./types";
import {
  BLACKJACK_STARTING_CHIPS,
  BLACKJACK_RAVEN_COIN_REWARD,
  BlackjackMode,
  BlackjackDifficulty,
  getBlackjackDifficulty,
  isBlackjackRewardRunAvailable,
} from "./session";
// The rules live in engine.ts — the same module the worker's replay imports —
// so this component is a view over one implementation, never a second one.
import {
  applyAction,
  createInitialState,
  nextHand,
  startHand,
  type BlackjackState,
  calculateHandValue,
} from "./engine";
import {
  encodeBlackjackActionLog,
  encodeBlackjackLog,
  MAX_BLACKJACK_ACTIONS,
} from "@nightshade/shared/anticheat/blackjackLog";
import type { VerifiedRun } from "lib/portal/api";

// ─── Shared panel size (matches poker) ───────────────────────────────────────

const bjPanelClassName =
  "mx-auto w-full max-w-[1100px] h-[min(92vh,860px)] overflow-hidden";

// ─── Card suit images (same assets as poker) ────────────────────────────────

const suitImages: Record<string, string> = {
  Kale: ITEM_DETAILS.Kale.image,
  Barley: ITEM_DETAILS.Barley.image,
  Wheat: ITEM_DETAILS.Wheat.image,
  Radish: ITEM_DETAILS.Radish.image,
};

// ─── Portal state selector ────────────────────────────────────────────────────

const _portalState = (state: PortalMachineState) => state.context.state;

// ─── Props ────────────────────────────────────────────────────────────────────

interface BlackjackGameProps {
  initialChips?: number;
  onClose?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export const BlackjackGame: React.FC<BlackjackGameProps> = ({
  initialChips = BLACKJACK_STARTING_CHIPS,
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState, type: "full" });
  const bootstrap = useBootstrap();

  const [gameState, setGameState] = useState<BlackjackState | null>(null);
  const [selectedBet, setSelectedBet] = useState<BlackjackBetAmount>(10);
  const [sessionMode, setSessionMode] = useState<BlackjackMode | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const [rewardRunStarted, setRewardRunStarted] = useState(false);
  const [rewardSubmitted, setRewardSubmitted] = useState(false);
  const [rewardGranted, setRewardGranted] = useState(false);
  // True from the moment a reward run is confirmed until its first hand is
  // dealt. Opening a paid run waits on a server round-trip (burn the ticket,
  // then read back the issued seed) — so without this the menu just sits
  // looking frozen, and "START REWARD RUN" stays live underneath, where a
  // second click would burn a *second* run.
  const [startingRun, setStartingRun] = useState(false);
  // True when a reward run could not read the seed the server issued for it.
  // The run is never started from a local substitute: the claim only mints
  // against the issued seed, so playing on would be a win that pays nothing.
  const [seedError, setSeedError] = useState(false);

  const difficulty: BlackjackDifficulty = useMemo(
    () => getBlackjackDifficulty(),
    [],
  );
  const targetChips = difficulty.targetChips;
  const maxHands = difficulty.maxHands;

  const hasRewardRun = useMemo(
    () => isBlackjackRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const realChips = initialChips || BLACKJACK_STARTING_CHIPS;

  // ─── Reward run hook ────────────────────────────────────────────────────────

  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "blackjack",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  /** The run's proof, captured as it happens rather than reconstructed after.
   *
   * `moveLogRef` holds every bet and action the engine actually applied,
   * `runSeedRef` the seed the decks were shuffled from, and
   * `runStartedAtRef` when the session opened. The claim is built from these
   * at the moment the session ends; see `completeRewardIfNeeded`.
   */
  const moveLogRef = useRef<{
    difficultyIdx: number;
    hands: { betIdx: number; actions: number[] }[];
  }>({ difficultyIdx: 0, hands: [] });
  const runSeedRef = useRef<number | null>(null);
  const runStartedAtRef = useRef<number>(0);
  const currentHandLogRef = useRef<number[]>([]);

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

  const getDifficultyIdx = useCallback(() => {
    // Must match session.ts BLACKJACK_DIFFICULTIES order
    return ["easy", "medium", "hard", "expert"].findIndex(
      (d) => d === difficulty.name,
    );
  }, [difficulty]);

  const returnToMenu = useCallback(() => {
    setShowRules(false);
    setConfirmExit(false);
    setSessionMode(null);
    setGameState(null);
    setStartingRun(false);
    setSeedError(false);
    moveLogRef.current = { difficultyIdx: 0, hands: [] };
    runSeedRef.current = null;
  }, []);

  /**
   * Deal a hand off `state` and record its bet in the replay log.
   *
   * The log's first entry is a *bet*, exactly like every later hand: the
   * worker rebuilds the session from the seed and needs to know what was
   * wagered before it can deal hand 1. Shared by session start, practice
   * restart and the between-hands DEAL so no path can open a hand the
   * verifier does not know about.
   */
  const openHand = useCallback((state: BlackjackState, bet: number): BlackjackState => {
    currentHandLogRef.current = [];
    const next = startHand(state, bet);
    if (next.currentHand) {
      const betIdx = BLACKJACK_BET_AMOUNTS.findIndex((b) => b === bet);
      if (betIdx >= 0) {
        moveLogRef.current.hands.push({ betIdx, actions: [] });
      }
    }
    return next;
  }, []);

  const startSession = useCallback(
    async (mode: BlackjackMode) => {
      // From here a paid run is already being opened on the server (the confirm
      // handler burned the ticket / spent the allowance before calling in), so
      // flip the loading card immediately — before the seed round-trip below —
      // so the menu never sits frozen while we wait. Cleared once the opening
      // hand is dealt and the mode flips.
      if (mode === "reward") setStartingRun(true);
      setSeedError(false);

      // Reward run: the shuffle seed is issued by the server at run-open and
      // read back here — no local substitute, because the claim only mints
      // against the issued seed. A failed read stops the run and says so.
      // Practice: a local seed, because it is never verified.
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
      setRewardSubmitted(false);
      setRewardGranted(false);
      moveLogRef.current = { difficultyIdx: getDifficultyIdx(), hands: [] };
      runSeedRef.current = seed;
      runStartedAtRef.current = Date.now();
      // Deal the opening hand immediately — the menu's bet selection *is*
      // this hand's bet, so there is no separate bet screen before hand 1.
      setGameState(openHand(createInitialState(seed, difficulty), selectedBet));

      if (mode === "reward" && !rewardRunStarted) {
        portalService.send({ type: "arcadeMinigame.started", name: "blackjack" });
        startAttempt();
        setRewardRunStarted(true);
      }

      // Clear the flag after the mode has flipped: the lobby only renders while
      // `gameState` is null, so once the hand is dealt the loading card is gone
      // regardless — but a later return-to-menu must not inherit a stale
      // "starting" state.
      setStartingRun(false);
    },
    [
      bootstrap,
      fetchRunSeed,
      getPracticeSeed,
      getDifficultyIdx,
      openHand,
      portalService,
      rewardRunStarted,
      selectedBet,
      difficulty,
    ],
  );

  const startNewHand = useCallback(
    (bet: number) => {
      if (!gameState) return;
      setGameState(openHand(gameState, bet));
    },
    [gameState, openHand],
  );

  const handleAction = useCallback(
    (action: number) => {
      if (!gameState) return;
      const next = applyAction(gameState, action);
      if (next === gameState) return;

      // Record the action if state changed
      currentHandLogRef.current.push(action);
      const hands = moveLogRef.current.hands;
      if (hands.length > 0) {
        hands[hands.length - 1].actions = [...currentHandLogRef.current];
      }

      setGameState(next);
    },
    [gameState],
  );

  const handleNextHand = useCallback(() => {
    if (!gameState) return;
    const next = nextHand(gameState);
    setGameState(next);
  }, [gameState]);

  const handlePracticeAgain = useCallback(() => {
    if (sessionMode !== "practice") return;
    const seed = getPracticeSeed();
    runSeedRef.current = seed;
    runStartedAtRef.current = Date.now();
    moveLogRef.current = { difficultyIdx: getDifficultyIdx(), hands: [] };
    currentHandLogRef.current = [];
    setGameState(openHand(createInitialState(seed, difficulty), selectedBet));
    setRewardRunStarted(false);
    setRewardGranted(false);
    setConfirmExit(false);
  }, [
    getPracticeSeed,
    getDifficultyIdx,
    openHand,
    difficulty,
    selectedBet,
    sessionMode,
  ]);

  const handleSessionExit = () => {
    if (sessionComplete) {
      setShowRules(false);
      onClose?.();
      return;
    }
    setConfirmExit(true);
  };

  // ─── Derived state ────────────────────────────────────────────────────────

  const currentHand = gameState?.currentHand ?? null;
  const handStatus = currentHand?.status ?? "idle";

  const playerValue = useMemo(
    () => (currentHand
      ? calculateHandValue(currentHand.playerHand)
      : { hard: 0, soft: 0, isBust: false, isBlackjack: false }),
    [currentHand?.playerHand],
  );
  const dealerValue = useMemo(
    () => (currentHand
      ? calculateHandValue(currentHand.dealerHand)
      : { hard: 0, soft: 0, isBust: false, isBlackjack: false }),
    [currentHand?.dealerHand],
  );
  const chipsToGoal = gameState
    ? Math.max(targetChips - gameState.playerChips, 0)
    : targetChips;
  const handsRemaining = gameState
    ? Math.max(maxHands - gameState.handsPlayed, 0)
    : maxHands;
  const sessionWon = gameState?.sessionWon ?? false;
  const sessionLost =
    handStatus === "gameover" &&
    !sessionWon &&
    ((gameState?.playerChips ?? 0) <= 0 || (gameState?.handsPlayed ?? 0) >= maxHands);
  const sessionComplete = sessionWon || sessionLost;
  const canPlayNextHand =
    handStatus === "gameover" && !sessionComplete;

  // ─── Settlement at session end ──────────────────────────────────────────────

  const completeRewardIfNeeded = useCallback(() => {
    if (!gameState || !gameState.sessionOver || sessionMode !== "reward") {
      return;
    }

    if (!rewardSubmitted) {
      submitScore({ score: Math.max(gameState.playerChips, 0) });
      setRewardSubmitted(true);
    }

    if (!gameState.sessionWon || rewardGranted) {
      return;
    }

    if (moveLogRef.current.hands.length === 0) {
      console.error("[blackjack] no hands in replay log");
      return;
    }

    const totalActions = moveLogRef.current.hands.reduce(
      (sum, h) => sum + h.actions.length,
      0,
    );
    if (totalActions > MAX_BLACKJACK_ACTIONS) {
      console.error("[blackjack] action log exceeded the replay ceiling");
      return;
    }

    const verify: VerifiedRun = {
      cabinet: "blackjack",
      score: gameState.playerChips,
      checkpoints: [],
      elapsedMs: Date.now() - runStartedAtRef.current,
      replay: {
        seed: runSeedRef.current ?? 0,
        difficulty: moveLogRef.current.difficultyIdx,
        actions: encodeBlackjackLog(
          encodeBlackjackActionLog(
            moveLogRef.current.difficultyIdx,
            moveLogRef.current.hands,
          ),
        ),
      },
    };

    portalService.send({
      type: "arcadeMinigame.ravenCoinWon",
      amount: BLACKJACK_RAVEN_COIN_REWARD,
      verify,
    });
    setRewardGranted(true);
  }, [
    gameState,
    sessionMode,
    rewardSubmitted,
    rewardGranted,
    portalService,
  ]);

  // Render-time settlement (Solitaire/Go Fish pattern)
  if (gameState?.sessionOver) {
    completeRewardIfNeeded();
  }

  // ─── UI Helpers ────────────────────────────────────────────────────────────

  const isResultsStage =
    handStatus === "gameover" || handStatus === "dealer_turn";
  const cardSizeClass = isResultsStage ? "w-12 h-[4.5rem]" : "w-16 h-24";
  const centerRankClass = isResultsStage ? "text-lg" : "text-2xl";
  const iconWidth = isResultsStage ? 8 : 10;

  const CardDisplay = ({
    card,
    hidden = false,
  }: {
    card?: Card;
    hidden?: boolean;
  }) => {
    if (hidden) {
      return (
        <div
          className={`${cardSizeClass} bg-gradient-to-br from-red-600 to-red-800 border-2 border-red-900 rounded-lg flex items-center justify-center font-bold text-white ${isResultsStage ? "text-lg" : "text-2xl"} shadow-lg`}
        >
          🎴
        </div>
      );
    }
    if (!card) return <div className={cardSizeClass} />;

    return (
      <div
        className={`${cardSizeClass} bg-white border-2 border-black rounded-lg shadow-lg overflow-hidden relative`}
      >
        <div className="absolute top-1 left-1 z-10">
          <img
            src={suitImages[card.suit]}
            alt="suit"
            className="block"
            style={{ width: iconWidth * 2, height: iconWidth * 2 }}
          />
        </div>
        <div className="absolute bottom-1 right-1 z-10 rotate-180">
          <img
            src={suitImages[card.suit]}
            alt="suit"
            className="block"
            style={{ width: iconWidth * 2, height: iconWidth * 2 }}
          />
        </div>
        <div className="w-full h-full flex items-center justify-center">
          <span
            className={`${centerRankClass} font-bold leading-none text-black`}
          >
            {card.rank}
          </span>
        </div>
      </div>
    );
  };

  const resultLabel = (): string => {
    if (sessionWon) {
      return sessionMode === "reward" ? "🎉 JACKPOT!" : "🎯 PRACTICE CLEAR";
    }
    switch (currentHand?.lastResult) {
      case "blackjack":
        return "🃏 BLACKJACK!";
      case "player":
        return "🎉 YOU WIN";
      case "dealer":
        return sessionLost ? "💥 RUN OVER" : "💥 DEALER WINS";
      case "push":
        return "🤝 PUSH";
      default:
        return "";
    }
  };

  const resultColor = (): string => {
    if (
      sessionWon ||
      currentHand?.lastResult === "player" ||
      currentHand?.lastResult === "blackjack"
    ) {
      return "bg-green-100 border-2 border-green-500";
    }
    if (currentHand?.lastResult === "push") {
      return "bg-yellow-100 border-2 border-yellow-500";
    }
    return "bg-red-100 border-2 border-red-500";
  };

  // ─── Rules popover ────────────────────────────────────────────────────────

  const renderRulesButton = () => (
    <div className="absolute right-4 top-4 z-20">
      <button
        type="button"
        onClick={() => setShowRules((v) => !v)}
        className="flex h-11 w-11 items-start justify-end"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-gray-700 bg-white text-sm font-bold text-gray-800 shadow">
          i
        </span>
      </button>

      {showRules && (
        <InnerPanel className="absolute right-0 mt-2 w-72 border-2 border-gray-700 bg-white p-3 text-left shadow-lg">
          <div className="text-xs font-bold uppercase tracking-wide text-gray-700">
            Blackjack Rules
          </div>
          <div className="mt-2 space-y-2 text-xs text-gray-800">
            <p>
              Beat the dealer to 21 without going over. Face cards are worth 10.
              Aces count as 11 or 1.
            </p>
            <p>
              Today's table is {difficulty.label}. Reach {targetChips} chips
              within {maxHands} hands starting from {BLACKJACK_STARTING_CHIPS}{" "}
              chips.
            </p>
            <p>
              Daily difficulty pool: Easy {BLACKJACK_STARTING_CHIPS}→200, Medium
              →400, Hard →600, Expert →800. Medium and Hard appear more often.
            </p>
            <p>
              Blackjack (Ace + 10-value on deal) pays 3:2. Push returns your
              bet. Dealer stands on soft 17.
            </p>
            <p>
              Double Down: double your bet, receive exactly one more card, then
              stand.
            </p>
            <p>
              Reward runs award {BLACKJACK_RAVEN_COIN_REWARD} RavenCoin on a
              successful clear. Practice runs never award RavenCoin.
            </p>
          </div>
        </InnerPanel>
      )}
    </div>
  );

  // ─── Confirm exit dialog ──────────────────────────────────────────────────

  const sessionExitConfirm = confirmExit ? (
    <ConfirmPanel
      title="EXIT BLACKJACK?"
      body="Your current hand and chips in this session will be lost. This cannot be undone."
      confirmLabel="CONFIRM — EXIT"
      onCancel={() => setConfirmExit(false)}
      onConfirm={() => {
        setConfirmExit(false);
        setShowRules(false);
        onClose?.();
      }}
    />
  ) : null;

  // ─── Render screens ────────────────────────────────────────────────────────

  // Menu — only while no session is open. A started session has a dealt hand
  // (or, between hands, `handsPlayed > 0`), so keying this off `gameState`
  // alone is what keeps START from landing back on this screen.
  if (!gameState) {
    return (
      <OuterPanel className={bjPanelClassName}>
        <div className="relative flex h-full flex-col gap-6 overflow-y-auto p-6">
          {renderRulesButton()}

          <div className="flex flex-col items-center text-center">
            <h2 className="text-4xl font-bold mb-2">♠ BLACKJACK ♠</h2>
            <div className="mt-2 text-sm text-gray-600 font-semibold">
              Beat the dealer — reach {targetChips} chips in {maxHands} hands
            </div>
          </div>

          <InnerPanel className="bg-yellow-100 p-4">
            <div className="grid grid-cols-4 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">REWARD</div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-yellow-700">
                  {BLACKJACK_RAVEN_COIN_REWARD}
                  <img src={ravenCoinIcon} alt="RavenCoin" className="w-6 h-6" />
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">CHIPS</div>
                <div className="text-2xl font-bold text-yellow-700">{realChips}</div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">GOAL</div>
                <div className="text-2xl font-bold text-yellow-700">{targetChips}</div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">HANDS</div>
                <div className="text-2xl font-bold text-yellow-700">{maxHands}</div>
              </div>
            </div>
          </InnerPanel>

          <div>
            <div className="text-center font-bold mb-3 text-gray-800">SELECT YOUR OPENING BET</div>
            <div className="grid grid-cols-5 gap-2">
              {BLACKJACK_BET_AMOUNTS.map((amount) => (
                <button
                  key={amount}
                  onClick={() => setSelectedBet(amount)}
                  disabled={realChips < amount}
                  className={`py-3 rounded-lg font-bold transition-all active:scale-95 ${
                    selectedBet === amount
                      ? "bg-blue-600 text-white shadow-lg scale-105"
                      : realChips < amount
                        ? "bg-gray-300 text-gray-500 opacity-50 cursor-not-allowed"
                        : "bg-blue-400 text-white hover:bg-blue-500 shadow"
                  }`}
                >
                  {amount}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={rewardRun.start}
            disabled={!hasRewardRun || startingRun || realChips < selectedBet}
            className={`w-full px-6 py-4 rounded-lg font-bold transition-all shadow-lg text-lg ${
              hasRewardRun && !startingRun && realChips >= selectedBet
                ? "bg-green-500 text-white hover:bg-green-600 active:scale-95"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            <div>{startingRun ? "STARTING…" : "🎯 START REWARD RUN"}</div>
            <div className="mt-2 text-xs opacity-90">
              {!hasRewardRun
                ? "No reward runs left today — buy Play Tickets in the shop."
                : startingRun
                  ? "Opening a reward run on the server…"
                  : rewardRun.freeAvailable
                    ? isVip
                      ? "VIP: reward run available for blackjack today."
                      : "Reward run available for the arcade today."
                    : `Uses 1 Play Ticket (you have ${rewardRun.tickets}).`}
            </div>
          </button>

          <button
            onClick={() => startSession("practice")}
            disabled={startingRun || realChips < selectedBet}
            className="w-full px-6 py-4 bg-blue-500 text-white font-bold rounded-lg hover:bg-blue-600 active:scale-95 transition-all shadow-lg text-lg disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            <div>🃏 START PRACTICE MODE</div>
            <div className="mt-2 text-xs font-semibold opacity-90">
              Play without spending today's reward attempt.
            </div>
          </button>

          {rewardRun.dialog}

          {rewardRun.error && (
            <p className="text-center text-xs font-semibold text-red-600">{rewardRun.error}</p>
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
                  Opening a reward run on the server and shuffling your shoes.
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

          {sessionExitConfirm}
        </div>
      </OuterPanel>
    );
  }

  // Between-hands bet screen — a session with no hand currently dealt
  // (including hand 1's predecessor state, which never occurs now that the
  // opening hand is dealt at session start).
  if (!currentHand) {
    return (
      <OuterPanel className={bjPanelClassName}>
        <div className="relative flex h-full flex-col gap-6 overflow-y-auto p-6">
          {renderRulesButton()}

          <div className="text-center">
            <h2 className="text-3xl font-bold">PLACE YOUR BET</h2>
            <div className="text-xs uppercase tracking-wide text-gray-500 mt-1">
              Hand {gameState.handsPlayed + 1} of {maxHands}
            </div>
          </div>

          <InnerPanel className="bg-yellow-100 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">CHIPS</div>
                <div className="text-2xl font-bold text-yellow-700">{gameState.playerChips}</div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">NEEDED</div>
                <div className="text-2xl font-bold text-yellow-700">{chipsToGoal}</div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">HANDS LEFT</div>
                <div className="text-2xl font-bold text-yellow-700">{handsRemaining}</div>
              </div>
            </div>
          </InnerPanel>

          <div>
            <div className="text-center font-bold mb-3 text-gray-800">SELECT BET AMOUNT</div>
            <div className="grid grid-cols-5 gap-2">
              {BLACKJACK_BET_AMOUNTS.map((amount) => (
                <button
                  key={amount}
                  onClick={() => setSelectedBet(amount)}
                  disabled={gameState.playerChips < amount}
                  className={`py-3 rounded-lg font-bold transition-all active:scale-95 ${
                    selectedBet === amount
                      ? "bg-blue-600 text-white shadow-lg scale-105"
                      : gameState.playerChips < amount
                        ? "bg-gray-300 text-gray-500 opacity-50 cursor-not-allowed"
                        : "bg-blue-400 text-white hover:bg-blue-500 shadow"
                  }`}
                >
                  {amount}
                </button>
              ))}
            </div>
          </div>

          <InnerPanel className="bg-blue-100 p-4 text-center border-2 border-blue-400">
            <div className="text-sm text-blue-700 font-semibold">YOUR BET</div>
            <div className="text-3xl font-bold text-blue-800">{selectedBet}</div>
          </InnerPanel>

          <button
            onClick={() => startNewHand(selectedBet)}
            disabled={gameState.playerChips < selectedBet}
            className="w-full px-6 py-3 bg-green-500 text-white font-bold rounded-lg hover:bg-green-600 active:scale-95 transition-all shadow-lg text-lg disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            ✓ DEAL
          </button>

          {onClose && (
            <button
              onClick={handleSessionExit}
              className="w-full px-6 py-2 bg-gray-400 text-white font-semibold rounded-lg hover:bg-gray-500 active:scale-95 transition-all"
            >
              EXIT
            </button>
          )}

          {sessionExitConfirm}
        </div>
      </OuterPanel>
    );
  }

  // Main game table
  const dealerDisplayValue =
    handStatus === "player_turn"
      ? calculateHandValue([currentHand?.dealerHand[0] ?? { suit: "Kale", rank: "A" }]).soft
      : dealerValue.soft;

  return (
    <OuterPanel className={bjPanelClassName}>
      <div
        className={`relative flex h-full flex-col overflow-y-auto p-4 sm:p-6 ${isResultsStage ? "gap-2 sm:gap-3" : "gap-3 sm:gap-4"}`}
      >
        {renderRulesButton()}

        {/* HUD */}
        <div className="grid grid-cols-3 gap-2 px-2 text-center">
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500">Chips</div>
            <span className="text-3xl font-bold text-green-700">{gameState.playerChips}</span>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500">Hand</div>
            <span className="text-2xl font-bold text-blue-700">{gameState.handsPlayed}/{maxHands}</span>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500">Bet</div>
            <span className="text-2xl font-bold text-purple-700">{currentHand?.currentBet ?? 0}</span>
          </div>
        </div>

        {/* Progress bar */}
        <InnerPanel className={`bg-yellow-50 text-center border border-yellow-300 ${isResultsStage ? "p-2" : "p-3"}`}>
          <div className="text-sm font-semibold text-gray-800">
            {chipsToGoal > 0
              ? `${chipsToGoal} chips to go to clear the table.`
              : "Goal reached! Finish the hand to lock in the win."}
          </div>
          <div className="text-xs text-gray-600 mt-1">
            {handsRemaining > 0
              ? `${handsRemaining} hand${handsRemaining === 1 ? "" : "s"} remaining.`
              : "This is your final hand."}
          </div>
        </InnerPanel>

        {/* Dealer hand */}
        <InnerPanel className={`bg-gray-700 text-white ${isResultsStage ? "p-2" : "p-4"}`}>
          <div className={`text-center font-bold ${isResultsStage ? "mb-1 text-sm" : "mb-2"}`}>
            🏠 DEALER — {dealerDisplayValue}
            {handStatus === "player_turn" ? " + ?" : ""}
            {dealerValue.isBust && handStatus !== "player_turn" ? " (BUST)" : ""}
          </div>
          <div className={`flex justify-center ${isResultsStage ? "gap-1" : "gap-2"}`}>
            {currentHand?.dealerHand.map((card, i) => (
              <CardDisplay
                key={i}
                card={card}
                hidden={i === 1 && handStatus === "player_turn"}
              />
            ))}
          </div>
        </InnerPanel>

        {/* Player hand */}
        <InnerPanel className={`bg-blue-700 text-white border-4 border-yellow-400 ${isResultsStage ? "p-2" : "p-4"}`}>
          <div className={`text-center font-bold ${isResultsStage ? "mb-1 text-sm" : "mb-2"}`}>
            👤 YOUR HAND — {playerValue.soft}
            {playerValue.isBust ? " (BUST)" : ""}
            {playerValue.isBlackjack ? " ✨ BLACKJACK!" : ""}
          </div>
          <div className={`flex justify-center flex-wrap ${isResultsStage ? "gap-1" : "gap-2"}`}>
            {currentHand?.playerHand.map((card, i) => (
              <CardDisplay key={i} card={card} />
            ))}
          </div>
        </InnerPanel>

        {/* Action area */}
        <div className={`flex flex-col ${isResultsStage ? "gap-1.5" : "gap-2"}`}>
          {/* Player actions */}
          {handStatus === "player_turn" && (
            <div className="flex gap-2">
              <button
                onClick={() => handleAction(0)} // HIT
                className="flex-1 px-4 py-3 bg-yellow-500 text-white font-bold rounded-lg hover:bg-yellow-600 active:scale-95 transition-all shadow-lg"
              >
                👆 HIT
              </button>
              <button
                onClick={() => handleAction(1)} // STAND
                className="flex-1 px-4 py-3 bg-blue-500 text-white font-bold rounded-lg hover:bg-blue-600 active:scale-95 transition-all shadow-lg"
              >
                ✋ STAND
              </button>
              {currentHand?.playerHand.length === 2 &&
                gameState.playerChips >= currentHand.currentBet && (
                  <button
                    onClick={() => handleAction(2)} // DOUBLE
                    className="flex-1 px-4 py-3 bg-purple-500 text-white font-bold rounded-lg hover:bg-purple-600 active:scale-95 transition-all shadow-lg"
                  >
                    💎 DOUBLE
                  </button>
                )}
            </div>
          )}

          {/* Dealer playing indicator */}
          {handStatus === "dealer_turn" && (
            <InnerPanel className="bg-gray-100 p-3 text-center border-2 border-gray-400">
              <div className="text-base font-bold text-gray-700">Dealer is playing...</div>
            </InnerPanel>
          )}

          {/* Result */}
          {handStatus === "gameover" && (
            <div className="flex flex-col gap-2">
              <InnerPanel className={`p-3 text-center ${resultColor()}`}>
                <div className="text-xl font-bold">{resultLabel()}</div>
                <div className="mt-1 text-xs sm:text-sm text-gray-700">
                  {sessionWon
                    ? sessionMode === "reward"
                      ? `You reached ${gameState.playerChips} chips and earned ${BLACKJACK_RAVEN_COIN_REWARD} RavenCoin!`
                      : `You reached ${gameState.playerChips} chips in practice mode. No RavenCoin in practice.`
                    : sessionLost
                      ? `You finished with ${gameState.playerChips} chips after ${gameState.handsPlayed} hand${gameState.handsPlayed === 1 ? "" : "s"}.`
                      : currentHand?.lastResult === "push"
                        ? `Push — bet returned. Stack: ${gameState.playerChips} chips.`
                        : currentHand && currentHand.lastNetChips > 0
                          ? `+${currentHand.lastNetChips} chips! Stack: ${gameState.playerChips}.`
                          : `${currentHand?.lastNetChips ?? 0} chips. Stack: ${gameState.playerChips}.`}
                </div>
              </InnerPanel>

              {/* Score breakdown */}
              <InnerPanel className="bg-purple-100 p-3 border-2 border-purple-400">
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div>
                    <div className="text-xs font-semibold text-gray-600">YOUR HAND</div>
                    <div className="text-base font-bold text-purple-800">
                      {playerValue.soft}
                      {playerValue.isBust
                        ? " — BUST"
                        : playerValue.isBlackjack
                          ? " — BJ"
                          : ""}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold text-gray-600">DEALER HAND</div>
                    <div className="text-base font-bold text-purple-800">
                      {dealerValue.soft}
                      {dealerValue.isBust ? " — BUST" : ""}
                    </div>
                  </div>
                </div>
              </InnerPanel>

              {canPlayNextHand && (
                <button
                  onClick={handleNextHand}
                  className="w-full px-4 py-2.5 bg-green-500 text-white font-bold rounded-lg hover:bg-green-600 active:scale-95 transition-all shadow-lg"
                >
                  🔄 NEXT HAND
                </button>
              )}

              {sessionComplete && sessionMode === "practice" && (
                <button
                  onClick={handlePracticeAgain}
                  className="w-full px-4 py-2.5 bg-green-500 text-white font-bold rounded-lg hover:bg-green-600 active:scale-95 transition-all shadow-lg"
                >
                  🔄 PLAY PRACTICE AGAIN
                </button>
              )}

              {onClose && (
                <button
                  onClick={handleSessionExit}
                  className="w-full px-4 py-2 bg-gray-400 text-white font-semibold rounded-lg hover:bg-gray-500 active:scale-95 transition-all"
                >
                  {sessionComplete ? "EXIT BLACKJACK" : "BACK TO ARCADE"}
                </button>
              )}

              {sessionExitConfirm}
            </div>
          )}
        </div>
      </div>
    </OuterPanel>
  );
};