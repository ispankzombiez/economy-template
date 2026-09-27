/* eslint-disable react/jsx-no-literals, react/no-unescaped-entities */
import React, { useContext, useMemo, useReducer, useState } from "react";
import { useSelector } from "../adapters/useSelector";
import {
  Card,
  PokerGameState,
  BetAmount,
  BET_AMOUNTS,
  EvaluatedHand,
} from "./types";
import { HouseAI } from "./houseAI";
import { evaluateHand, compareHands } from "./evaluateHand";
import { PokerDeck } from "./deck";
import { OuterPanel, InnerPanel } from "components/ui/Panel";
import { Label } from "components/ui/Label";
import { SquareIcon } from "components/ui/SquareIcon";
import { ITEM_DETAILS } from "../adapters/itemDetails";
import { startAttempt, submitScore } from "../adapters/portalUtil";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import { useRewardRun } from "../adapters/rewardRun";
import { ConfirmPanel } from "../adapters/ConfirmPanel";
import { useVipAccess } from "../adapters/useVipAccess";
import {
  getPokerDifficulty,
  POKER_MAX_HANDS,
  POKER_RAVEN_COIN_REWARD,
  POKER_STARTING_CHIPS,
  PokerMode,
  isRewardRunAvailable,
} from "./session";

// Reducer for game state
const initialGameState: PokerGameState = {
  status: "idle",
  playerHand: [],
  playerChips: 0,
  houseHand: [],
  communityCards: [],
  initialBetAmount: 0,
  currentBet: 0,
  potAmount: 0,
  playerBetAmount: 0,
  houseBetAmount: 0,
  totalPlayerBetAcrossGame: 0,
  totalHouseBetAcrossGame: 0,
  playerEvalHand: null,
  houseEvalHand: null,
  lastWinner: null,
  lastWinAmount: 0,
  gameNumber: 0,
  totalWinnings: 0,
  totalLosses: 0,
};

const _portalState = (state: PortalMachineState) => state.context.state;

const createInitialGameState = (startingChips: number): PokerGameState => ({
  ...initialGameState,
  playerChips: startingChips,
});

const pokerPanelClassName =
  "mx-auto w-[min(96vw,1100px)] h-[min(92vh,860px)] overflow-hidden";

type GameAction =
  | { type: "START_GAME"; startingChips: number }
  | { type: "PLACE_BET"; amount: BetAmount }
  | { type: "DEAL_HOLE_CARDS"; playerHand: Card[]; houseHand: Card[] }
  | { type: "PLAYER_ACTION"; action: "bet" | "check" | "fold" }
  | { type: "HOUSE_ACTION"; action: "call" | "check" | "fold"; amount?: number }
  | { type: "RESET_STREET_BETS" }
  | { type: "DEAL_FLOP"; cards: Card[] }
  | { type: "DEAL_RIVER"; cards: Card[] }
  | { type: "SHOW_CARDS" }
  | {
      type: "GAME_OVER";
      winner: "player" | "house" | "tie";
      winAmount: number;
      playerEvalHand?: EvaluatedHand;
      houseEvalHand?: EvaluatedHand;
    }
  | { type: "PLAY_AGAIN"; startingChips: number };

