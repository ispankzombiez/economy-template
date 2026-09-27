/* eslint-disable react/jsx-no-literals, react/no-unescaped-entities */
import React, { useCallback, useContext, useMemo, useState } from "react";
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
import { PokerDeck } from "../poker/deck";
import {
  GO_FISH_RAVEN_COIN_REWARD,
  GoFishMode,
  isGoFishRewardRunAvailable,
} from "./session";

const goFishPanelClassName =
  "mx-auto w-[min(96vw,1100px)] h-[min(92vh,860px)] overflow-hidden";

const RANK_ORDER: CardRank[] = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
  "A",
];

const suitImages: Record<string, string> = {
  Kale: ITEM_DETAILS.Kale.image,
  Barley: ITEM_DETAILS.Barley.image,
  Wheat: ITEM_DETAILS.Wheat.image,
  Radish: ITEM_DETAILS.Radish.image,
};

type Turn = "player" | "dealer";
type Winner = "player" | "dealer" | "tie";

type GoFishState = {
  deck: PokerDeck;
  playerHand: Card[];
  dealerHand: Card[];
  playerBooks: CardRank[];
  dealerBooks: CardRank[];
  turn: Turn;
  selectedRank: CardRank | null;
  log: string[];
  gameOver: boolean;
  winner: Winner | null;
};

const sortHand = (hand: Card[]): Card[] => {
  return [...hand].sort(
    (a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank),
  );
};

const getRanksInHand = (hand: Card[]): CardRank[] => {
  const seen = new Set<CardRank>();
  const ranks: CardRank[] = [];

  hand.forEach((card) => {
    if (!seen.has(card.rank)) {
      seen.add(card.rank);
      ranks.push(card.rank);
    }
  });

  return ranks.sort((a, b) => RANK_ORDER.indexOf(a) - RANK_ORDER.indexOf(b));
};

const drawCard = (deck: PokerDeck): Card | null => {
  if (deck.getRemaining() <= 0) {
    return null;
  }

  return deck.deal();
};

const extractBooks = (hand: Card[]): { books: CardRank[]; hand: Card[] } => {
  const counts = new Map<CardRank, number>();

  hand.forEach((card) => {
    counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  });

  const completed = Array.from(counts.entries())
    .filter(([, count]) => count === 4)
    .map(([rank]) => rank)
    .sort((a, b) => RANK_ORDER.indexOf(a) - RANK_ORDER.indexOf(b));

  if (completed.length === 0) {
    return { books: [], hand };
  }

  const completedSet = new Set(completed);

  return {
    books: completed,
    hand: hand.filter((card) => !completedSet.has(card.rank)),
  };
};

const removeRankCards = (
  hand: Card[],
  rank: CardRank,
): { removed: Card[]; remaining: Card[] } => {
  const removed = hand.filter((card) => card.rank === rank);
  const remaining = hand.filter((card) => card.rank !== rank);

  return { removed, remaining };
};

const groupCardsByRank = (hand: Card[]): Card[][] => {
  const grouped = new Map<CardRank, Card[]>();

  hand.forEach((card) => {
    const cards = grouped.get(card.rank) ?? [];
    cards.push(card);
    grouped.set(card.rank, cards);
  });

  return Array.from(grouped.entries())
    .sort((a, b) => RANK_ORDER.indexOf(a[0]) - RANK_ORDER.indexOf(b[0]))
    .map(([, cards]) => cards);
};

const maybeFinalizeGame = (state: GoFishState): GoFishState => {
  const totalBooks = state.playerBooks.length + state.dealerBooks.length;

  if (totalBooks < 13) {
    const noCardsLeft =
      state.deck.getRemaining() === 0 &&
      state.playerHand.length === 0 &&
      state.dealerHand.length === 0;

    if (!noCardsLeft) {
      return state;
    }
  }

  const winner: Winner =
    state.playerBooks.length > state.dealerBooks.length
      ? "player"
      : state.playerBooks.length < state.dealerBooks.length
        ? "dealer"
        : "tie";

  return {
    ...state,
    gameOver: true,
    winner,
    log: [
      `Game over. ${
        winner === "tie"
          ? "It is a tie"
          : winner === "player"
            ? "You win"
            : "Dealer wins"
      } (${state.playerBooks.length}-${state.dealerBooks.length} books).`,
      ...state.log,
    ],
  };
};

