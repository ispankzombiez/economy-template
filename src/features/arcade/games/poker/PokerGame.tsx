/* eslint-disable react/jsx-no-literals, react/no-unescaped-entities */
import React, { useContext, useMemo, useRef, useState } from "react";
import { useSelector } from "../adapters/useSelector";
import { Card, BetAmount, BET_AMOUNTS } from "./types";
// The rules live in engine.ts — the same module the worker's replay imports —
// so the cabinet and the verifier deal from one implementation. The component
// only stages it: every click applies an engine step and records the choice.
import {
  advanceStreet,
  applyPlayerChoice,
  createPokerState,
  placeBet,
  PLAYER_CHOICE_CODES,
  type PlayerChoice,
  type PokerState,
  resolveHouse,
  resolveShowdown,
  startHand,
} from "./engine";
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
import type { VerifiedRun } from "lib/portal/api";
import {
  encodePokerActionLog,
  encodePokerLog,
  MAX_POKER_ACTIONS,
  POKER_BET_AMOUNTS,
} from "@nightshade/shared/anticheat/pokerLog";
import {
  getPokerDifficulty,
  POKER_DIFFICULTIES,
  POKER_MAX_HANDS,
  POKER_RAVEN_COIN_REWARD,
  POKER_STARTING_CHIPS,
  PokerMode,
  isRewardRunAvailable,
} from "./session";

/**
 * The cabinet's staged beats, in milliseconds.
 *
 * They are the timings the showdown has always had: the house answers half a
 * second after the click, a street lands eight tenths of a second later, and
 * the river's results come 2.3 s after the board is complete (800 ms while the
 * hands are scored off-screen, then the 1.5 s beat the cabinet has always
 * given the player to read the board). The replay calls the same engine steps
 * with no clock at all — these numbers decide only when the screen changes.
 */
const HOUSE_MS = 500;
const STREET_MS = 800;
const SHOWDOWN_MS = 2300;

const _portalState = (state: PortalMachineState) => state.context.state;