function gameReducer(
  state: PokerGameState,
  action: GameAction,
): PokerGameState {
  switch (action.type) {
    case "START_GAME":
      return {
        ...state,
        status: "betting",
        gameNumber: state.gameNumber + 1,
        playerHand: [],
        houseHand: [],
        communityCards: [],
        potAmount: 0,
        playerBetAmount: 0,
        houseBetAmount: 0,
        totalPlayerBetAcrossGame: 0,
        totalHouseBetAcrossGame: 0,
        currentBet: 0,
        playerChips: action.startingChips,
        playerEvalHand: null,
        houseEvalHand: null,
        lastWinner: null,
        lastWinAmount: 0,
      };

    case "PLACE_BET":
      return {
        ...state,
        playerChips: state.playerChips - action.amount,
        potAmount: state.potAmount + action.amount,
        playerBetAmount: action.amount,
        totalPlayerBetAcrossGame:
          state.totalPlayerBetAcrossGame + action.amount,
        initialBetAmount: action.amount,
        currentBet: action.amount,
      };

    case "DEAL_HOLE_CARDS":
      return {
        ...state,
        playerHand: action.playerHand,
        houseHand: action.houseHand,
        status: "preflop_betting",
      };

    case "PLAYER_ACTION":
      if (action.action === "fold") {
        return { ...state, status: "gameover" };
      }

      if (action.action === "bet") {
        // Player bets - must bet their total accumulated so far
        const betAmount = state.totalPlayerBetAcrossGame;
        return {
          ...state,
          playerChips: state.playerChips - betAmount,
          potAmount: state.potAmount + betAmount,
          playerBetAmount: betAmount,
          totalPlayerBetAcrossGame: state.totalPlayerBetAcrossGame + betAmount,
        };
      }

      if (action.action === "check") {
        // Player checks - stays in without additional bet
        return state;
      }

      return state;

    case "HOUSE_ACTION":
      if (action.action === "fold") {
        return { ...state, status: "gameover" };
      }

      if (action.action === "check" || action.action === "call") {
        // House calls with specified amount, or checks (amount = 0)
        const amount = action.amount ?? 0;
        if (amount > 0) {
          return {
            ...state,
            potAmount: state.potAmount + amount,
            houseBetAmount: amount,
            totalHouseBetAcrossGame: state.totalHouseBetAcrossGame + amount,
          };
        }
        return state;
      }

      return state;

    case "RESET_STREET_BETS":
      return {
        ...state,
        currentBet: 0,
        playerBetAmount: 0,
        houseBetAmount: 0,
      };

    case "DEAL_FLOP":
      return {
        ...state,
        communityCards: action.cards,
        status: "postflop_betting",
        currentBet: 0,
        playerBetAmount: 0,
        houseBetAmount: 0,
      };

    case "DEAL_RIVER":
      return {
        ...state,
        communityCards: [...state.communityCards, ...action.cards],
        status: "showdown",
        currentBet: 0,
        playerBetAmount: 0,
        houseBetAmount: 0,
      };

    case "SHOW_CARDS":
      return { ...state, status: "showdown" };

    case "GAME_OVER": {
      const winnings = action.winner === "house" ? 0 : action.winAmount;
      return {
        ...state,
        status: "gameover",
        playerChips: state.playerChips + winnings,
        playerEvalHand: action.playerEvalHand ?? null,
        houseEvalHand: action.houseEvalHand ?? null,
        lastWinner: action.winner,
        lastWinAmount: action.winAmount,
        totalWinnings:
          state.totalWinnings +
          (action.winner === "player" ? action.winAmount : 0),
        totalLosses:
          state.totalLosses +
          (action.winner === "house" ? action.winAmount : 0),
      };
    }

    case "PLAY_AGAIN":
      return {
        ...initialGameState,
        totalWinnings: state.totalWinnings,
        totalLosses: state.totalLosses,
        playerChips: action.startingChips,
        lastWinner: null,
        lastWinAmount: 0,
      };

    default:
      return state;
  }
}

interface PokerGameProps {
  initialChips?: number;
  onClose?: () => void;
}

