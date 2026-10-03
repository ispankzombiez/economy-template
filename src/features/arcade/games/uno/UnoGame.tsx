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
import { useVipAccess } from "../adapters/useVipAccess";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import { UnoCard, UnoColor, UnoFace, UnoGameState, UnoWinner } from "./types";
import { UnoDeck } from "./deck";
import {
  UNO_RAVEN_COIN_REWARD,
  UnoMode,
  isUnoRewardRunAvailable,
} from "./session";

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

const PLAYER_NAMES = ["You", "Bot 1", "Bot 2", "Bot 3"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NON_WILD_COLORS: Exclude<UnoColor, "Wild">[] = [
  "Kale",
  "Barley",
  "Wheat",
  "Radish",
];

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

const botPickColor = (): Exclude<UnoColor, "Wild"> =>
  NON_WILD_COLORS[Math.floor(Math.random() * NON_WILD_COLORS.length)];

const canPlay = (
  card: UnoCard,
  topCard: UnoCard,
  currentColor: UnoColor,
): boolean => {
  if (card.color === "Wild") return true;
  if (card.color === currentColor) return true;
  if (card.face === topCard.face) return true;
  return false;
};

// ─── Game initialisation ─────────────────────────────────────────────────────

const createInitialState = (): { state: UnoGameState; deck: UnoDeck } => {
  const deck = new UnoDeck();

  const hands: [UnoCard[], UnoCard[], UnoCard[], UnoCard[]] = [
    deck.dealMultiple(7),
    deck.dealMultiple(7),
    deck.dealMultiple(7),
    deck.dealMultiple(7),
  ];

  // First discard — re-draw if it starts with a Wild
  let firstCard = deck.deal()!;

  while (firstCard.color === "Wild") {
    // Put back and re-draw
    deck["cards"].unshift(firstCard); // internal access to refill
    firstCard = deck.deal()!;
  }

  const state: UnoGameState = {
    deck: [], // we hold the deck instance separately
    discard: [firstCard],
    hands,
    currentPlayer: 0,
    direction: 1,
    currentColor: firstCard.color as UnoColor,
    winner: null,
    gameOver: false,
    log: [`Game started. Top card: ${firstCard.color} ${firstCard.face}.`],
    pendingDrawCount: 0,
  };

  return { state, deck };
};

// ─── Bot AI ───────────────────────────────────────────────────────────────────

const botChooseCard = (
  hand: UnoCard[],
  topCard: UnoCard,
  currentColor: UnoColor,
  pendingDrawCount: number,
): UnoCard | null => {
  // If there's a pending draw, bots must play a matching draw card or take the penalty
  if (pendingDrawCount > 0) {
    const counter = hand.find(
      (c) =>
        (topCard.face === "DrawTwo" && c.face === "DrawTwo") ||
        (topCard.face === "WildDrawFour" && c.face === "WildDrawFour"),
    );
    return counter ?? null;
  }

  // Prefer action cards, then number cards
  const playable = hand.filter((c) => canPlay(c, topCard, currentColor));

  if (playable.length === 0) return null;

  // Prefer DrawTwo/WildDrawFour → Skip/Reverse → Wild → numbers
  const priority: UnoFace[] = [
    "DrawTwo",
    "WildDrawFour",
    "Skip",
    "Reverse",
    "Wild",
  ];

  for (const face of priority) {
    const match = playable.find((c) => c.face === face);

    if (match) return match;
  }

  return playable[0];
};

// ─── State machine helpers ────────────────────────────────────────────────────

const nextPlayerIndex = (
  current: number,
  direction: 1 | -1,
  skip = false,
): number => {
  const step = skip ? 2 : 1;
  return (((current + direction * step) % 4) + 4) % 4;
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

  const [sessionMode, setSessionMode] = useState<UnoMode | null>(null);
  const [gameState, setGameState] = useState<UnoGameState | null>(null);
  const deckRef = useRef<UnoDeck | null>(null);
  const [rewardRunStarted, setRewardRunStarted] = useState(false);
  const [rewardSubmitted, setRewardSubmitted] = useState(false);
  const [rewardGranted, setRewardGranted] = useState(false);
  const [showQuitConfirm, setShowQuitConfirm] = useState(false);
  // When player plays a Wild, we pause to let them pick a colour
  const [pendingWildCard, setPendingWildCard] = useState<UnoCard | null>(null);
  // Bot turn loop running flag
  const botTurnActiveRef = useRef(false);

  const hasRewardRun = useMemo(
    () => isUnoRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const returnToMenu = useCallback(() => {
    setShowQuitConfirm(false);
    setSessionMode(null);
    setGameState(null);
    setPendingWildCard(null);
    botTurnActiveRef.current = false;
  }, []);

  // ─── Reward settlement ────────────────────────────────────────────────────

  const settleRewardRun = useCallback(
    (finalState: UnoGameState) => {
      if (!finalState.gameOver || sessionMode !== "reward") return;

      if (!rewardSubmitted) {
        submitScore({ score: finalState.winner === "player" ? 1 : 0 });
        setRewardSubmitted(true);
      }

      if (finalState.winner === "player" && !rewardGranted) {
        portalService.send({
          type: "arcadeMinigame.ravenCoinWon",
          amount: UNO_RAVEN_COIN_REWARD,
        });
        setRewardGranted(true);
      }
    },
    [sessionMode, rewardSubmitted, rewardGranted, portalService],
  );

  // ─── Session start ────────────────────────────────────────────────────────

  const startSession = useCallback(
    (mode: UnoMode) => {
      setSessionMode(mode);
      const { state, deck } = createInitialState();
      deckRef.current = deck;
      setGameState(state);
      setRewardSubmitted(false);
      setRewardGranted(false);
      setPendingWildCard(null);
      botTurnActiveRef.current = false;

      if (mode === "reward" && !rewardRunStarted) {
        portalService.send({ type: "arcadeMinigame.started", name: "uno" });
        startAttempt();
        setRewardRunStarted(true);
      }
    },
    [portalService, rewardRunStarted],
  );

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

  // ─── Draw card helper (auto-refill deck) ─────────────────────────────────

  const drawFromDeck = useCallback(
    (
      currentDiscard: UnoCard[],
    ): { card: UnoCard | null; newDiscard: UnoCard[] } => {
      const deck = deckRef.current!;

      if (deck.remaining() === 0) {
        const newDiscard = deck.refill(currentDiscard);
        return { card: deck.deal(), newDiscard };
      }

      return { card: deck.deal(), newDiscard: currentDiscard };
    },
    [],
  );

  // ─── Apply a played card and produce the next state ───────────────────────

  const applyCardPlayed = useCallback(
    (
      state: UnoGameState,
      playerIndex: number,
      card: UnoCard,
      chosenColor?: Exclude<UnoColor, "Wild">,
    ): UnoGameState => {
      const newHand = state.hands[playerIndex].filter((c) => c.id !== card.id);
      const newHands = [...state.hands] as UnoGameState["hands"];
      newHands[playerIndex] = newHand;

      const newDiscard = [...state.discard, card];
      const newColor: UnoColor =
        card.color === "Wild" ? (chosenColor ?? "Kale") : card.color;
      let newDirection = state.direction;
      let newPending = state.pendingDrawCount;
      const logEntry: string[] = [];

      // Check win
      if (newHand.length === 0) {
        const winner: UnoWinner =
          playerIndex === 0
            ? "player"
            : playerIndex === 1
              ? "bot1"
              : playerIndex === 2
                ? "bot2"
                : "bot3";

        logEntry.push(
          `${PLAYER_NAMES[playerIndex]} played ${card.color} ${card.face} and wins!`,
        );

        return {
          ...state,
          hands: newHands,
          discard: newDiscard,
          currentColor: newColor,
          gameOver: true,
          winner,
          log: [...logEntry, ...state.log],
          pendingDrawCount: 0,
        };
      }

      let skip = false;

      switch (card.face) {
        case "Reverse":
          newDirection = (state.direction * -1) as 1 | -1;
          logEntry.push(
            `${PLAYER_NAMES[playerIndex]} played Reverse. Direction flipped.`,
          );
          break;
        case "Skip":
          skip = true;
          logEntry.push(`${PLAYER_NAMES[playerIndex]} played Skip.`);
          break;
        case "DrawTwo":
          newPending = state.pendingDrawCount + 2;
          logEntry.push(
            `${PLAYER_NAMES[playerIndex]} played Draw Two (+${newPending} pending).`,
          );
          break;
        case "Wild":
          logEntry.push(
            `${PLAYER_NAMES[playerIndex]} played Wild → picked ${newColor}.`,
          );
          break;
        case "WildDrawFour":
          newPending = state.pendingDrawCount + 4;
          logEntry.push(
            `${PLAYER_NAMES[playerIndex]} played Wild Draw Four (+${newPending} pending) → picked ${newColor}.`,
          );
          break;
        default:
          logEntry.push(
            `${PLAYER_NAMES[playerIndex]} played ${card.color} ${card.face}.`,
          );
      }

      const nextPlayer = nextPlayerIndex(playerIndex, newDirection, skip);

      return {
        ...state,
        hands: newHands,
        discard: newDiscard,
        currentColor: newColor,
        direction: newDirection,
        currentPlayer: nextPlayer,
        pendingDrawCount: newPending,
        log: [...logEntry, ...state.log],
      };
    },
    [],
  );

  // ─── Bot draw penalty ─────────────────────────────────────────────────────

  const applyDrawPenalty = useCallback(
    (state: UnoGameState, playerIndex: number): UnoGameState => {
      const drawCount = state.pendingDrawCount;
      const drawnCards: UnoCard[] = [];
      let currentDiscard = [...state.discard];

      for (let i = 0; i < drawCount; i++) {
        const { card, newDiscard } = drawFromDeck(currentDiscard);
        currentDiscard = newDiscard;

        if (card) drawnCards.push(card);
      }

      const newHands = [...state.hands] as UnoGameState["hands"];
      newHands[playerIndex] = [...newHands[playerIndex], ...drawnCards];

      const nextPlayer = nextPlayerIndex(playerIndex, state.direction);
      const logEntry = `${PLAYER_NAMES[playerIndex]} drew ${drawnCards.length} card(s) as penalty.`;

      return {
        ...state,
        hands: newHands,
        discard: currentDiscard,
        pendingDrawCount: 0,
        currentPlayer: nextPlayer,
        log: [logEntry, ...state.log],
      };
    },
    [drawFromDeck],
  );

  // ─── Bot turn (single bot step) ───────────────────────────────────────────

  const runBotTurn = useCallback(
    (state: UnoGameState): UnoGameState => {
      const playerIndex = state.currentPlayer;
      const hand = state.hands[playerIndex];
      const topCard = state.discard[state.discard.length - 1];

      // Must take penalty draw?
      if (state.pendingDrawCount > 0) {
        const counter = hand.find(
          (c) =>
            (topCard.face === "DrawTwo" && c.face === "DrawTwo") ||
            (topCard.face === "WildDrawFour" && c.face === "WildDrawFour"),
        );

        if (counter) {
          // Stack it
          const chosenColor =
            counter.color === "Wild" ? botPickColor() : undefined;
          return applyCardPlayed(state, playerIndex, counter, chosenColor);
        }

        return applyDrawPenalty(state, playerIndex);
      }

      const chosen = botChooseCard(
        hand,
        topCard,
        state.currentColor,
        state.pendingDrawCount,
      );

      if (!chosen) {
        // Draw one card
        let currentDiscard = [...state.discard];
        const { card: drawn, newDiscard } = drawFromDeck(currentDiscard);
        currentDiscard = newDiscard;

        const newHands = [...state.hands] as UnoGameState["hands"];

        if (drawn) {
          newHands[playerIndex] = [...hand, drawn];

          // Can the drawn card be played?
          if (canPlay(drawn, topCard, state.currentColor)) {
            const chosenColor =
              drawn.color === "Wild" ? botPickColor() : undefined;
            const afterDraw: UnoGameState = {
              ...state,
              hands: newHands,
              discard: currentDiscard,
              log: [
                `${PLAYER_NAMES[playerIndex]} drew a card and played it.`,
                ...state.log,
              ],
            };
            return applyCardPlayed(afterDraw, playerIndex, drawn, chosenColor);
          }
        }

        const nextPlayer = nextPlayerIndex(playerIndex, state.direction);

        return {
          ...state,
          hands: newHands,
          discard: currentDiscard,
          currentPlayer: nextPlayer,
          log: [
            `${PLAYER_NAMES[playerIndex]} drew a card and passed.`,
            ...state.log,
          ],
        };
      }

      const chosenColor = chosen.color === "Wild" ? botPickColor() : undefined;
      return applyCardPlayed(state, playerIndex, chosen, chosenColor);
    },
    [applyCardPlayed, applyDrawPenalty, drawFromDeck],
  );

  // ─── Drive bot turns automatically ───────────────────────────────────────

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

        if (next.gameOver) {
          settleRewardRun(next);
        }

        return next;
      });
    }, 700);

    return () => clearTimeout(timeout);
  }, [gameState, runBotTurn, settleRewardRun]);

  // ─── Player: draw a card ──────────────────────────────────────────────────

  const handlePlayerDraw = useCallback(() => {
    if (!gameState || gameState.currentPlayer !== 0 || gameState.gameOver)
      return;

    const topCard = gameState.discard[gameState.discard.length - 1];

    // Must take penalty
    if (gameState.pendingDrawCount > 0) {
      setGameState(applyDrawPenalty(gameState, 0));
      return;
    }

    let currentDiscard = [...gameState.discard];
    const { card: drawn, newDiscard } = drawFromDeck(currentDiscard);
    currentDiscard = newDiscard;

    if (!drawn) return;

    const newHands = [...gameState.hands] as UnoGameState["hands"];
    newHands[0] = [...newHands[0], drawn];

    const nextPlayer = nextPlayerIndex(0, gameState.direction);
    setGameState({
      ...gameState,
      hands: newHands,
      discard: currentDiscard,
      currentPlayer: canPlay(drawn, topCard, gameState.currentColor)
        ? 0
        : nextPlayer,
      log: [
        canPlay(drawn, topCard, gameState.currentColor)
          ? `You drew ${drawn.color} ${drawn.face}. You may play it.`
          : `You drew ${drawn.color} ${drawn.face} and passed.`,
        ...gameState.log,
      ],
    });
  }, [gameState, applyDrawPenalty, drawFromDeck]);

  // ─── Player: play a card ──────────────────────────────────────────────────

  const handlePlayerPlay = useCallback(
    (card: UnoCard) => {
      if (!gameState || gameState.currentPlayer !== 0 || gameState.gameOver)
        return;

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

      const next = applyCardPlayed(gameState, 0, card);
      setGameState(next);

      if (next.gameOver) settleRewardRun(next);
    },
    [gameState, applyCardPlayed, settleRewardRun],
  );

  // ─── Player: choose wild colour ───────────────────────────────────────────

  const handleWildColorChosen = useCallback(
    (color: Exclude<UnoColor, "Wild">) => {
      if (!pendingWildCard || !gameState) return;

      setPendingWildCard(null);
      const next = applyCardPlayed(gameState, 0, pendingWildCard, color);
      setGameState(next);

      if (next.gameOver) settleRewardRun(next);
    },
    [pendingWildCard, gameState, applyCardPlayed, settleRewardRun],
  );

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
                    ? "VIP: reward run available for Uno today."
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

  // ─── In-game screen ───────────────────────────────────────────────────────

  const topCard = gameState.discard[gameState.discard.length - 1];
  const playerHand = gameState.hands[0];
  const isPlayerTurn = gameState.currentPlayer === 0 && !gameState.gameOver;
  const deckRemaining = Math.max(
    108 -
      gameState.hands.reduce((total, hand) => total + hand.length, 0) -
      gameState.discard.length,
    0,
  );

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
                    <Button
                      onClick={() => {
                        const { state, deck } = createInitialState();
                        deckRef.current = deck;
                        setGameState(state);
                        setPendingWildCard(null);
                        setRewardSubmitted(false);
                        setRewardGranted(false);
                        botTurnActiveRef.current = false;
                      }}
                    >
                      PLAY AGAIN
                    </Button>
                  )}
                  <Button
                    onClick={() => {
                      settleRewardRun(gameState);
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