const createInitialState = (): GoFishState => {
  const deck = new PokerDeck();
  let playerHand = deck.dealMultiple(7);
  let dealerHand = deck.dealMultiple(7);

  const playerBookResult = extractBooks(playerHand);
  playerHand = playerBookResult.hand;

  const dealerBookResult = extractBooks(dealerHand);
  dealerHand = dealerBookResult.hand;

  const state: GoFishState = {
    deck,
    playerHand: sortHand(playerHand),
    dealerHand: sortHand(dealerHand),
    playerBooks: playerBookResult.books,
    dealerBooks: dealerBookResult.books,
    turn: "player",
    selectedRank: null,
    log: ["New game started. Ask the dealer for a rank you hold."],
    gameOver: false,
    winner: null,
  };

  return maybeFinalizeGame(state);
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

  const returnToMenu = useCallback(() => {
    setShowQuitConfirm(false);
    setSessionMode(null);
    setGameState(null);
  }, []);

  const settleRewardRun = useCallback(() => {
    if (!gameState || !gameState.gameOver || sessionMode !== "reward") {
      return;
    }

    if (!rewardSubmitted) {
      submitScore({ score: gameState.playerBooks.length });
      setRewardSubmitted(true);
    }

    if (gameState.winner === "player" && !rewardGranted) {
      portalService.send({
        type: "arcadeMinigame.ravenCoinWon",
        amount: GO_FISH_RAVEN_COIN_REWARD,
      });
      setRewardGranted(true);
    }
  }, [gameState, sessionMode, rewardSubmitted, rewardGranted, portalService]);

  const hasRewardRun = useMemo(
    () => isGoFishRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const startSession = useCallback(
    (mode: GoFishMode) => {
      setSessionMode(mode);
      setGameState(createInitialState());
      setRewardSubmitted(false);
      setRewardGranted(false);

      if (mode === "reward" && !rewardRunStarted) {
        portalService.send({ type: "arcadeMinigame.started", name: "gofish" });
        startAttempt();
        setRewardRunStarted(true);
      }
    },
    [portalService, rewardRunStarted],
  );

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

  const playerDrawIfNeeded = useCallback(
    (nextState: GoFishState): GoFishState => {
      if (
        nextState.playerHand.length > 0 ||
        nextState.deck.getRemaining() <= 0
      ) {
        return nextState;
      }

      const drawn = drawCard(nextState.deck);

      if (!drawn) {
        return nextState;
      }

      return {
        ...nextState,
        playerHand: sortHand([...nextState.playerHand, drawn]),
        log: ["Your hand was empty, so you drew a card.", ...nextState.log],
      };
    },
    [],
  );

  const dealerDrawIfNeeded = useCallback(
    (nextState: GoFishState): GoFishState => {
      if (
        nextState.dealerHand.length > 0 ||
        nextState.deck.getRemaining() <= 0
      ) {
        return nextState;
      }

      const drawn = drawCard(nextState.deck);

      if (!drawn) {
        return nextState;
      }

      return {
        ...nextState,
        dealerHand: sortHand([...nextState.dealerHand, drawn]),
        log: [
          "Dealer drew a card because their hand was empty.",
          ...nextState.log,
        ],
      };
    },
    [],
  );

  const dealerTurn = useCallback(
    (current: GoFishState): GoFishState => {
      let next: GoFishState = {
        ...current,
        turn: "dealer",
        selectedRank: null,
      };

      let dealerContinuesTurn = true;

      while (dealerContinuesTurn) {
        if (next.gameOver) {
          return next;
        }

        next = dealerDrawIfNeeded(next);

        if (next.dealerHand.length === 0) {
          return maybeFinalizeGame(next);
        }

        const rankOptions = getRanksInHand(next.dealerHand);
        const requestedRank =
          rankOptions[Math.floor(Math.random() * rankOptions.length)];

        const fromPlayer = removeRankCards(next.playerHand, requestedRank);

        if (fromPlayer.removed.length > 0) {
          let dealerHand = sortHand([
            ...next.dealerHand,
            ...fromPlayer.removed,
          ]);
          let playerHand = sortHand(fromPlayer.remaining);

          const dealerBookResult = extractBooks(dealerHand);
          dealerHand = dealerBookResult.hand;

          const playerBookResult = extractBooks(playerHand);
          playerHand = playerBookResult.hand;

          next = {
            ...next,
            playerHand,
            dealerHand,
            dealerBooks: [...next.dealerBooks, ...dealerBookResult.books],
            playerBooks: [...next.playerBooks, ...playerBookResult.books],
            log: [
              `Dealer asked for ${requestedRank} and took ${fromPlayer.removed.length} card(s).`,
              ...next.log,
            ],
          };

          next = maybeFinalizeGame(next);

          if (next.gameOver) {
            return next;
          }

          // Dealer asks again after a successful take.
          continue;
        }

        const drawn = drawCard(next.deck);

        if (!drawn) {
          return maybeFinalizeGame({
            ...next,
            turn: "player",
            log: [
              `Dealer asked for ${requestedRank}. Deck is empty.`,
              ...next.log,
            ],
          });
        }

        let dealerHand = sortHand([...next.dealerHand, drawn]);
        const dealerBookResult = extractBooks(dealerHand);
        dealerHand = dealerBookResult.hand;

        next = {
          ...next,
          dealerHand,
          dealerBooks: [...next.dealerBooks, ...dealerBookResult.books],
          log: [
            `Dealer asked for ${requestedRank}. Go Fish. Dealer drew a card.`,
            ...next.log,
          ],
        };

        next = maybeFinalizeGame(next);

        if (next.gameOver) {
          return next;
        }

        if (drawn.rank === requestedRank) {
          // Dealer drew the asked rank, so dealer continues.
          continue;
        }

        dealerContinuesTurn = false;

        return {
          ...next,
          turn: "player",
        };
      }

      return next;
    },
    [dealerDrawIfNeeded],
  );

  const askForRank = useCallback(
    (rank: CardRank) => {
      if (!gameState || gameState.turn !== "player" || gameState.gameOver) {
        return;
      }

      let next: GoFishState = {
        ...gameState,
        turn: "player",
        selectedRank: rank,
      };

      const fromDealer = removeRankCards(next.dealerHand, rank);

      if (fromDealer.removed.length > 0) {
        let playerHand = sortHand([...next.playerHand, ...fromDealer.removed]);
        let dealerHand = sortHand(fromDealer.remaining);

        const playerBookResult = extractBooks(playerHand);
        playerHand = playerBookResult.hand;

        const dealerBookResult = extractBooks(dealerHand);
        dealerHand = dealerBookResult.hand;

        next = {
          ...next,
          playerHand,
          dealerHand,
          playerBooks: [...next.playerBooks, ...playerBookResult.books],
          dealerBooks: [...next.dealerBooks, ...dealerBookResult.books],
          log: [
            `You asked for ${rank} and got ${fromDealer.removed.length} card(s). Ask again.`,
            ...next.log,
          ],
        };

        next = maybeFinalizeGame(next);

        if (!next.gameOver) {
          next = playerDrawIfNeeded(next);
        }

        setGameState(maybeFinalizeGame(next));
        return;
      }

      const drawn = drawCard(next.deck);

      if (!drawn) {
        next = {
          ...next,
          turn: "dealer",
          log: [`You asked for ${rank}. Deck is empty.`, ...next.log],
        };

        next = maybeFinalizeGame(next);

        if (!next.gameOver) {
          next = dealerTurn(next);
        }

        setGameState(maybeFinalizeGame(next));
        return;
      }

      let playerHand = sortHand([...next.playerHand, drawn]);
      const playerBookResult = extractBooks(playerHand);
      playerHand = playerBookResult.hand;

      next = {
        ...next,
        playerHand,
        playerBooks: [...next.playerBooks, ...playerBookResult.books],
        log: [
          `You asked for ${rank}. Go Fish. You drew ${drawn.rank}.`,
          ...next.log,
        ],
      };

      next = maybeFinalizeGame(next);

      if (next.gameOver) {
        setGameState(next);
        return;
      }

      if (drawn.rank === rank) {
        next = playerDrawIfNeeded(next);
        setGameState(maybeFinalizeGame(next));
        return;
      }

      next = {
        ...next,
        turn: "dealer",
      };

      next = dealerTurn(next);
      setGameState(maybeFinalizeGame(next));
    },
    [dealerTurn, gameState, playerDrawIfNeeded],
  );

  const handleExitAfterGame = useCallback(() => {
    settleRewardRun();
    returnToMenu();
  }, [returnToMenu, settleRewardRun]);

  const handlePlayAgainPractice = useCallback(() => {
    if (sessionMode !== "practice") {
      return;
    }

    setGameState(createInitialState());
    setShowQuitConfirm(false);
  }, [sessionMode]);

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

  const playerCardGroups = groupCardsByRank(gameState.playerHand);

  return (
    <OuterPanel className={goFishPanelClassName}>
      <InnerPanel className="relative w-full h-full p-4 md:p-5 overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white">
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