export const PokerGame: React.FC<PokerGameProps> = ({
  initialChips = 100,
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState, type: "full" });
  const [gameState, dispatch] = useReducer(
    gameReducer,
    initialChips,
    createInitialGameState,
  );
  const [deck, setDeck] = useState<PokerDeck | null>(null);
  const [selectedBet, setSelectedBet] = useState<BetAmount>(10);
  const houseAI = useMemo(() => new HouseAI(), []);
  const [rewardRunStarted, setRewardRunStarted] = useState(false);
  const [rewardGranted, setRewardGranted] = useState(false);
  const [sessionMode, setSessionMode] = useState<PokerMode | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const pokerDifficulty = useMemo(() => getPokerDifficulty(), []);
  const targetChips = pokerDifficulty.targetChips;

  const realChips = useMemo(
    () => initialChips || POKER_STARTING_CHIPS,
    [initialChips],
  );

  const handsPlayed = gameState.gameNumber;
  const handsRemaining = Math.max(POKER_MAX_HANDS - handsPlayed, 0);
  const chipsToGoal = Math.max(targetChips - gameState.playerChips, 0);
  const sessionWon = gameState.playerChips >= targetChips;
  const isResultsStage =
    gameState.status === "showdown" || gameState.status === "gameover";
  const sessionLost =
    gameState.status === "gameover" &&
    !sessionWon &&
    (gameState.playerChips <= 0 || handsPlayed >= POKER_MAX_HANDS);
  const sessionComplete = sessionWon || sessionLost;
  const canAdvanceToNextHand =
    gameState.status === "gameover" && !sessionComplete;

  const handleSessionExit = () => {
    // Finished: leave the arcade outright. A half-finished run asks first —
    // in-game, because `window.confirm` is auto-dismissed in this iframe.
    if (sessionComplete) {
      setShowRules(false);
      onClose?.();
      return;
    }

    setConfirmExit(true);
  };

  /**
   * The "are you sure?" box, built once and rendered by **every** screen.
   *
   * This has to be shared across branches: `handleSessionExit` is reachable from
   * the betting screen's ✕ as well as the in-hand and results screens, but each
   * screen is its own early `return`. When the confirm only existed in the main
   * branch, pressing ✕ on the betting screen set the flag and rendered nothing —
   * a dead button that left the player stuck in the cabinet with a paid run
   * still open (and its Play Ticket already spent).
   */
  const sessionExitConfirm = confirmExit ? (
    <ConfirmPanel
      title="EXIT POKER?"
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

  const startHand = (startingChips: number) => {
    const newDeck = new PokerDeck();
    setDeck(newDeck);
    dispatch({ type: "START_GAME", startingChips });
  };

  const startGame = (mode: PokerMode) => {
    setSessionMode(mode);
    startHand(realChips);
  };

  // Free run first, then 1 burned Play Ticket per attempt — with the "are you
  // sure?" box in between. `isRewardRunAvailable` is kept as the availability
  // check so the button and the store can never disagree.
  const hasRewardRun = useMemo(
    () => isRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );
  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "poker",
    isVip,
    portalService,
    startRewardRun: () => startGame("reward"),
  });

  const startPracticeSession = () => {
    setRewardRunStarted(false);
    setRewardGranted(false);
    dispatch({ type: "PLAY_AGAIN", startingChips: realChips });
    startHand(realChips);
  };

  const renderRulesButton = () => (
    <div className="absolute right-4 top-4 z-20">
      <button
        type="button"
        onClick={() => setShowRules((current) => !current)}
        className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-gray-700 bg-white text-sm font-bold text-gray-800 shadow"
      >
        i
      </button>

      {showRules && (
        <InnerPanel className="absolute right-0 mt-2 w-72 border-2 border-gray-700 bg-white p-3 text-left shadow-lg">
          <div className="text-xs font-bold uppercase tracking-wide text-gray-700">
            Poker Rules
          </div>
          <div className="mt-2 space-y-2 text-xs text-gray-800">
            <p>
              Pick Reward Run when you want to spend today's reward attempt.
              Pick Practice Mode when you want to play without spending it.
            </p>
            <p>
              Today's shared table is {pokerDifficulty.label}. Start with{" "}
              {POKER_STARTING_CHIPS} chips and reach {targetChips} chips within{" "}
              {POKER_MAX_HANDS} hands.
            </p>
            <p>
              Daily difficulty pool: Easy 200, Medium 500, Hard 750, Expert
              1000.
            </p>
            <p>
              Medium and Hard are weighted to appear a little more often than
              Easy and Expert, but the selected table is the same for everyone
              each UTC day.
            </p>
            <p>
              Each hand uses Texas Hold'em rules against the house. Best 5-card
              hand wins the pot.
            </p>
            <p>
              Reward runs award {POKER_RAVEN_COIN_REWARD} RavenCoin on a
              successful clear. Practice runs never award RavenCoin.
            </p>
          </div>
        </InnerPanel>
      )}
    </div>
  );

  const placeBet = () => {
    dispatch({ type: "PLACE_BET", amount: selectedBet });

    if (sessionMode === "reward" && !rewardRunStarted) {
      portalService.send({ type: "arcadeMinigame.started", name: "poker" });
      startAttempt();
      setRewardRunStarted(true);
    }

    // Deal hole cards
    if (deck) {
      const playerHand = [deck.deal(), deck.deal()];
      const houseHand = [deck.deal(), deck.deal()];
      dispatch({
        type: "DEAL_HOLE_CARDS",
        playerHand,
        houseHand,
      });

      // House automatically matches the initial bet
      setTimeout(() => {
        dispatch({ type: "HOUSE_ACTION", action: "call", amount: selectedBet });
      }, 500);
    }
  };

  const handlePlayerAction = (action: "bet" | "check" | "fold") => {
    if (action === "fold") {
      dispatch({ type: "PLAYER_ACTION", action });

      // Fold: Player loses all chips they've bet so far
      dispatch({
        type: "GAME_OVER",
        winner: "house",
        winAmount: gameState.potAmount,
      });
      return;
    }

    // Pre-calculate how much the player will bet (before dispatch)
    // In cumulative system: player bets their total accumulated so far
    const amountPlayerWillBet =
      action === "bet" ? gameState.totalPlayerBetAcrossGame : 0;

    // Calculate the new pot amount based on the action
    const potAfterPlayerAction = gameState.potAmount + amountPlayerWillBet;

    dispatch({ type: "PLAYER_ACTION", action });

    // No inventory deduction needed for portal version - tracking handled by parent

    // After player checks/bets, house responds
    setTimeout(() => {
      const streetIndex =
        gameState.status === "preflop_betting"
          ? 0
          : gameState.status === "postflop_betting"
            ? 1
            : 2;

      const houseDecision = houseAI.decideBetAction(
        gameState.houseHand,
        gameState.communityCards,
        potAfterPlayerAction, // Use calculated pot, not stale gameState
        gameState.currentBet,
        realChips,
        streetIndex,
      );

      if (houseDecision === "fold") {
        dispatch({
          type: "GAME_OVER",
          winner: "player",
          winAmount: potAfterPlayerAction,
        });
        return;
      }

      // House responds - call if player bet, check if player checked
      const houseAction = action === "bet" ? "call" : "check";
      const houseAmount = action === "bet" ? amountPlayerWillBet : 0;
      dispatch({
        type: "HOUSE_ACTION",
        action: houseAction,
        amount: houseAmount,
      });

      // After house acts, move to next street or showdown
      setTimeout(() => {
        if (gameState.status === "preflop_betting") {
          // Deal flop
          if (deck) {
            const flopCards = [deck.deal(), deck.deal(), deck.deal()];
            dispatch({ type: "DEAL_FLOP", cards: flopCards });
          }
        } else if (gameState.status === "postflop_betting") {
          // Deal turn and river, then evaluate (no more betting)
          if (deck) {
            const riverCards = [deck.deal(), deck.deal()];
            dispatch({ type: "DEAL_RIVER", cards: riverCards });

            // After river is dealt, evaluate hands
            setTimeout(() => {
              // Combine flop (in gameState.communityCards) + river (riverCards we just dealt)
              const allCommunityCards =
                gameState.communityCards.concat(riverCards);
              const allPlayerCards =
                gameState.playerHand.concat(allCommunityCards);
              const allHouseCards =
                gameState.houseHand.concat(allCommunityCards);

              const playerEval = evaluateHand(allPlayerCards.slice(0, 5));
              const houseEval = evaluateHand(allHouseCards.slice(0, 5));

              let winner: "player" | "house" | "tie" = "tie";
              const comparison = compareHands(
                allPlayerCards.slice(0, 5),
                allHouseCards.slice(0, 5),
              );
              if (comparison > 0) {
                winner = "player";
              } else if (comparison < 0) {
                winner = "house";
              }

              // Calculate final pot amount (after house matches)
              const potAfterHouseAction =
                potAfterPlayerAction +
                (action === "bet" ? amountPlayerWillBet : 0);
              const nextPlayerChips =
                gameState.playerChips +
                (winner === "house" ? 0 : potAfterHouseAction);
              const wonSession = nextPlayerChips >= targetChips;
              const endedSession =
                wonSession ||
                nextPlayerChips <= 0 ||
                gameState.gameNumber >= POKER_MAX_HANDS;

              setTimeout(() => {
                if (sessionMode === "reward" && endedSession) {
                  submitScore({ score: Math.max(nextPlayerChips, 0) });

                  if (wonSession && !rewardGranted) {
                    portalService.send({
                      type: "arcadeMinigame.ravenCoinWon",
                      amount: POKER_RAVEN_COIN_REWARD,
                    });
                    setRewardGranted(true);
                  }
                }

                dispatch({
                  type: "GAME_OVER",
                  winner,
                  winAmount: potAfterHouseAction,
                  playerEvalHand: playerEval,
                  houseEvalHand: houseEval,
                });
              }, 1500);
            }, 800);
          }
        }
      }, 800);
    }, 500);
  };

  if (gameState.status === "idle") {
    return (
      <OuterPanel className={pokerPanelClassName}>
        <div className="relative flex h-full flex-col gap-6 overflow-y-auto p-6">
          {renderRulesButton()}
          <div className="flex flex-col items-center text-center">
            <h2 className="text-4xl font-bold mb-2">♠ POKER ♠</h2>
            <div className="flex justify-center w-full">
              <Label type="info" className="mx-auto text-center">
                Choose Your Mode
              </Label>
            </div>
            <div className="mt-2 text-xs font-semibold uppercase tracking-wide text-gray-600">
              <div className="text-2xl font-bold text-yellow-700">
                {targetChips}
              </div>
            </div>
          </div>

          <InnerPanel className="bg-yellow-100 p-4">
            <div className="grid grid-cols-4 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  REWARD
                </div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-yellow-700">
                  {POKER_RAVEN_COIN_REWARD}
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
                  {POKER_MAX_HANDS}
                </div>
              </div>
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
            <div>🎯 START REWARD RUN</div>
            <div className="mt-2 text-xs opacity-90">
              {!hasRewardRun
                ? "No reward runs left today — buy Play Tickets in the shop."
                : rewardRun.freeAvailable
                  ? isVip
                    ? "VIP: reward run available for poker today."
                    : "Reward run available for the arcade today."
                  : `Uses 1 Play Ticket (you have ${rewardRun.tickets}).`}
            </div>
          </button>

          <button
            onClick={() => startGame("practice")}
            className="w-full px-6 py-4 bg-blue-500 text-white font-bold rounded-lg hover:bg-blue-600 active:scale-95 transition-all shadow-lg text-lg"
          >
            <div>🃏 START PRACTICE MODE</div>
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

          {sessionExitConfirm}
        </div>
      </OuterPanel>
    );
  }

  if (gameState.status === "betting" && gameState.playerHand.length === 0) {
    return (
      <OuterPanel className={pokerPanelClassName}>
        <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
          <div className="text-center">
            <h2 className="text-3xl font-bold">PLACE YOUR BET</h2>
            <div className="text-xs uppercase tracking-wide text-gray-500 mt-1">
              Hand {handsPlayed} of {POKER_MAX_HANDS}
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
                <div className="text-sm text-gray-700 font-semibold">MODE</div>
                <div className="text-lg font-bold text-yellow-700">
                  {sessionMode === "reward" ? "Reward" : "Practice"}
                </div>
              </div>
            </div>
          </InnerPanel>

          {/* Bet Selection */}
          <div>
            <div className="text-center font-bold mb-3 text-gray-800">
              SELECT BET AMOUNT
            </div>
            <div className="grid grid-cols-3 gap-2">
              {BET_AMOUNTS.map((amount) => (
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

          <div className="flex gap-3 h-14">
            <button
              onClick={placeBet}
              disabled={gameState.playerChips < selectedBet}
              className="flex-1 px-6 py-3 bg-green-500 text-white font-bold rounded-lg hover:bg-green-600 active:scale-95 transition-all shadow-lg disabled:bg-gray-400 disabled:cursor-not-allowed text-lg"
            >
              ✓ DEAL IN
            </button>
            {onClose && (
              <button
                onClick={handleSessionExit}
                className="px-6 py-3 bg-gray-400 text-white font-bold rounded-lg hover:bg-gray-500 active:scale-95 transition-all"
              >
                ✕
              </button>
            )}
          </div>

          {sessionExitConfirm}
        </div>
      </OuterPanel>
    );
  }

  // Card display component with custom suit images
  const CardDisplay = ({
    card,
    hidden = false,
  }: {
    card?: Card;
    hidden?: boolean;
  }) => {
    const cardSizeClass = isResultsStage ? "w-12 h-[4.5rem]" : "w-16 h-24";
    const centerRankClass = isResultsStage ? "text-lg" : "text-2xl";
    const iconWidth = isResultsStage ? 8 : 10;

    if (hidden) {
      return (
        <div
          className={`${cardSizeClass} bg-gradient-to-br from-red-600 to-red-800 border-2 border-red-900 rounded-lg flex items-center justify-center font-bold text-white ${isResultsStage ? "text-lg" : "text-2xl"} shadow-lg`}
        >
          🎴
        </div>
      );
    }
    if (!card) {
      return <div className={cardSizeClass} />;
    }

    const suitImages: Record<string, string> = {
      Kale: ITEM_DETAILS.Kale.image,
      Barley: ITEM_DETAILS.Barley.image,
      Wheat: ITEM_DETAILS.Wheat.image,
      Radish: ITEM_DETAILS.Radish.image,
    };

    return (
      <div
        className={`${cardSizeClass} bg-white border-2 border-black rounded-lg shadow-lg overflow-hidden relative`}
      >
        <div className="absolute top-1 left-1 z-10">
          <SquareIcon icon={suitImages[card.suit]} width={iconWidth} />
        </div>
        <div className="absolute bottom-1 right-1 z-10 rotate-180">
          <SquareIcon icon={suitImages[card.suit]} width={iconWidth} />
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

  return (
    <OuterPanel className={pokerPanelClassName}>
      <div
        className={`relative flex h-full flex-col overflow-y-auto p-4 sm:p-6 ${isResultsStage ? "gap-2 sm:gap-3" : "gap-3 sm:gap-4"}`}
      >
        {renderRulesButton()}
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
              {Math.max(handsPlayed, 1)}/{POKER_MAX_HANDS}
            </span>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500">
              Mode
            </div>
            <span className="text-2xl font-bold text-purple-700">
              {sessionMode === "reward" ? "Reward" : "Practice"}
            </span>
          </div>
        </div>

        <InnerPanel
          className={`bg-yellow-50 text-center border border-yellow-300 ${isResultsStage ? "p-2" : "p-3"}`}
        >
          <div className="text-sm font-semibold text-gray-800">
            {chipsToGoal > 0
              ? `${chipsToGoal} chips to go before you clear the table.`
              : "Goal reached. Finish the hand to lock in the win."}
          </div>
          <div className="text-xs text-gray-600 mt-1">
            {handsRemaining > 0
              ? `${handsRemaining} hand${handsRemaining === 1 ? "" : "s"} remaining after this one.`
              : "This is your final hand."}
          </div>
        </InnerPanel>

        <InnerPanel
          className={`bg-gray-700 text-white ${isResultsStage ? "p-2" : "p-4"}`}
        >
          <div
            className={`text-center font-bold ${isResultsStage ? "mb-1 text-sm" : "mb-2"}`}
          >
            🏠 HOUSE
          </div>
          <div
            className={`flex justify-center ${isResultsStage ? "gap-1 mb-1" : "gap-2 mb-2"}`}
          >
            {gameState.houseHand.map((card, i) => (
              <CardDisplay
                key={i}
                card={card}
                hidden={
                  gameState.status !== "showdown" &&
                  gameState.status !== "gameover"
                }
              />
            ))}
          </div>
        </InnerPanel>

        <InnerPanel
          className={`bg-green-700 ${isResultsStage ? "p-2" : "p-4"}`}
        >
          <div
            className={`text-center text-white font-bold ${isResultsStage ? "mb-1 text-sm" : "mb-2"}`}
          >
            🎯 COMMUNITY CARDS
          </div>
          <div
            className={`flex justify-center flex-wrap ${isResultsStage ? "gap-1" : "gap-2"}`}
          >
            {[0, 1, 2, 3, 4].map((i) => {
              const card = gameState.communityCards[i];
              // Cards are revealed as they're added
              if (i < gameState.communityCards.length) {
                return <CardDisplay key={i} card={card} />;
              }
              // Show faced-down cards for unrevealed community cards
              return (
                <div
                  key={i}
                  className={`${isResultsStage ? "w-12 h-[4.5rem] text-lg" : "w-16 h-24 text-2xl"} bg-gradient-to-br from-red-600 to-red-800 border-2 border-red-900 rounded-lg flex items-center justify-center font-bold text-white shadow-lg`}
                >
                  🎴
                </div>
              );
            })}
          </div>
          <div
            className={`text-center text-white font-bold ${isResultsStage ? "mt-2 text-base" : "mt-3 text-lg"}`}
          >
            Pot: {gameState.potAmount}
          </div>
        </InnerPanel>

        <InnerPanel
          className={`bg-blue-700 text-white border-4 border-yellow-400 ${isResultsStage ? "p-2" : "p-4"}`}
        >
          <div
            className={`text-center font-bold ${isResultsStage ? "mb-1 text-sm" : "mb-2"}`}
          >
            👤 YOUR HAND
          </div>
          <div
            className={`flex justify-center ${isResultsStage ? "gap-1 mb-1" : "gap-2 mb-2"}`}
          >
            {gameState.playerHand.map((card, i) => (
              <CardDisplay key={i} card={card} />
            ))}
          </div>
        </InnerPanel>

        <InnerPanel
          className={`bg-yellow-100 text-center ${isResultsStage ? "p-2" : "p-3"}`}
        >
          <div className="text-sm font-bold text-gray-700">
            {gameState.status === "preflop_betting"
              ? "🎰 PREFLOP - YOUR ACTION"
              : gameState.status === "postflop_betting"
                ? "🎯 FLOP - YOUR ACTION"
                : gameState.status === "showdown"
                  ? "🏁 SHOWDOWN"
                  : sessionComplete
                    ? "✅ SESSION COMPLETE"
                    : "🃏 HAND COMPLETE"}
          </div>
        </InnerPanel>

        <div
          className={`min-h-20 flex flex-col ${isResultsStage ? "gap-1.5" : "gap-2"}`}
        >
          {(gameState.status === "preflop_betting" ||
            gameState.status === "postflop_betting") && (
            <div className="flex gap-2 flex-1">
              <button
                onClick={() => handlePlayerAction("bet")}
                disabled={
                  gameState.playerChips < gameState.totalPlayerBetAcrossGame
                }
                className="flex-1 px-4 py-3 bg-yellow-500 text-white font-bold rounded-lg hover:bg-yellow-600 active:scale-95 transition-all shadow-lg disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                💰 BET ({gameState.totalPlayerBetAcrossGame})
              </button>
              <button
                onClick={() => handlePlayerAction("check")}
                className="flex-1 px-4 py-3 bg-blue-500 text-white font-bold rounded-lg hover:bg-blue-600 active:scale-95 transition-all shadow-lg"
              >
                ✓ CHECK
              </button>
              <button
                onClick={() => handlePlayerAction("fold")}
                className="flex-1 px-4 py-3 bg-red-500 text-white font-bold rounded-lg hover:bg-red-600 active:scale-95 transition-all shadow-lg"
              >
                ✕ FOLD
              </button>
            </div>
          )}

          {gameState.status === "showdown" && (
            <InnerPanel className="bg-purple-100 p-3 text-center border-2 border-purple-400">
              <div className="text-base font-bold text-purple-800">
                Evaluating hands...
              </div>
            </InnerPanel>
          )}

          {gameState.status === "gameover" && (
            <div className="flex flex-col gap-2">
              <InnerPanel
                className={`p-3 text-center ${
                  sessionWon || gameState.lastWinner === "player"
                    ? "bg-green-100 border-2 border-green-500"
                    : gameState.lastWinner === "tie"
                      ? "bg-yellow-100 border-2 border-yellow-500"
                      : "bg-red-100 border-2 border-red-500"
                }`}
              >
                <div className="text-xl font-bold">
                  {sessionWon
                    ? sessionMode === "reward"
                      ? "🎉 JACKPOT!"
                      : "🎯 PRACTICE CLEAR"
                    : gameState.lastWinner === "player"
                      ? "🎉 HAND WON"
                      : gameState.lastWinner === "tie"
                        ? "🤝 PUSH"
                        : sessionLost
                          ? "💥 RUN OVER"
                          : "💥 HAND LOST"}
                </div>
                <div className="mt-1 text-xs sm:text-sm text-gray-700">
                  {sessionWon
                    ? sessionMode === "reward"
                      ? `You reached ${gameState.playerChips} chips and earned ${POKER_RAVEN_COIN_REWARD} RavenCoin.`
                      : `You reached ${gameState.playerChips} chips in practice mode. No RavenCoin is awarded in practice.`
                    : sessionLost
                      ? `You finished with ${gameState.playerChips} chips after ${handsPlayed} hand${handsPlayed === 1 ? "" : "s"}.`
                      : `Current stack: ${gameState.playerChips} chips. ${handsRemaining} hand${handsRemaining === 1 ? "" : "s"} left.`}
                </div>
              </InnerPanel>

              {gameState.playerEvalHand && gameState.houseEvalHand && (
                <InnerPanel className="bg-purple-100 p-3 border-2 border-purple-400">
                  <div className="grid grid-cols-2 gap-2 text-center">
                    <div>
                      <div className="text-xs font-semibold text-gray-600">
                        YOUR HAND
                      </div>
                      <div className="text-base font-bold text-purple-800">
                        {gameState.playerEvalHand.rankingName}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-gray-600">
                        HOUSE HAND
                      </div>
                      <div className="text-base font-bold text-purple-800">
                        {gameState.houseEvalHand.rankingName}
                      </div>
                    </div>
                  </div>
                </InnerPanel>
              )}

              {canAdvanceToNextHand && (
                <button
                  onClick={() => startHand(gameState.playerChips)}
                  className="w-full px-4 py-2.5 bg-green-500 text-white font-bold rounded-lg hover:bg-green-600 active:scale-95 transition-all shadow-lg"
                >
                  🔄 NEXT HAND
                </button>
              )}

              {sessionComplete && sessionMode === "practice" && (
                <button
                  onClick={startPracticeSession}
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
                  {sessionComplete ? "EXIT POKER" : "BACK TO ARCADE"}
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