const pokerPanelClassName =
  "mx-auto w-full max-w-[1100px] h-[min(92vh,860px)] overflow-hidden";

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
  const pokerDifficulty = useMemo(() => getPokerDifficulty(), []);
  const targetChips = pokerDifficulty.targetChips;

  // Display only: the stack the engine opens with is the engine's own
  // POKER_STARTING_CHIPS, because that is the number the worker rebuilds a
  // claim from — a starting stack taken from anywhere else would be one the
  // replay could not reproduce. (Exactly Blackjack's bargain, and no caller
  // passes a different value today.)
  const realChips = useMemo(
    () => initialChips || POKER_STARTING_CHIPS,
    [initialChips],
  );

  /**
   * The session, and the mirror that keeps every staged callback honest.
   *
   * `stateRef` is written in the same instant as the state (see `commit`), so
   * the half-second beats below always read the *current* hand rather than the
   * one that was on screen when the click scheduled them. The `useReducer` this
   * replaces read everything from a closure captured at click time — which is
   * how the showdown came to score a stack that predated the final bet.
   */
  const [gameState, setGameState] = useState<PokerState>(() =>
    createPokerState(0, pokerDifficulty),
  );
  const stateRef = useRef(gameState);
  const commit = (next: PokerState) => {
    stateRef.current = next;
    setGameState(next);
  };

  /**
   * The run's proof, captured as it happens rather than reconstructed after.
   *
   * `moveLogRef` holds every hand's bet and the street choices the engine
   * actually accepted, `handLogRef` the current hand's choices (mirrored into
   * the log as they happen), `runSeedRef` the seed every shuffle came from, and
   * `runStartedAtRef` when the session opened. The claim is built from these at
   * the moment the session ends; see `completeRewardIfNeeded`.
   */
  const moveLogRef = useRef<{
    difficultyIdx: number;
    hands: { betIdx: number; actions: number[] }[];
  }>({ difficultyIdx: 0, hands: [] });
  const handLogRef = useRef<number[]>([]);
  const runSeedRef = useRef<number | null>(null);
  const runStartedAtRef = useRef(0);

  /** One street in flight at a time — see the guard in `handlePlayerAction`. */
  const resolvingRef = useRef(false);
  const [resolving, setResolving] = useState(false);

  const [selectedBet, setSelectedBet] = useState<BetAmount>(10);
  const [rewardRunStarted, setRewardRunStarted] = useState(false);
  const [rewardGranted, setRewardGranted] = useState(false);
  const [rewardSubmitted, setRewardSubmitted] = useState(false);
  const [sessionMode, setSessionMode] = useState<PokerMode | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);

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

  /**
   * Settle the run on the render where it actually ends.
   *
   * **This is the fix for the cabinet's score bug.** The showdown used to
   * settle inside its final `setTimeout` from a closure captured *before* the
   * street's last bet — so `submitScore` (and the win check) read a stack
   * inflated by exactly that street's wager whenever the player bet the last
   * street, and a won session could be scored above what the screen showed.
   * The worker replays the engine's own arithmetic, so a score the closure
   * inflated would never match: honest wins would be refused. The reducer's
   * state at this instant is the only number both ends agree on.
   */
  const completeRewardIfNeeded = () => {
    if (sessionMode !== "reward") return;
    if (gameState.status !== "gameover" || !sessionComplete) return;

    if (!rewardSubmitted) {
      submitScore({ score: Math.max(gameState.playerChips, 0) });
      setRewardSubmitted(true);
    }

    if (!sessionWon || rewardGranted) return;

    const { difficultyIdx, hands } = moveLogRef.current;
    if (hands.length === 0) {
      console.error("[poker] session ended with no hands in the replay log");
      return;
    }
    const totalActions = hands.reduce((sum, hand) => sum + hand.actions.length, 0);
    if (totalActions > MAX_POKER_ACTIONS) {
      console.error("[poker] action log exceeded the replay ceiling");
      return;
    }

    // The claim carries the seed the decks were shuffled from, today's table,
    // and every hand's bet and street choices — the whole session as replay.
    const verify: VerifiedRun = {
      cabinet: "poker",
      score: gameState.playerChips,
      checkpoints: [],
      elapsedMs: Date.now() - runStartedAtRef.current,
      replay: {
        seed: runSeedRef.current ?? 0,
        difficulty: difficultyIdx,
        actions: encodePokerLog(
          encodePokerActionLog(difficultyIdx, hands),
        ),
      },
    };

    portalService.send({
      type: "arcadeMinigame.ravenCoinWon",
      amount: POKER_RAVEN_COIN_REWARD,
      verify,
    });
    setRewardGranted(true);
  };

  // Render-time settlement (the Solitaire / Go Fish / Blackjack pattern): the
  // run's score and coin are decided from the state the engine just produced,
  // never from a stale copy of it.
  if (gameState.status === "gameover" && sessionComplete) {
    completeRewardIfNeeded();
  }

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

  /**
   * A fresh run seed: every shuffle in the session is drawn from it, and the
   * worker rebuilds each of them from it during verification — so the run's
   * proof is fixed the moment the session opens. (The idle menu's state carries
   * a placeholder seed no deck is ever dealt from.)
   */
  const newRunSeed = () =>
    (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0;

  /** Reset the run's proof for a new session, remembering today's table. */
  const openLog = (seed: number) => {
    moveLogRef.current = {
      difficultyIdx: POKER_DIFFICULTIES.findIndex(
        (difficulty) => difficulty.name === pokerDifficulty.name,
      ),
      hands: [],
    };
    handLogRef.current = [];
    runSeedRef.current = seed;
    runStartedAtRef.current = Date.now();
  };

  const startGame = (mode: PokerMode) => {
    const seed = newRunSeed();
    setSessionMode(mode);
    setRewardRunStarted(false);
    setRewardGranted(false);
    setRewardSubmitted(false);
    resolvingRef.current = false;
    setResolving(false);
    openLog(seed);
    commit(startHand(createPokerState(seed, pokerDifficulty)));
  };

  /** Between hands: a fresh deck from the same stream, chips carried over. */
  const handleNextHand = () => {
    if (resolvingRef.current) return;
    commit(startHand(stateRef.current));
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
    const seed = newRunSeed();
    setRewardRunStarted(false);
    setRewardGranted(false);
    setRewardSubmitted(false);
    resolvingRef.current = false;
    setResolving(false);
    openLog(seed);
    // PLAY_AGAIN as the reducer wrote it: a fresh session at the starting
    // stack, with the previous session's winnings and losses carried forward.
    const previous = stateRef.current;
    commit(
      startHand({
        ...createPokerState(seed, pokerDifficulty),
        totalWinnings: previous.totalWinnings,
        totalLosses: previous.totalLosses,
      }),
    );
  };

  // The button is 44x44 so a thumb can find it; the *circle* stays 28px.
  //
  // `h-7 w-7` measured 28px at a 358px viewport, which was the only sub-44px
  // control Poker had, and growing the circle itself to 44px would put it over
  // the HUD's "Mode" cell. So the circle becomes an inner span pinned to the
  // button's own top-right corner — `items-start justify-end` — which leaves it
  // at exactly the pixel it was already at, inside a 44x44 target.
  const renderRulesButton = () => (
    <div className="absolute right-4 top-4 z-20">
      <button
        type="button"
        onClick={() => setShowRules((current) => !current)}
        className="flex h-11 w-11 items-start justify-end"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full border-2 border-gray-700 bg-white text-sm font-bold text-gray-800 shadow">
          i
        </span>
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

  const handleDealIn = () => {
    const next = placeBet(stateRef.current, selectedBet);

    // Refused — the stack cannot cover it, or a second click landed between
    // the screen and React's re-render. Deal nothing, log nothing: the hand's
    // bet in the log is always one the engine took. The house's matching call
    // is part of the engine's step too, which is why no 500 ms beat follows
    // the deal any more (it was cosmetic, and the replay has no clock).
    if (next === stateRef.current) return;
    commit(next);

    // Open the hand's entry in the log: its bet, then every street choice the
    // engine accepts (mirrored as they happen in `handlePlayerAction`).
    handLogRef.current = [];
    moveLogRef.current.hands.push({
      betIdx: POKER_BET_AMOUNTS.findIndex((amount) => amount === selectedBet),
      actions: [],
    });

    if (sessionMode === "reward" && !rewardRunStarted) {
      portalService.send({ type: "arcadeMinigame.started", name: "poker" });
      startAttempt();
      setRewardRunStarted(true);
    }
  };

    const handlePlayerAction = (choice: PlayerChoice) => {
    // One street in flight at a time. The buttons stay live for the half
    // second the house "thinks", and a second click in that window would log a
    // second choice that the replay applies to a street it has already
    // advanced past — an honest double-tap would then look forged.
    if (resolvingRef.current) return;

    const before = stateRef.current;
    const move = applyPlayerChoice(before, choice);
    if (!move.applied) return;

    // The log carries a choice only when the engine took it — the exact rule
    // the replay's dead-action check depends on.
    handLogRef.current.push(PLAYER_CHOICE_CODES[choice]);
    const hands = moveLogRef.current.hands;
    if (hands.length > 0) {
      hands[hands.length - 1].actions = [...handLogRef.current];
    }

    commit(move.state);

    // A fold ends the hand at once; nothing follows it.
    if (move.handEnded) return;

    resolvingRef.current = true;
    setResolving(true);

    // The house answers...
    setTimeout(() => {
      const answer = resolveHouse(stateRef.current, choice);
      commit(answer.state);
      if (answer.handEnded) {
        resolvingRef.current = false;
        setResolving(false);
        return;
      }

      // ...the street advances...
      setTimeout(() => {
        const advanced = advanceStreet(stateRef.current);
        commit(advanced);

        if (advanced.status !== "showdown") {
          // The flop's street is open — release the buttons for the next
          // choice.
          resolvingRef.current = false;
          setResolving(false);
          return;
        }

        // ...and the river's showdown resolves once the board has been shown.
        setTimeout(() => {
          commit(resolveShowdown(stateRef.current));
          resolvingRef.current = false;
          setResolving(false);
        }, SHOWDOWN_MS);
      }, STREET_MS);
    }, HOUSE_MS);
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
              onClick={handleDealIn}
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
                  resolving ||
                  gameState.playerChips < gameState.totalPlayerBetAcrossGame
                }
                className="flex-1 px-4 py-3 bg-yellow-500 text-white font-bold rounded-lg hover:bg-yellow-600 active:scale-95 transition-all shadow-lg disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                💰 BET ({gameState.totalPlayerBetAcrossGame})
              </button>
              <button
                onClick={() => handlePlayerAction("check")}
                disabled={resolving}
                className="flex-1 px-4 py-3 bg-blue-500 text-white font-bold rounded-lg hover:bg-blue-600 active:scale-95 transition-all shadow-lg disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                ✓ CHECK
              </button>
              <button
                onClick={() => handlePlayerAction("fold")}
                disabled={resolving}
                className="flex-1 px-4 py-3 bg-red-500 text-white font-bold rounded-lg hover:bg-red-600 active:scale-95 transition-all shadow-lg disabled:bg-gray-400 disabled:cursor-not-allowed"
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
                  onClick={handleNextHand}
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
