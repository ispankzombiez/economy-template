/* eslint-disable react/jsx-no-literals, react/no-unescaped-entities */
import React, {
  useCallback,
  useContext,
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
import { useVipAccess } from "../adapters/useVipAccess";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import { Card, CardRank } from "../poker/types";
import {
  GO_FISH_RAVEN_COIN_REWARD,
  GoFishMode,
  isGoFishRewardRunAvailable,
} from "./session";
// The rules live in engine.ts — the same module the worker's replay imports —
// so this component is a view over one implementation, never a second one.
import {
  askForRank as applyAskForRank,
  createInitialState,
  groupCardsByRank,
  RANK_ORDER,
  type GoFishState,
} from "./engine";
import {
  encodeGoFishActionLog,
  encodeGoFishLog,
  MAX_GO_FISH_ACTIONS,
} from "@nightshade/shared/anticheat/goFishLog";
import type { VerifiedRun } from "lib/portal/api";

const goFishPanelClassName =
  "mx-auto w-full max-w-[1100px] h-[min(92vh,860px)] overflow-hidden";

const suitImages: Record<string, string> = {
  Kale: ITEM_DETAILS.Kale.image,
  Barley: ITEM_DETAILS.Barley.image,
  Wheat: ITEM_DETAILS.Wheat.image,
  Radish: ITEM_DETAILS.Radish.image,
};

const _portalState = (state: PortalMachineState) => state.context.state;

interface GoFishGameProps {
  onClose?: () => void;
}

export const GoFishGame: React.FC<GoFishGameProps> = ({ onClose }) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState, type: "full" });

  const [sessionMode, setSessionMode] = useState<GoFishMode | null>(null);
  const [gameState, setGameState] = useState<GoFishState | null>(null);
  const [rewardRunStarted, setRewardRunStarted] = useState(false);
  const [rewardSubmitted, setRewardSubmitted] = useState(false);
  const [rewardGranted, setRewardGranted] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);

  /**
   * The run's proof, captured as it happens rather than reconstructed after.
   *
   * `moveLogRef` holds every ask the engine actually applied (an ask the
   * engine refuses logs nothing — the component only appends when the state
   * changed), `runSeedRef` the seed the deck was shuffled from, and
   * `runStartedAtRef` when the session opened. The claim is built from these
   * at the moment the game ends; see `completeRewardIfNeeded`.
   */
  const moveLogRef = useRef<number[]>([]);
  const runSeedRef = useRef<number | null>(null);
  const runStartedAtRef = useRef<number>(0);

  const getRunSeed = useCallback(() => {
    return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  }, []);

  const returnToMenu = useCallback(() => {
    setShowQuitConfirm(false);
    setSessionMode(null);
    setGameState(null);
    moveLogRef.current = [];
    runSeedRef.current = null;
  }, []);

  const hasRewardRun = useMemo(
    () => isGoFishRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const startSession = useCallback(
    (mode: GoFishMode) => {
      const seed = getRunSeed();

      setSessionMode(mode);
      setRewardSubmitted(false);
      setRewardGranted(false);
      moveLogRef.current = [];
      // The seed the deck is actually dealt from: Go Fish has no difficulty
      // walk (no solver search to walk forward from a base seed like
      // Solitaire's), so this seed *is* the run's — chosen here when the run
      // opens, exactly like the other two verified cabinets, and
      // server-issued for all of them together in Stage C.
      runSeedRef.current = seed;
      runStartedAtRef.current = Date.now();
      setGameState(createInitialState(seed));

      if (mode === "reward" && !rewardRunStarted) {
        portalService.send({ type: "arcadeMinigame.started", name: "gofish" });
        startAttempt();
        setRewardRunStarted(true);
      }
    },
    [getRunSeed, portalService, rewardRunStarted],
  );

  /**
   * Settle the reward run the moment the game ends — win or loss.
   *
   * This used to run from the EXIT button, which meant a player who won and
   * then closed the cabinet through the arcade chrome never claimed at all,
   * and the claim's log was built at an arbitrary moment after the proof was
   * complete. Now it fires in the same render the game reached `gameOver`,
   * following Solitaire's `completeRewardIfNeeded`: the log cannot grow past
   * the end of the game (the engine refuses every ask once it is over), so
   * the proof carried here is the whole game and nothing after it.
   *
   * The claim carries the seed and the full ask log; the worker rebuilds the
   * deal, re-applies the asks and mints only if *its* game ends in a player
   * win with the same book count. The coin is paid on proof, not assertion.
   */
  const completeRewardIfNeeded = useCallback(() => {
    if (!gameState || !gameState.gameOver || sessionMode !== "reward") {
      return;
    }

    if (!rewardSubmitted) {
      submitScore({ score: gameState.playerBooks.length });
      setRewardSubmitted(true);
    }

    if (gameState.winner !== "player" || rewardGranted) {
      return;
    }

    // A log past the codec's ceiling could not be encoded, hence not
    // verified, hence not paid — sending it would burn the reward run for a
    // claim the worker must refuse. Unreachable in honest play (a game is a
    // few dozen asks; the ceiling is 512); guarded because the failure mode
    // is a silently-unpayable reward run, not a crash.
    if (moveLogRef.current.length > MAX_GO_FISH_ACTIONS) {
      console.error("[gofish] action log exceeded the replay ceiling");
      return;
    }

    const verify: VerifiedRun = {
      cabinet: "gofish",
      score: gameState.playerBooks.length,
      // No milestones and no pace floor: Go Fish is turn-based, so the
      // brawler's wave checkpoints and duration checks have nothing to check
      // here. The action log below *is* the verification — full coverage of
      // the game rather than sampled moments of it. No difficulty either:
      // this cabinet has no daily difficulty to re-derive (its lobby "Daily"
      // label is decorative — see session.ts), so the replay names only the
      // seed and the asks.
      checkpoints: [],
      elapsedMs: Date.now() - runStartedAtRef.current,
      replay: {
        seed: runSeedRef.current ?? 0,
        actions: encodeGoFishLog(
          encodeGoFishActionLog(moveLogRef.current),
        ),
      },
    };

    portalService.send({
      type: "arcadeMinigame.ravenCoinWon",
      amount: GO_FISH_RAVEN_COIN_REWARD,
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

  // Free run first, then 1 burned Play Ticket per attempt — with the "are you
  // sure?" box in between. `isGoFishRewardRunAvailable` is kept as the
  // availability check so the button and the store can never disagree.
  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "gofish",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  /**
   * The one door every ask goes through.
   *
   * Two jobs, in the order they matter:
   *
   *  1. Ask the engine. An engine that returns its input unchanged is an
   *     illegal ask — not the player's turn, game over, or a rank the player
   *     does not hold — and the update stops there, so *nothing else runs*.
   *  2. Record the ask, but only when the state changed. An honest log
   *     therefore contains exactly the asks that happened; the worker
   *     re-applies it and treats a state-changed-nothing ask as a dead
   *     action at its index — see `replayGoFishActions`.
   */
  const askForRank = useCallback(
    (rank: CardRank) => {
      if (!gameState || gameState.turn !== "player" || gameState.gameOver) {
        return;
      }

      const next = applyAskForRank(gameState, rank);
      if (next === gameState) {
        return;
      }

      moveLogRef.current.push(RANK_ORDER.indexOf(rank));
      setGameState(next);
    },
    [gameState],
  );

  const handleExitAfterGame = useCallback(() => {
    // The claim was already built and sent the moment the game ended — see
    // `completeRewardIfNeeded`. Exiting is navigation now, not settlement,
    // so winning and closing the cabinet through the arcade chrome claims
    // the same as pressing this button.
    returnToMenu();
  }, [returnToMenu]);

  const handlePlayAgainPractice = useCallback(() => {
    if (sessionMode !== "practice") {
      return;
    }

    const seed = getRunSeed();
    runSeedRef.current = seed;
    runStartedAtRef.current = Date.now();
    moveLogRef.current = [];
    setGameState(createInitialState(seed));
    setShowQuitConfirm(false);
  }, [getRunSeed, sessionMode]);

  if (!gameState || !sessionMode) {
    return (
      <OuterPanel className={goFishPanelClassName}>
        <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
          <div className="text-center space-y-2">
            <h2 className="text-4xl font-bold">GO FISH</h2>
            <p className="text-sm text-gray-600">
              Ask for ranks you hold, make books (4-of-a-kind), and finish with
              more books than the dealer.
            </p>
          </div>

          <InnerPanel className="bg-yellow-100 p-4">
            <div className="grid grid-cols-2 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  REWARD
                </div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-yellow-700">
                  {GO_FISH_RAVEN_COIN_REWARD}
                  <img
                    src={ravenCoinIcon}
                    alt="RavenCoin"
                    className="w-6 h-6"
                  />
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">MODE</div>
                <div className="text-2xl font-bold text-yellow-700">Daily</div>
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
            <div>START REWARD RUN</div>
            <div className="mt-2 text-xs opacity-90">
              {!hasRewardRun
                ? "No reward runs left today — buy Play Tickets in the shop."
                : rewardRun.freeAvailable
                  ? isVip
                    ? "VIP: reward run available for Go Fish today."
                    : "Reward run available for the arcade today."
                  : `Uses 1 Play Ticket (you have ${rewardRun.tickets}).`}
            </div>
          </button>

          <button
            onClick={() => startSession("practice")}
            className="w-full px-6 py-4 bg-blue-500 text-white font-bold rounded-lg hover:bg-blue-600 active:scale-95 transition-all shadow-lg text-lg"
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
        </div>
      </OuterPanel>
    );
  }

  // Settle in the same render the game ends — Solitaire's
  // `completeRewardIfNeeded` pattern. The log cannot grow past this point
  // (the engine refuses every ask once the game is over), so the proof this
  // builds is the complete game, nothing before or after it.
  if (gameState.gameOver) {
    completeRewardIfNeeded();
  }

  const playerCardGroups = groupCardsByRank(gameState.playerHand);

  return (
    <OuterPanel className={goFishPanelClassName}>
      {/* `overflow-y-auto`, not `overflow-hidden`.

          At phone width the column below measures ~1050px of content against
          the ~710px this panel has left once its borders and padding are
          taken, and `hidden` threw the difference away instead of scrolling it:
          *Your Hand* — the only thing in this game the player taps — came out
          237px below the fold, with the game log a further 351px under that.
          Measured at a 358px viewport, so Go Fish could not be played at all.

          The panel scrolls instead, which is what Poker's, Blackjack's and
          Solitaire's already do. */}
      <InnerPanel className="relative w-full h-full p-4 md:p-5 overflow-y-auto bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
        <div className="max-w-6xl mx-auto h-full space-y-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h2 className="text-4xl font-bold leading-none">{"GO FISH"}</h2>
              <p className="text-sm text-slate-200 mt-1">
                {
                  "Ask for ranks you hold, make books (4 of a kind), and finish with more books than the dealer."
                }
              </p>
            </div>
            <div className="flex gap-2">
              {gameState.gameOver ? (
                <>
                  {sessionMode === "practice" && (
                    <Button onClick={handlePlayAgainPractice}>
                      {"PLAY AGAIN"}
                    </Button>
                  )}
                  <Button onClick={handleExitAfterGame}>{"EXIT"}</Button>
                </>
              ) : (
                <Button onClick={() => setShowQuitConfirm(true)}>
                  {"QUIT"}
                </Button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="bg-black/30 border border-white/20 p-3 rounded">
              <p className="text-xs uppercase tracking-wide text-slate-300">
                {"Mode"}
              </p>
              <p className="text-lg font-bold">
                {sessionMode === "reward" ? "Reward" : "Practice"}
              </p>
            </div>
            <div className="bg-black/30 border border-white/20 p-3 rounded">
              <p className="text-xs uppercase tracking-wide text-slate-300">
                {"Deck"}
              </p>
              <p className="text-lg font-bold">
                {gameState.deck.getRemaining()}
              </p>
            </div>
            <div className="bg-black/30 border border-white/20 p-3 rounded">
              <p className="text-xs uppercase tracking-wide text-slate-300">
                {"Your Books"}
              </p>
              <p className="text-lg font-bold">
                {gameState.playerBooks.length}
              </p>
            </div>
            <div className="bg-black/30 border border-white/20 p-3 rounded">
              <p className="text-xs uppercase tracking-wide text-slate-300">
                {"Dealer Books"}
              </p>
              <p className="text-lg font-bold">
                {gameState.dealerBooks.length}
              </p>
            </div>
          </div>

          {gameState.gameOver && (
            <div className="bg-emerald-900/30 border border-emerald-300/30 p-3 rounded text-sm">
              {gameState.winner === "tie"
                ? "Tie game."
                : gameState.winner === "player"
                  ? sessionMode === "reward"
                    ? `You win! Reward run completed for ${GO_FISH_RAVEN_COIN_REWARD} RavenCoin.`
                    : "You win!"
                  : "Dealer wins."}
            </div>
          )}

          <div className="space-y-3">
            <h3 className="font-bold text-lg">{"Dealer Hand"}</h3>
            <div className="flex flex-wrap gap-2">
              {gameState.dealerHand.map((_, index) => (
                <div
                  key={`dealer-${index}`}
                  className="w-14 h-20 border border-white/30 rounded bg-slate-700 grid place-items-center text-xs"
                >
                  {"?"}
                </div>
              ))}
              {gameState.dealerHand.length === 0 && (
                <span className="text-sm text-slate-300">
                  {"No cards in hand"}
                </span>
              )}
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="font-bold text-lg">{"Your Hand"}</h3>
            <div className="flex flex-wrap gap-2">
              {playerCardGroups.map((cardsOfRank, groupIndex) => (
                <button
                  type="button"
                  key={`player-group-${cardsOfRank[0].rank}-${groupIndex}`}
                  onClick={() => askForRank(cardsOfRank[0].rank)}
                  disabled={gameState.turn !== "player" || gameState.gameOver}
                  className={`p-0 bg-transparent ${
                    gameState.turn === "player" && !gameState.gameOver
                      ? "cursor-pointer"
                      : "cursor-not-allowed opacity-70"
                  }`}
                >
                  <div className="flex -space-x-8">
                    {cardsOfRank.map((card, cardIndex) => (
                      <div
                        key={`player-${card.suit}-${card.rank}-${groupIndex}-${cardIndex}`}
                        className="w-16 h-24 border border-white/30 rounded bg-white text-black p-1 relative"
                      >
                        <div className="absolute top-1 left-1">
                          <SquareIcon icon={suitImages[card.suit]} width={10} />
                        </div>
                        <div className="absolute bottom-1 right-1 rotate-180">
                          <SquareIcon icon={suitImages[card.suit]} width={10} />
                        </div>
                        <span className="absolute inset-0 grid place-items-center font-bold text-2xl leading-none">
                          {card.rank}
                        </span>
                      </div>
                    ))}
                  </div>
                </button>
              ))}
              {playerCardGroups.length === 0 && (
                <span className="text-sm text-slate-300">
                  {"No cards in hand"}
                </span>
              )}
            </div>
          </div>

          <div className="bg-black/40 border border-white/20 rounded p-3">
            <h3 className="font-bold text-lg mb-2">{"Game Log"}</h3>
            <div className="space-y-1 max-h-24 text-sm overflow-hidden">
              {gameState.log.slice(0, 5).map((entry, index) => (
                <p key={`log-${index}`}>{entry}</p>
              ))}
            </div>
          </div>

          {showQuitConfirm && (
            <div className="absolute inset-0 z-30 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-sm rounded border border-white/30 bg-slate-900 p-4 space-y-4">
                <h3 className="text-lg font-bold">{"Quit Go Fish?"}</h3>
                <p className="text-sm text-slate-200">
                  {
                    "Are you sure you want to quit? Current game progress will be lost."
                  }
                </p>
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setShowQuitConfirm(false)}>
                    {"CANCEL"}
                  </Button>
                  <Button onClick={() => onClose?.()}>{"QUIT"}</Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </InnerPanel>
    </OuterPanel>
  );
};
