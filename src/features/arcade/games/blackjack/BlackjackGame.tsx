/* eslint-disable react/jsx-no-literals, react/no-unescaped-entities */
import React, {
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useState,
} from "react";
import { useSelector } from "../adapters/useSelector";
import { Card } from "../poker/types";
import { BlackjackDeck } from "./deck";
import { OuterPanel, InnerPanel } from "components/ui/Panel";
import { ITEM_DETAILS } from "../adapters/itemDetails";
import {
  purchase,
  startAttempt,
  submitScore,
} from "../adapters/portalUtil";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import { useVipAccess } from "../adapters/useVipAccess";
import {
  EXTRA_REWARD_ATTEMPT_FLOWER_COST,
  getRemainingPaidAttemptsForMinigame,
} from "../poker/session";
import {
  BLACKJACK_BET_AMOUNTS,
  BlackjackBetAmount,
  BlackjackGameState,
  BlackjackResult,
} from "./types";
import {
  BLACKJACK_STARTING_CHIPS,
  BLACKJACK_RAVEN_COIN_REWARD,
  BlackjackMode,
  BlackjackDifficulty,
  calculateHandValue,
  getBlackjackDifficulty,
  isBlackjackRewardRunAvailable,
} from "./session";

// ─── Shared panel size (matches poker) ───────────────────────────────────────

const bjPanelClassName =
  "mx-auto w-[min(96vw,1100px)] h-[min(92vh,860px)] overflow-hidden";

// ─── Reducer ─────────────────────────────────────────────────────────────────

type GameAction =
  | {
      type: "START_HAND";
      startingChips: number;
      bet: BlackjackBetAmount | number;
    }
  | { type: "DEAL"; playerHand: Card[]; dealerHand: Card[] }
  | { type: "HIT"; card: Card }
  | { type: "DOUBLE"; card: Card }
  | { type: "STAND" }
  | {
      type: "RESOLVE";
      dealerHand: Card[];
      result: BlackjackResult;
      netChips: number;
    }
  | { type: "NEXT_HAND"; startingChips: number }
  | { type: "RESET_SESSION"; startingChips: number };

const createInitialState = (startingChips: number): BlackjackGameState => ({
  status: "idle",
  playerHand: [],
  dealerHand: [],
  currentBet: 10,
  playerChips: startingChips,
  lastResult: null,
  lastNetChips: 0,
  handsPlayed: 0,
  totalWinnings: 0,
  totalLosses: 0,
});

function reducer(
  state: BlackjackGameState,
  action: GameAction,
): BlackjackGameState {
  switch (action.type) {
    case "START_HAND":
      return {
        ...state,
        status: "dealing",
        playerHand: [],
        dealerHand: [],
        currentBet: action.bet,
        playerChips: action.startingChips - action.bet,
        lastResult: null,
        lastNetChips: 0,
        handsPlayed: state.handsPlayed + 1,
      };

    case "DEAL":
      return {
        ...state,
        status: "player_turn",
        playerHand: action.playerHand,
        dealerHand: action.dealerHand,
      };

    case "HIT":
      return {
        ...state,
        playerHand: [...state.playerHand, action.card],
      };

    case "DOUBLE":
      return {
        ...state,
        playerChips: state.playerChips - state.currentBet,
        currentBet: state.currentBet * 2,
        playerHand: [...state.playerHand, action.card],
        status: "dealer_turn",
      };

    case "STAND":
      return { ...state, status: "dealer_turn" };

    case "RESOLVE": {
      const won = action.netChips > 0 ? action.netChips : 0;
      const lost = action.netChips < 0 ? Math.abs(action.netChips) : 0;
      return {
        ...state,
        status: "gameover",
        dealerHand: action.dealerHand,
        playerChips: state.playerChips + state.currentBet + action.netChips,
        lastResult: action.result,
        lastNetChips: action.netChips,
        totalWinnings: state.totalWinnings + won,
        totalLosses: state.totalLosses + lost,
      };
    }

    case "NEXT_HAND":
      return {
        ...state,
        status: "idle",
        playerHand: [],
        dealerHand: [],
        lastResult: null,
        lastNetChips: 0,
        playerChips: action.startingChips,
      };

    case "RESET_SESSION":
      return createInitialState(action.startingChips);

    default:
      return state;
  }
}

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

  const [gameState, dispatch] = useReducer(
    reducer,
    initialChips,
    createInitialState,
  );

  const [deck, setDeck] = useState<BlackjackDeck | null>(null);
  const [selectedBet, setSelectedBet] = useState<BlackjackBetAmount>(10);
  const [sessionMode, setSessionMode] = useState<BlackjackMode | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [rewardRunStarted, setRewardRunStarted] = useState(false);
  const [rewardGranted, setRewardGranted] = useState(false);

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
  const hasEnoughFlower =
    Number(portalGameState.balance ?? 0) >= EXTRA_REWARD_ATTEMPT_FLOWER_COST;
  const paidAttemptsRemaining = useMemo(
    () => getRemainingPaidAttemptsForMinigame(portalGameState, "blackjack"),
    [portalGameState],
  );

  const realChips = initialChips || BLACKJACK_STARTING_CHIPS;

  // Derived state
  const playerValue = useMemo(
    () => calculateHandValue(gameState.playerHand),
    [gameState.playerHand],
  );
  const dealerValue = useMemo(
    () => calculateHandValue(gameState.dealerHand),
    [gameState.dealerHand],
  );
  const chipsToGoal = Math.max(targetChips - gameState.playerChips, 0);
  const handsRemaining = Math.max(maxHands - gameState.handsPlayed, 0);
  const sessionWon = gameState.playerChips >= targetChips;
  const sessionLost =
    gameState.status === "gameover" &&
    !sessionWon &&
    (gameState.playerChips <= 0 || gameState.handsPlayed >= maxHands);
  const sessionComplete = sessionWon || sessionLost;
  const canPlayNextHand = gameState.status === "gameover" && !sessionComplete;

  const handleSessionExit = () => {
    if (sessionComplete) {
      setShowRules(false);
      setSessionMode(null);
      return;
    }

    const confirmed = window.confirm(
      "Exit Blackjack? Current game progress will be lost.",
    );
    if (!confirmed) return;

    onClose?.();
  };

  // ─── Card suit images (same assets as poker) ────────────────────────────────

  const suitImages: Record<string, string> = {
    Kale: ITEM_DETAILS.Kale.image,
    Barley: ITEM_DETAILS.Barley.image,
    Wheat: ITEM_DETAILS.Wheat.image,
    Radish: ITEM_DETAILS.Radish.image,
  };

  // ─── Game logic ───────────────────────────────────────────────────────────

  const startHand = useCallback(
    (mode: BlackjackMode) => {
      const bet = selectedBet;
      const chips =
        gameState.status === "idle" && gameState.handsPlayed === 0
          ? realChips
          : gameState.playerChips;

      if (chips < bet) return;

      setSessionMode(mode);
      const newDeck = new BlackjackDeck();
      setDeck(newDeck);

      dispatch({ type: "START_HAND", startingChips: chips, bet });

      // Deal 2 cards each
      const playerHand = [newDeck.deal(), newDeck.deal()];
      const dealerHand = [newDeck.deal(), newDeck.deal()];

      setTimeout(() => {
        dispatch({ type: "DEAL", playerHand, dealerHand });

        // Start reward attempt on first reward hand
        if (mode === "reward" && !rewardRunStarted) {
          portalService.send({
            type: "arcadeMinigame.started",
            name: "blackjack",
          });
          startAttempt();
          setRewardRunStarted(true);
        }

        // Immediate blackjack check
        const pv = calculateHandValue(playerHand);
        const dv = calculateHandValue(dealerHand);

        if (pv.isBlackjack || dv.isBlackjack) {
          setTimeout(() => {
            resolveHand(
              playerHand,
              dealerHand,
              newDeck,
              chips - bet,
              bet,
              mode,
            );
          }, 600);
        }
      }, 300);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedBet, gameState, realChips, rewardRunStarted],
  );

  const resolveHand = useCallback(
    (
      finalPlayerHand: Card[],
      finalDealerHand: Card[],
      activeDeck: BlackjackDeck,
      chipsAfterBet: number,
      bet: number,
      mode: BlackjackMode | null,
    ) => {
      // Dealer hits until 17+
      const dealerFinal = [...finalDealerHand];
      let dv = calculateHandValue(dealerFinal);

      while (dv.soft < 17) {
        dealerFinal.push(activeDeck.deal());
        dv = calculateHandValue(dealerFinal);
      }

      const pv = calculateHandValue(finalPlayerHand);

      let result: BlackjackResult;
      let netChips: number;

      if (pv.isBust) {
        result = "dealer";
        netChips = -bet;
      } else if (dv.isBust) {
        result = pv.isBlackjack ? "blackjack" : "player";
        netChips = pv.isBlackjack ? Math.floor(bet * 1.5) : bet;
      } else if (pv.isBlackjack && !dv.isBlackjack) {
        result = "blackjack";
        netChips = Math.floor(bet * 1.5);
      } else if (pv.soft > dv.soft) {
        result = "player";
        netChips = bet;
      } else if (dv.soft > pv.soft) {
        result = "dealer";
        netChips = -bet;
      } else {
        result = "push";
        netChips = 0;
      }

      const finalChips = chipsAfterBet + bet + netChips;
      const wonSession = finalChips >= targetChips;
      const endSession =
        wonSession || finalChips <= 0 || gameState.handsPlayed >= maxHands;

      dispatch({ type: "RESOLVE", dealerHand: dealerFinal, result, netChips });

      if (mode === "reward" && endSession) {
        submitScore({ score: Math.max(finalChips, 0) });

        if (wonSession && !rewardGranted) {
          portalService.send({
            type: "arcadeMinigame.ravenCoinWon",
            amount: BLACKJACK_RAVEN_COIN_REWARD,
          });
          setRewardGranted(true);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targetChips, maxHands, gameState.handsPlayed, rewardGranted],
  );

  const handleHit = useCallback(() => {
    if (!deck || gameState.status !== "player_turn") return;
    const card = deck.deal();
    dispatch({ type: "HIT", card });

    const newHand = [...gameState.playerHand, card];
    const pv = calculateHandValue(newHand);

    if (pv.isBust || pv.soft === 21) {
      setTimeout(() => {
        resolveHand(
          newHand,
          gameState.dealerHand,
          deck,
          gameState.playerChips,
          gameState.currentBet,
          sessionMode,
        );
      }, 400);
    }
  }, [deck, gameState, sessionMode, resolveHand]);

  const handleStand = useCallback(() => {
    if (!deck || gameState.status !== "player_turn") return;
    dispatch({ type: "STAND" });

    setTimeout(() => {
      resolveHand(
        gameState.playerHand,
        gameState.dealerHand,
        deck,
        gameState.playerChips,
        gameState.currentBet,
        sessionMode,
      );
    }, 300);
  }, [deck, gameState, sessionMode, resolveHand]);

  const handleDouble = useCallback(() => {
    if (!deck || gameState.status !== "player_turn") return;
    if (gameState.playerChips < gameState.currentBet) return;

    const card = deck.deal();
    dispatch({ type: "DOUBLE", card });

    const newHand = [...gameState.playerHand, card];

    setTimeout(() => {
      resolveHand(
        newHand,
        gameState.dealerHand,
        deck,
        gameState.playerChips - gameState.currentBet,
        gameState.currentBet * 2,
        sessionMode,
      );
    }, 400);
  }, [deck, gameState, sessionMode, resolveHand]);

  const handleNextHand = useCallback(() => {
    dispatch({ type: "NEXT_HAND", startingChips: gameState.playerChips });
  }, [gameState.playerChips]);

  const handlePracticeAgain = useCallback(() => {
    setRewardRunStarted(false);
    setRewardGranted(false);
    dispatch({ type: "RESET_SESSION", startingChips: realChips });
  }, [realChips]);

  // ─── Shared CardDisplay (same look as poker) ──────────────────────────────

  const isResultsStage =
    gameState.status === "gameover" || gameState.status === "dealer_turn";
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

  // ─── Rules popover ────────────────────────────────────────────────────────

  const renderRulesButton = () => (
    <div className="absolute right-4 top-4 z-20">
      <button
        type="button"
        onClick={() => setShowRules((v) => !v)}
        className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-gray-700 bg-white text-sm font-bold text-gray-800 shadow"
      >
        i
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

  // ─── Result label helpers ─────────────────────────────────────────────────

  const resultLabel = (): string => {
    if (sessionWon) {
      return sessionMode === "reward" ? "🎉 JACKPOT!" : "🎯 PRACTICE CLEAR";
    }
    switch (gameState.lastResult) {
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
      gameState.lastResult === "player" ||
      gameState.lastResult === "blackjack"
    ) {
      return "bg-green-100 border-2 border-green-500";
    }
    if (gameState.lastResult === "push") {
      return "bg-yellow-100 border-2 border-yellow-500";
    }
    return "bg-red-100 border-2 border-red-500";
  };

  // ─── Idle screen ──────────────────────────────────────────────────────────

  if (gameState.status === "idle" && gameState.handsPlayed === 0) {
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
                <div className="text-sm text-gray-700 font-semibold">
                  REWARD
                </div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-yellow-700">
                  {BLACKJACK_RAVEN_COIN_REWARD}
                  <img
                    src={ravenCoinIcon}
                    alt="RavenCoin"
                    className="w-6 h-6"
                  />
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">CHIPS</div>
                <div className="text-2xl font-bold text-yellow-700">
                  {realChips}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">GOAL</div>
                <div className="text-2xl font-bold text-yellow-700">
                  {targetChips}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">HANDS</div>
                <div className="text-2xl font-bold text-yellow-700">
                  {maxHands}
                </div>
              </div>
            </div>
          </InnerPanel>

          {/* Bet selector */}
          <div>
            <div className="text-center font-bold mb-3 text-gray-800">
              SELECT YOUR OPENING BET
            </div>
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
            onClick={() => startHand("reward")}
            disabled={!hasRewardRun || realChips < selectedBet}
            className={`w-full px-6 py-4 rounded-lg font-bold transition-all shadow-lg text-lg ${
              hasRewardRun && realChips >= selectedBet
                ? "bg-green-500 text-white hover:bg-green-600 active:scale-95"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            <div>🎯 START REWARD RUN</div>
            <div className="mt-2 text-xs opacity-90">
              {hasRewardRun
                ? isVip
                  ? "VIP: reward run available for blackjack today."
                  : "Reward run available for the arcade today."
                : isVip
                  ? "VIP: today's blackjack reward run has already been used."
                  : "Today's arcade reward run has already been used."}
            </div>
          </button>

          <button
            onClick={() => startHand("practice")}
            disabled={realChips < selectedBet}
            className="w-full px-6 py-4 bg-blue-500 text-white font-bold rounded-lg hover:bg-blue-600 active:scale-95 transition-all shadow-lg text-lg"
          >
            <div>🃏 START PRACTICE MODE</div>
            <div className="mt-2 text-xs font-semibold opacity-90">
              Play without spending today's reward attempt.
            </div>
          </button>

          {!hasRewardRun && paidAttemptsRemaining > 0 && (
            <button
              onClick={() =>
                purchase({ sfl: EXTRA_REWARD_ATTEMPT_FLOWER_COST, items: {} })
              }
              disabled={!hasEnoughFlower}
              className={`w-full px-6 py-3 rounded-lg font-bold transition-all shadow-lg text-sm ${
                hasEnoughFlower
                  ? "bg-amber-500 text-white hover:bg-amber-600 active:scale-95"
                  : "bg-gray-300 text-gray-500 cursor-not-allowed"
              }`}
            >
              BUY +1 REWARD ATTEMPT ({EXTRA_REWARD_ATTEMPT_FLOWER_COST} FLOWER)
            </button>
          )}

          {onClose && (
            <button
              onClick={handleSessionExit}
              className="w-full px-6 py-2 bg-gray-400 text-white font-semibold rounded-lg hover:bg-gray-500 active:scale-95 transition-all"
            >
              EXIT
            </button>
          )}
        </div>
      </OuterPanel>
    );
  }

  // ─── Mid-session bet screen (between hands) ───────────────────────────────

  if (gameState.status === "idle" && gameState.handsPlayed > 0) {
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
                <div className="text-2xl font-bold text-yellow-700">
                  {gameState.playerChips}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  NEEDED
                </div>
                <div className="text-2xl font-bold text-yellow-700">
                  {chipsToGoal}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  HANDS LEFT
                </div>
                <div className="text-2xl font-bold text-yellow-700">
                  {handsRemaining}
                </div>
              </div>
            </div>
          </InnerPanel>

          <div>
            <div className="text-center font-bold mb-3 text-gray-800">
              SELECT BET AMOUNT
            </div>
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
            <div className="text-3xl font-bold text-blue-800">
              {selectedBet}
            </div>
          </InnerPanel>

          <button
            onClick={() => startHand(sessionMode ?? "practice")}
            disabled={gameState.playerChips < selectedBet}
            className="w-full px-6 py-3 bg-green-500 text-white font-bold rounded-lg hover:bg-green-600 active:scale-95 transition-all shadow-lg text-lg disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            ✓ DEAL
          </button>

          {onClose && (
            <button
              onClick={onClose}
              className="w-full px-6 py-2 bg-gray-400 text-white font-semibold rounded-lg hover:bg-gray-500 active:scale-95 transition-all"
            >
              EXIT
            </button>
          )}
        </div>
      </OuterPanel>
    );
  }

  // ─── Main game table ──────────────────────────────────────────────────────

  const dealerDisplayValue =
    gameState.status === "player_turn"
      ? calculateHandValue([gameState.dealerHand[0]]).soft // show only first card
      : dealerValue.soft;

  const playerDisplayValue = playerValue.soft;

  return (
    <OuterPanel className={bjPanelClassName}>
      <div
        className={`relative flex h-full flex-col overflow-y-auto p-4 sm:p-6 ${isResultsStage ? "gap-2 sm:gap-3" : "gap-3 sm:gap-4"}`}
      >
        {renderRulesButton()}

        {/* HUD */}
        <div className="grid grid-cols-3 gap-2 px-2 text-center">
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500">
              Chips
            </div>
            <span className="text-3xl font-bold text-green-700">
              {gameState.playerChips}
            </span>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500">
              Hand
            </div>
            <span className="text-2xl font-bold text-blue-700">
              {gameState.handsPlayed}/{maxHands}
            </span>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500">
              Bet
            </div>
            <span className="text-2xl font-bold text-purple-700">
              {gameState.currentBet}
            </span>
          </div>
        </div>

        {/* Progress bar */}
        <InnerPanel
          className={`bg-yellow-50 text-center border border-yellow-300 ${isResultsStage ? "p-2" : "p-3"}`}
        >
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
        <InnerPanel
          className={`bg-gray-700 text-white ${isResultsStage ? "p-2" : "p-4"}`}
        >
          <div
            className={`text-center font-bold ${isResultsStage ? "mb-1 text-sm" : "mb-2"}`}
          >
            🏠 DEALER — {dealerDisplayValue}
            {gameState.status === "player_turn" ? " + ?" : ""}
            {dealerValue.isBust && gameState.status !== "player_turn"
              ? " (BUST)"
              : ""}
          </div>
          <div
            className={`flex justify-center ${isResultsStage ? "gap-1" : "gap-2"}`}
          >
            {gameState.dealerHand.map((card, i) => (
              <CardDisplay
                key={i}
                card={card}
                hidden={i === 1 && gameState.status === "player_turn"}
              />
            ))}
          </div>
        </InnerPanel>

        {/* Player hand */}
        <InnerPanel
          className={`bg-blue-700 text-white border-4 border-yellow-400 ${isResultsStage ? "p-2" : "p-4"}`}
        >
          <div
            className={`text-center font-bold ${isResultsStage ? "mb-1 text-sm" : "mb-2"}`}
          >
            👤 YOUR HAND — {playerDisplayValue}
            {playerValue.isBust ? " (BUST)" : ""}
            {playerValue.isBlackjack ? " ✨ BLACKJACK!" : ""}
          </div>
          <div
            className={`flex justify-center flex-wrap ${isResultsStage ? "gap-1" : "gap-2"}`}
          >
            {gameState.playerHand.map((card, i) => (
              <CardDisplay key={i} card={card} />
            ))}
          </div>
        </InnerPanel>

        {/* Action area */}
        <div
          className={`flex flex-col ${isResultsStage ? "gap-1.5" : "gap-2"}`}
        >
          {/* Player actions */}
          {gameState.status === "player_turn" && (
            <div className="flex gap-2">
              <button
                onClick={handleHit}
                className="flex-1 px-4 py-3 bg-yellow-500 text-white font-bold rounded-lg hover:bg-yellow-600 active:scale-95 transition-all shadow-lg"
              >
                👆 HIT
              </button>
              <button
                onClick={handleStand}
                className="flex-1 px-4 py-3 bg-blue-500 text-white font-bold rounded-lg hover:bg-blue-600 active:scale-95 transition-all shadow-lg"
              >
                ✋ STAND
              </button>
              {gameState.playerHand.length === 2 &&
                gameState.playerChips >= gameState.currentBet && (
                  <button
                    onClick={handleDouble}
                    className="flex-1 px-4 py-3 bg-purple-500 text-white font-bold rounded-lg hover:bg-purple-600 active:scale-95 transition-all shadow-lg"
                  >
                    💎 DOUBLE
                  </button>
                )}
            </div>
          )}

          {/* Dealer playing indicator */}
          {gameState.status === "dealer_turn" && (
            <InnerPanel className="bg-gray-100 p-3 text-center border-2 border-gray-400">
              <div className="text-base font-bold text-gray-700">
                Dealer is playing...
              </div>
            </InnerPanel>
          )}

          {/* Result */}
          {gameState.status === "gameover" && (
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
                      : gameState.lastResult === "push"
                        ? `Push — bet returned. Stack: ${gameState.playerChips} chips.`
                        : gameState.lastNetChips > 0
                          ? `+${gameState.lastNetChips} chips! Stack: ${gameState.playerChips}.`
                          : `${gameState.lastNetChips} chips. Stack: ${gameState.playerChips}.`}
                </div>
              </InnerPanel>

              {/* Score breakdown */}
              <InnerPanel className="bg-purple-100 p-3 border-2 border-purple-400">
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div>
                    <div className="text-xs font-semibold text-gray-600">
                      YOUR HAND
                    </div>
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
                    <div className="text-xs font-semibold text-gray-600">
                      DEALER HAND
                    </div>
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
            </div>
          )}
        </div>
      </div>
    </OuterPanel>
  );
};
