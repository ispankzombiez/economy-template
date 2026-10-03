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
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { startAttempt, submitScore } from "../adapters/portalUtil";
import { useVipAccess } from "../adapters/useVipAccess";
import { useRewardRun } from "../adapters/rewardRun";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import { Card, CardRank, CardSuit } from "../poker/types";
import {
  getSolitaireDifficulty,
  isSolitaireRewardRunAvailable,
  SOLITAIRE_DIFFICULTIES,
  SolitaireDifficulty,
  SOLITAIRE_RAVEN_COIN_REWARD,
  SolitaireDifficultyName,
  SolitaireMode,
} from "./session";
import {
  FoundationPiles,
  SelectedCard,
  SolitaireState,
  TableauPile,
} from "./types";

const solitairePanelClassName =
  "mx-auto w-full max-w-[1200px] h-[min(95vh,900px)] overflow-hidden";

const _portalState = (state: PortalMachineState) => state.context.state;

const SUITS: CardSuit[] = ["Kale", "Barley", "Wheat", "Radish"];
const RANKS: CardRank[] = [
  "A",
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
];

const RANK_VALUE: Record<CardRank, number> = {
  A: 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 12,
  K: 13,
};

const colorText: Record<CardSuit, string> = {
  Kale: "text-slate-900",
  Barley: "text-red-700",
  Wheat: "text-red-700",
  Radish: "text-slate-900",
};

const colorBg: Record<CardSuit, string> = {
  Kale: "bg-white",
  Barley: "bg-white",
  Wheat: "bg-white",
  Radish: "bg-white",
};

const colorBorder: Record<CardSuit, string> = {
  Kale: "border-slate-400",
  Barley: "border-red-300",
  Wheat: "border-red-300",
  Radish: "border-slate-400",
};

/**
 * How much of each stacked card stays visible, as a negative top margin.
 *
 * ## Why they are responsive
 *
 * A pile's height is `card height + (cards - 1) x reveal`, and a tableau pile
 * can legitimately hold all 13 cards, so these four numbers decide whether the
 * board fits a phone at all. Measured per role in the browser at 320x640, on a
 * 56px phone card, each negative margin leaves this much of the card showing:
 *
 * | role                          | phone class        | reveal | desktop reveal |
 * |-------------------------------|--------------------|--------|----------------|
 * | card buried under a face-down | `-mt-[50px]`       | 6px    | 28px           |
 * | first face-up on a face-down  | `-mt-[50px]`       | 6px    | 12px           |
 * | playable card of a stack      | `-mt-8`            | 24px   | 52px           |
 * | rest of a face-up run         | `-mt-[50px]`       | 6px    | 20px           |
 *
 * The phone reveal is 6px because that is what a full pile needs. Measured at
 * 320x640: the column is 578px tall, the header, stock row, action buttons and
 * hint line take 216 of it, and the seven piles share two rows of the
 * remaining 362 — 175px per pile, of which 156 is the stack area once the 14px
 * label, 8px of padding and 2px of border are taken off it. The most expensive
 * legal pile is six face-down then seven face-up, and at a 6px reveal it costs
 * 56 + 5x6 + 6 + 24 + 5x6 = 146 of the 156 available.
 *
 * At the 8px reveal this shipped first with, the same pile costs
 * 56 + 5x8 + 6 + 24 + 5x8 = 166 — ten more than the pile has — so the last two
 * cards of a full pile hung out of the bottom of their own pile, past the
 * panel's own edge, which is the one thing the layout is for. The desktop
 * figures are untouched: an 80px card with a 20px reveal reads exactly as it
 * always did.
 *
 * The cost is that a buried card is a thinner strip on a phone than on a
 * monitor — 6px shows its border and the top of its corner. Every pile's
 * playable card, the one that is actually tapped, is drawn in full.
 */
const FACE_DOWN_OVERLAP_CLASS = "-mt-[50px] md:-mt-[52px]";
const FACE_UP_AFTER_FACE_DOWN_OVERLAP_CLASS = "-mt-[50px] md:-mt-[68px]";
const FACE_UP_STACK_OVERLAP_CLASS = "-mt-[50px] md:-mt-[60px]";
const FACE_UP_TOP_CARD_OVERLAP_CLASS = "-mt-8 md:-mt-[28px]";
const MAX_UNDOS_PER_GAME = 3;

const suitImages: Record<CardSuit, string> = {
  Kale: ITEM_DETAILS.Kale.image,
  Barley: ITEM_DETAILS.Barley.image,
  Wheat: ITEM_DETAILS.Wheat.image,
  Radish: ITEM_DETAILS.Radish.image,
};

const isDarkSuit = (suit: CardSuit) => suit === "Kale" || suit === "Radish";

const mulberry32 = (seed: number) => {
  let t = seed >>> 0;

  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);

    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};

const createOrderedDeck = (): Card[] => {
  const deck: Card[] = [];

  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }

  return deck;
};

const createShuffledDeck = (seed: number): Card[] => {
  const deck = createOrderedDeck();
  const random = mulberry32(seed);

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
};

const drawTop = (stack: Card[]) => {
  const card = stack.pop();
  if (!card) {
    throw new Error("Cannot draw from an empty stack");
  }

  return card;
};

const createInitialState = (
  seed: number,
  maxPasses: number,
): SolitaireState => {
  const deck = createShuffledDeck(seed);
  const tableau: TableauPile[] = [];

  for (let pile = 0; pile < 7; pile++) {
    const faceDown: Card[] = [];
    for (let i = 0; i < pile; i++) {
      faceDown.push(drawTop(deck));
    }

    const faceUp = [drawTop(deck)];
    tableau.push({ faceDown, faceUp });
  }

  const foundations: FoundationPiles = {
    Kale: [],
    Barley: [],
    Wheat: [],
    Radish: [],
  };

  return {
    tableau,
    foundations,
    stock: deck,
    waste: [],
    passesRemaining: maxPasses,
    moves: 0,
    selected: null,
  };
};

/**
 * Greedy forward solver with deterministic move priority.
 * Returns true only if it finds a complete winning path within the iteration
 * limit, giving a guaranteed-solvable certificate for that deal.
 *
 * Move order:
 *  1. Tableau top → foundation
 *  2. Waste top → foundation
 *  3. Full stack moves that reveal a face-down card (prefer most fd)
 *  4. Waste top → tableau (prefer piles with most fd cards)
 *  5. Draw from stock / reset waste
 *  6. Any partial-stack tableau → tableau (excludes trivial king cycling)
 */
const greedySolve = (initial: SolitaireState, drawCount: number): boolean => {
  const tab = initial.tableau.map((p) => ({
    fd: [...p.faceDown],
    fu: [...p.faceUp],
  }));
  const fnd: Record<CardSuit, number> = {
    Kale: 0,
    Barley: 0,
    Wheat: 0,
    Radish: 0,
  };
  let stock = [...initial.stock];
  let waste: Card[] = [];
  let passes = initial.passesRemaining;

  const rv = (c: Card) => RANK_VALUE[c.rank];
  const dk = (s: CardSuit) => s === "Kale" || s === "Radish";
  const flip = (i: number) => {
    if (!tab[i].fu.length && tab[i].fd.length) tab[i].fu.push(tab[i].fd.pop()!);
  };
  const toFnd = (c: Card) =>
    fnd[c.suit] === 0 ? c.rank === "A" : rv(c) === fnd[c.suit] + 1;
  const onPile = (c: Card, i: number) => {
    const fu = tab[i].fu;
    if (!fu.length) return c.rank === "K";
    const top = fu[fu.length - 1];
    return dk(c.suit) !== dk(top.suit) && rv(c) === rv(top) - 1;
  };

  for (let it = 0; it < 3000; it++) {
    if (SUITS.every((s) => fnd[s] === 13)) return true;

    let moved = false;

    // 1. Tableau top → foundation
    for (let i = 0; i < 7 && !moved; i++) {
      const fu = tab[i].fu;
      if (!fu.length) continue;
      const top = fu[fu.length - 1];
      if (toFnd(top)) {
        fu.pop();
        fnd[top.suit]++;
        flip(i);
        moved = true;
      }
    }
    if (moved) continue;

    // 2. Waste top → foundation
    if (waste.length) {
      const top = waste[waste.length - 1];
      if (toFnd(top)) {
        waste.pop();
        fnd[top.suit]++;
        moved = true;
      }
    }
    if (moved) continue;

    // 3. Full-stack tableau move that reveals a face-down card
    {
      let bestFd = 0,
        bSrc = -1,
        bDst = -1;
      for (let src = 0; src < 7; src++) {
        const fu = tab[src].fu;
        if (!fu.length || !tab[src].fd.length) continue;
        for (let dst = 0; dst < 7; dst++) {
          if (src === dst || !onPile(fu[0], dst)) continue;
          if (tab[src].fd.length > bestFd) {
            bestFd = tab[src].fd.length;
            bSrc = src;
            bDst = dst;
          }
        }
      }
      if (bSrc >= 0) {
        tab[bDst].fu.push(...tab[bSrc].fu.splice(0));
        flip(bSrc);
        moved = true;
      }
    }
    if (moved) continue;

    // 4. Waste top → tableau (prefer piles with most fd)
    if (waste.length) {
      const top = waste[waste.length - 1];
      let best = -1;
      for (let i = 0; i < 7; i++) {
        if (!onPile(top, i)) continue;
        if (best === -1 || tab[i].fd.length > tab[best].fd.length) best = i;
      }
      if (best >= 0) {
        waste.pop();
        tab[best].fu.push(top);
        moved = true;
      }
    }
    if (moved) continue;

    // 5. Draw from stock / reset waste
    if (stock.length) {
      const n = Math.min(drawCount, stock.length);
      waste.push(...stock.splice(stock.length - n, n));
      moved = true;
    } else if (passes > 0 && waste.length) {
      stock = [...waste].reverse();
      waste = [];
      passes--;
      moved = true;
    }
    if (moved) continue;

    // 6. Any partial-stack tableau → tableau (skip trivial king-to-empty cycling)
    {
      let found = false;
      for (let src = 0; src < 7 && !found; src++) {
        const fu = tab[src].fu;
        for (let start = 0; start < fu.length && !found; start++) {
          for (let dst = 0; dst < 7 && !found; dst++) {
            if (src === dst || !onPile(fu[start], dst)) continue;
            if (start === 0 && !tab[src].fd.length && !tab[dst].fu.length)
              continue;
            tab[dst].fu.push(...tab[src].fu.splice(start));
            flip(src);
            found = true;
          }
        }
      }
      if (found) moved = true;
    }
    if (moved) continue;

    break;
  }

  return SUITS.every((s) => fnd[s] === 13);
};

/**
 * Tries up to 100 consecutive seeds until greedySolve confirms solvability.
 * With ~82% of random Klondike deals being solvable the chance of all 100
 * failing is astronomically small. Falls back to the original seed as a safety
 * net so the game always starts.
 */
const createSolvableDeal = (
  seed: number,
  maxPasses: number,
  drawCount: number,
): SolitaireState => {
  for (let i = 0; i < 100; i++) {
    const trySeed = (seed + i) >>> 0;
    const state = createInitialState(trySeed, maxPasses);
    if (greedySolve(state, drawCount)) return state;
  }
  return createInitialState(seed, maxPasses);
};

const canPlaceOnTableau = (movingCard: Card, targetTop?: Card) => {
  if (!targetTop) {
    return movingCard.rank === "K";
  }

  const targetValue = RANK_VALUE[targetTop.rank];
  const movingValue = RANK_VALUE[movingCard.rank];

  return (
    isDarkSuit(movingCard.suit) !== isDarkSuit(targetTop.suit) &&
    movingValue === targetValue - 1
  );
};

const canPlaceOnFoundation = (card: Card, foundation: Card[]) => {
  if (foundation.length === 0) {
    return card.rank === "A";
  }

  const top = foundation[foundation.length - 1];
  return (
    card.suit === top.suit && RANK_VALUE[card.rank] === RANK_VALUE[top.rank] + 1
  );
};

const getFoundationsCount = (state: SolitaireState) =>
  SUITS.reduce((total, suit) => total + state.foundations[suit].length, 0);

export const SolitaireGame: React.FC<{ onClose?: () => void }> = ({
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });

  const hasRewardRun = useMemo(
    () => isSolitaireRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const todaysDifficulty = useMemo(() => getSolitaireDifficulty(), []);

  const [sessionMode, setSessionMode] = useState<SolitaireMode | null>(null);
  const [gameState, setGameState] = useState<SolitaireState | null>(null);
  const [rewardGranted, setRewardGranted] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [showPracticeDifficultyPrompt, setShowPracticeDifficultyPrompt] =
    useState(false);
  const [practiceDifficultyName, setPracticeDifficultyName] =
    useState<SolitaireDifficultyName>(todaysDifficulty.name);
  const [activeDifficulty, setActiveDifficulty] =
    useState<SolitaireDifficulty>(todaysDifficulty);
  const undoHistoryRef = useRef<SolitaireState[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [undosRemaining, setUndosRemaining] = useState(MAX_UNDOS_PER_GAME);

  const returnToMenu = useCallback(() => {
    setShowExitConfirm(false);
    setShowPracticeDifficultyPrompt(false);
    setSessionMode(null);
    setGameState(null);
    undoHistoryRef.current = [];
    setUndoCount(0);
    setUndosRemaining(MAX_UNDOS_PER_GAME);
  }, []);

  const setGameStateWithUndo = useCallback(
    (updater: (previous: SolitaireState) => SolitaireState) => {
      setGameState((previous) => {
        if (!previous) return previous;

        const next = updater(previous);
        if (next === previous) return previous;

        const nextHistory = [...undoHistoryRef.current, previous];
        undoHistoryRef.current = nextHistory;
        setUndoCount(nextHistory.length);

        return next;
      });
    },
    [],
  );

  const getRunSeed = useCallback(() => {
    return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  }, []);

  const startSession = useCallback(
    (
      mode: SolitaireMode,
      practiceDifficultyOverride?: SolitaireDifficultyName,
    ) => {
      if (mode === "reward" && !hasRewardRun) return;

      const seed = getRunSeed();

      const selectedPracticeDifficulty =
        SOLITAIRE_DIFFICULTIES.find(
          (d) =>
            d.name === (practiceDifficultyOverride ?? practiceDifficultyName),
        ) ?? todaysDifficulty;

      const runDifficulty =
        mode === "reward" ? todaysDifficulty : selectedPracticeDifficulty;

      setActiveDifficulty(runDifficulty);
      setSessionMode(mode);
      setRewardGranted(false);
      setShowExitConfirm(false);
      setShowPracticeDifficultyPrompt(false);
      undoHistoryRef.current = [];
      setUndoCount(0);
      setUndosRemaining(MAX_UNDOS_PER_GAME);
      setGameState(
        createSolvableDeal(
          seed,
          runDifficulty.maxPasses,
          runDifficulty.drawCount,
        ),
      );

      if (mode === "reward") {
        portalService.send({
          type: "arcadeMinigame.started",
          name: "solitaire" as any,
        });
        startAttempt();
      }
    },
    [
      getRunSeed,
      hasRewardRun,
      portalService,
      practiceDifficultyName,
      todaysDifficulty,
    ],
  );

  // Free run first, then 1 burned Play Ticket per attempt — with the "are you
  // sure?" box in between. `hasRewardRun` is kept as the availability check so
  // the button and the store can never disagree.
  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "solitaire",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  const drawFromStock = useCallback(() => {
    setGameStateWithUndo((previous) => {
      if (!previous) return previous;

      if (previous.stock.length > 0) {
        const drawCount = Math.min(
          activeDifficulty.drawCount,
          previous.stock.length,
        );
        const stock = [...previous.stock];
        const drawn = stock.splice(stock.length - drawCount, drawCount);

        return {
          ...previous,
          stock,
          waste: [...previous.waste, ...drawn],
          selected: null,
          moves: previous.moves + 1,
        };
      }

      if (previous.waste.length > 0 && previous.passesRemaining > 0) {
        return {
          ...previous,
          stock: [...previous.waste].reverse(),
          waste: [],
          selected: null,
          passesRemaining: previous.passesRemaining - 1,
          moves: previous.moves + 1,
        };
      }

      return previous;
    });
  }, [setGameStateWithUndo, activeDifficulty.drawCount]);

  const selectWaste = useCallback(() => {
    setGameState((previous) => {
      if (!previous || previous.waste.length === 0) return previous;
      return {
        ...previous,
        selected:
          previous.selected?.source === "waste" ? null : { source: "waste" },
      };
    });
  }, []);

  const selectTableauCard = useCallback(
    (pileIndex: number, cardIndex: number) => {
      setGameState((previous) => {
        if (!previous) return previous;

        const pile = previous.tableau[pileIndex];
        if (!pile || cardIndex < 0 || cardIndex >= pile.faceUp.length)
          return previous;

        const selected: SelectedCard = {
          source: "tableau",
          pileIndex,
          cardIndex,
        };

        const isSameSelection =
          previous.selected?.source === "tableau" &&
          previous.selected.pileIndex === pileIndex &&
          previous.selected.cardIndex === cardIndex;

        return {
          ...previous,
          selected: isSameSelection ? null : selected,
        };
      });
    },
    [],
  );

  const moveSelectedToTableau = useCallback(
    (targetIndex: number) => {
      setGameStateWithUndo((previous) => {
        if (!previous || !previous.selected) return previous;

        const tableau = previous.tableau.map((pile) => ({
          faceDown: [...pile.faceDown],
          faceUp: [...pile.faceUp],
        }));

        let movingCards: Card[] = [];

        if (previous.selected.source === "waste") {
          const wasteTop = previous.waste[previous.waste.length - 1];
          if (!wasteTop) return previous;
          movingCards = [wasteTop];
        } else {
          const sourcePile = tableau[previous.selected.pileIndex];
          movingCards = sourcePile.faceUp.slice(previous.selected.cardIndex);
        }

        if (movingCards.length === 0) return previous;

        const targetPile = tableau[targetIndex];
        const targetTop = targetPile.faceUp[targetPile.faceUp.length - 1];

        if (!canPlaceOnTableau(movingCards[0], targetTop)) return previous;

        let waste = [...previous.waste];

        if (previous.selected.source === "waste") {
          waste = waste.slice(0, -1);
        } else {
          const sourcePile = tableau[previous.selected.pileIndex];
          sourcePile.faceUp = sourcePile.faceUp.slice(
            0,
            previous.selected.cardIndex,
          );

          if (
            sourcePile.faceUp.length === 0 &&
            sourcePile.faceDown.length > 0
          ) {
            const flipped = sourcePile.faceDown.pop();
            if (flipped) {
              sourcePile.faceUp.push(flipped);
            }
          }
        }

        targetPile.faceUp = [...targetPile.faceUp, ...movingCards];

        return {
          ...previous,
          tableau,
          waste,
          selected: null,
          moves: previous.moves + 1,
        };
      });
    },
    [setGameStateWithUndo],
  );

  const moveSelectedToFoundation = useCallback(
    (targetSuit: CardSuit) => {
      setGameStateWithUndo((previous) => {
        if (!previous || !previous.selected) return previous;

        let movingCard: Card | undefined;
        let waste = [...previous.waste];
        const tableau = previous.tableau.map((pile) => ({
          faceDown: [...pile.faceDown],
          faceUp: [...pile.faceUp],
        }));

        if (previous.selected.source === "waste") {
          movingCard = waste[waste.length - 1];
        } else {
          const sourcePile = tableau[previous.selected.pileIndex];
          const isTopCard =
            previous.selected.cardIndex === sourcePile.faceUp.length - 1;
          if (!isTopCard) return previous;

          movingCard = sourcePile.faceUp[sourcePile.faceUp.length - 1];
        }

        if (!movingCard || movingCard.suit !== targetSuit) return previous;

        const foundation = previous.foundations[targetSuit];
        if (!canPlaceOnFoundation(movingCard, foundation)) return previous;

        if (previous.selected.source === "waste") {
          waste = waste.slice(0, -1);
        } else {
          const sourcePile = tableau[previous.selected.pileIndex];
          sourcePile.faceUp = sourcePile.faceUp.slice(0, -1);

          if (
            sourcePile.faceUp.length === 0 &&
            sourcePile.faceDown.length > 0
          ) {
            const flipped = sourcePile.faceDown.pop();
            if (flipped) {
              sourcePile.faceUp.push(flipped);
            }
          }
        }

        return {
          ...previous,
          tableau,
          waste,
          foundations: {
            ...previous.foundations,
            [targetSuit]: [...foundation, movingCard],
          },
          selected: null,
          moves: previous.moves + 1,
        };
      });
    },
    [setGameStateWithUndo],
  );

  const autoMoveToFoundation = useCallback(() => {
    setGameStateWithUndo((previous) => {
      if (!previous) return previous;

      const next: SolitaireState = {
        ...previous,
        tableau: previous.tableau.map((pile) => ({
          faceDown: [...pile.faceDown],
          faceUp: [...pile.faceUp],
        })),
        foundations: {
          Kale: [...previous.foundations.Kale],
          Barley: [...previous.foundations.Barley],
          Wheat: [...previous.foundations.Wheat],
          Radish: [...previous.foundations.Radish],
        },
        waste: [...previous.waste],
        selected: null,
      };

      let movedCards = 0;
      let movedThisPass = true;

      while (movedThisPass) {
        movedThisPass = false;

        const wasteTop = next.waste[next.waste.length - 1];
        if (wasteTop) {
          const wasteFoundation = next.foundations[wasteTop.suit];
          if (canPlaceOnFoundation(wasteTop, wasteFoundation)) {
            next.waste.pop();
            wasteFoundation.push(wasteTop);
            movedCards += 1;
            movedThisPass = true;
            continue;
          }
        }

        for (const pile of next.tableau) {
          const top = pile.faceUp[pile.faceUp.length - 1];
          if (!top) continue;

          const foundation = next.foundations[top.suit];
          if (!canPlaceOnFoundation(top, foundation)) continue;

          pile.faceUp.pop();
          foundation.push(top);

          if (pile.faceUp.length === 0 && pile.faceDown.length > 0) {
            const flipped = pile.faceDown.pop();
            if (flipped) {
              pile.faceUp.push(flipped);
            }
          }

          movedCards += 1;
          movedThisPass = true;
          break;
        }
      }

      if (movedCards === 0) return previous;

      return {
        ...next,
        moves: previous.moves + movedCards,
      };
    });
  }, [setGameStateWithUndo]);

  const undoMove = useCallback(() => {
    if (undosRemaining <= 0) return;

    const history = undoHistoryRef.current;
    if (history.length === 0) return;

    const previousSnapshot = history[history.length - 1];
    const nextHistory = history.slice(0, -1);

    undoHistoryRef.current = nextHistory;
    setUndoCount(nextHistory.length);
    setUndosRemaining((previous) => previous - 1);
    setGameState(previousSnapshot);
  }, [undosRemaining]);

  const smartMove = useCallback(
    (source: "waste" | { pileIndex: number; cardIndex: number }) => {
      setGameStateWithUndo((previous) => {
        if (!previous) return previous;

        const tableau = previous.tableau.map((pile) => ({
          faceDown: [...pile.faceDown],
          faceUp: [...pile.faceUp],
        }));
        let waste = [...previous.waste];

        let movingCard: Card | undefined;
        let isTopCard: boolean;

        if (source === "waste") {
          movingCard = waste[waste.length - 1];
          isTopCard = true;
        } else {
          const pile = tableau[source.pileIndex];
          movingCard = pile.faceUp[source.cardIndex];
          isTopCard = source.cardIndex === pile.faceUp.length - 1;
        }

        if (!movingCard) return previous;

        // 1. Foundation first (top card only)
        if (isTopCard) {
          const foundation = previous.foundations[movingCard.suit];
          if (canPlaceOnFoundation(movingCard, foundation)) {
            if (source === "waste") {
              waste = waste.slice(0, -1);
            } else {
              const sp = tableau[source.pileIndex];
              sp.faceUp = sp.faceUp.slice(0, -1);
              if (sp.faceUp.length === 0 && sp.faceDown.length > 0) {
                const flipped = sp.faceDown.pop();
                if (flipped) sp.faceUp.push(flipped);
              }
            }
            return {
              ...previous,
              tableau,
              waste,
              foundations: {
                ...previous.foundations,
                [movingCard.suit]: [...foundation, movingCard],
              },
              selected: null,
              moves: previous.moves + 1,
            };
          }
        }

        // 2. Tableau pile
        const movingCards: Card[] =
          source === "waste"
            ? [movingCard]
            : tableau[
                (source as { pileIndex: number; cardIndex: number }).pileIndex
              ].faceUp.slice(
                (source as { pileIndex: number; cardIndex: number }).cardIndex,
              );

        for (let i = 0; i < tableau.length; i++) {
          if (
            source !== "waste" &&
            (source as { pileIndex: number }).pileIndex === i
          )
            continue;
          const targetPile = tableau[i];
          const targetTop = targetPile.faceUp[targetPile.faceUp.length - 1];
          if (!canPlaceOnTableau(movingCards[0], targetTop)) continue;

          if (source === "waste") {
            waste = waste.slice(0, -1);
          } else {
            const sp =
              tableau[
                (source as { pileIndex: number; cardIndex: number }).pileIndex
              ];
            sp.faceUp = sp.faceUp.slice(
              0,
              (source as { pileIndex: number; cardIndex: number }).cardIndex,
            );
            if (sp.faceUp.length === 0 && sp.faceDown.length > 0) {
              const flipped = sp.faceDown.pop();
              if (flipped) sp.faceUp.push(flipped);
            }
          }

          targetPile.faceUp = [...targetPile.faceUp, ...movingCards];
          return {
            ...previous,
            tableau,
            waste,
            selected: null,
            moves: previous.moves + 1,
          };
        }

        return previous;
      });
    },
    [setGameStateWithUndo],
  );

  const handleTableauCardClick = useCallback(
    (pileIndex: number, cardIndex: number) => {
      const selected = gameState?.selected;

      if (!selected) {
        selectTableauCard(pileIndex, cardIndex);
        return;
      }

      if (selected.source === "waste") {
        moveSelectedToTableau(pileIndex);
        return;
      }

      if (selected.pileIndex !== pileIndex) {
        moveSelectedToTableau(pileIndex);
        return;
      }

      selectTableauCard(pileIndex, cardIndex);
    },
    [gameState, moveSelectedToTableau, selectTableauCard],
  );

  const solved = useMemo(() => {
    if (!gameState) return false;
    return getFoundationsCount(gameState) === 52;
  }, [gameState]);

  const progressCount = useMemo(() => {
    if (!gameState) return 0;
    return getFoundationsCount(gameState);
  }, [gameState]);

  const completeRewardIfNeeded = useCallback(() => {
    if (!gameState || !solved || sessionMode !== "reward" || rewardGranted)
      return;

    submitScore({ score: progressCount });
    portalService.send({
      type: "arcadeMinigame.ravenCoinWon",
      amount: SOLITAIRE_RAVEN_COIN_REWARD,
    });
    setRewardGranted(true);
  }, [
    gameState,
    solved,
    sessionMode,
    rewardGranted,
    progressCount,
    portalService,
  ]);

  if (solved) {
    completeRewardIfNeeded();
  }

  // ## Why the card box is two CSS variables
  //
  // A card's width and height are read in four places — the face, the back, the
  // stock/foundation buttons and the waste fan — and the pile overlap maths
  // above is derived from the height. Declaring the size once on the play area
  // (`--card-w` / `--card-h`, one pair of `md:` overrides) is what keeps the
  // fan, the pile slots and the cards from drifting apart at a third size.
  //
  // 44 x 56 on a phone rather than the desktop's 56 x 80: seven piles across a
  // 320px viewport is 37px each, so the tableau cannot be one row at *any*
  // phone card size — see the tableau's note. Within the four columns it does
  // get, 44 is exactly the floor a thumb can be relied on to find, and the
  // corner suit icons are scaled with it too - SquareIcon takes its size in
  // game pixels rather than classes, so a 0.62 transform is what stops an 18px
  // icon covering 42% of a 44px card and colliding with the rank in the middle.
  const renderCard = (card: Card, highlight = false) => {
    return (
      <div
        className={`w-[var(--card-w)] h-[var(--card-h)] border-2 ${colorBorder[card.suit]} ${colorBg[card.suit]} ${colorText[card.suit]} rounded p-1 relative shadow ${highlight ? "ring-2 ring-yellow-300" : ""}`}
      >
        <div className="absolute top-1 left-1 scale-[0.62] md:scale-100">
          <SquareIcon icon={suitImages[card.suit]} width={7} />
        </div>
        <div className="absolute bottom-1 right-1 scale-[0.62] md:scale-100 rotate-180">
          <SquareIcon icon={suitImages[card.suit]} width={7} />
        </div>
        <span className="absolute inset-0 grid place-items-center text-base md:text-xl font-bold leading-none">
          {card.rank}
        </span>
      </div>
    );
  };

  const renderCardBack = () => (
    <div className="w-[var(--card-w)] h-[var(--card-h)] border border-white/40 rounded bg-slate-700 grid place-items-center text-sm text-slate-200">
      ?
    </div>
  );

  if (!sessionMode || !gameState) {
    return (
      <OuterPanel className={solitairePanelClassName}>
        <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
          <div className="text-center space-y-2">
            <h2 className="text-4xl font-bold">SOLITAIRE</h2>
            <p className="text-sm text-gray-600">
              Klondike rules. Move all cards to the four suit foundations.
            </p>
          </div>

          <InnerPanel className="bg-yellow-100 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  REWARD
                </div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-yellow-700">
                  {SOLITAIRE_RAVEN_COIN_REWARD}
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
                <div className="text-sm text-gray-700 font-semibold">DRAW</div>
                <div className="text-2xl font-bold text-yellow-700">
                  {todaysDifficulty.drawCount}
                </div>
              </div>
            </div>
          </InnerPanel>

          <InnerPanel className="bg-slate-50 p-3 text-sm text-slate-700">
            <div className="font-semibold">Today's rules</div>
            <div className="mt-1">
              Draw {todaysDifficulty.drawCount} from stock. Redeals available:{" "}
              {todaysDifficulty.maxPasses}.
            </div>
            <div className="mt-1">
              Reward runs use today's difficulty. Practice lets you choose.
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
                    ? "VIP: reward run available for Solitaire today."
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
              onClick={() => onClose()}
              className="w-full px-6 py-2 bg-gray-400 text-white font-semibold rounded-lg hover:bg-gray-500 active:scale-95 transition-all"
            >
              EXIT
            </button>
          )}

          {showExitConfirm && (
            <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-sm rounded border border-white/30 bg-slate-900 p-4 space-y-4 text-white">
                <h3 className="text-lg font-bold">Exit Solitaire?</h3>
                <p className="text-sm text-slate-200">
                  Are you sure you want to exit? Current progress will be lost.
                </p>
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setShowExitConfirm(false)}>
                    CANCEL
                  </Button>
                  <Button onClick={() => onClose?.()}>EXIT</Button>
                </div>
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
                  {SOLITAIRE_DIFFICULTIES.map((difficulty) => (
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
                      <div className="mt-1 opacity-75">
                        Draw {difficulty.drawCount} · {difficulty.maxPasses}{" "}
                        redeals
                      </div>
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

  const selectedCard =
    gameState.selected?.source === "waste"
      ? gameState.waste[gameState.waste.length - 1]
      : gameState.selected?.source === "tableau"
        ? gameState.tableau[gameState.selected.pileIndex]?.faceUp[
            gameState.selected.cardIndex
          ]
        : undefined;

  return (
    <OuterPanel className={solitairePanelClassName}>
      <InnerPanel className="w-full h-full p-3 md:p-4 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white overflow-auto">
        {/* The card box, declared once. Every card face, back, stock and
            foundation reads it, so the pile overlaps above stay true. */}
        <div className="max-w-7xl mx-auto h-full flex flex-col gap-2 md:gap-3 [--card-w:44px] [--card-h:56px] md:[--card-w:56px] md:[--card-h:80px]">
          {/* Compressed on a phone for the same reason as Tetris': the five
              chips at `px-2 py-1 text-sm` wrapped to two 28px rows and the
              header alone was 100px of a 578px column. */}
          <div className="flex flex-wrap items-center justify-between gap-1 md:gap-2 text-sm">
            <div className="font-bold text-sm md:text-lg">
              SOLITAIRE - {activeDifficulty.label}
            </div>
            <div className="flex flex-wrap gap-1 md:gap-2 items-center">
              <span className="px-1 md:px-2 py-0 md:py-1 text-[10px] md:text-sm rounded bg-slate-700">
                Mode: {sessionMode}
              </span>
              <span className="px-1 md:px-2 py-0 md:py-1 text-[10px] md:text-sm rounded bg-slate-700">
                Moves: {gameState.moves}
              </span>
              <span className="px-1 md:px-2 py-0 md:py-1 text-[10px] md:text-sm rounded bg-slate-700">
                Foundation: {progressCount}/52
              </span>
              <span className="px-1 md:px-2 py-0 md:py-1 text-[10px] md:text-sm rounded bg-slate-700">
                Redeals: {gameState.passesRemaining}
              </span>
            </div>
          </div>

          {solved && (
            <div className="rounded border-2 border-green-400 bg-green-900/40 p-3 text-center">
              <div className="font-bold text-lg">Puzzle Solved!</div>
              <div className="text-sm mt-1">
                {sessionMode === "reward"
                  ? `Reward granted: ${SOLITAIRE_RAVEN_COIN_REWARD} RavenCoin.`
                  : "Practice complete."}
              </div>
            </div>
          )}

          {/* Stock, waste and the four foundations: **one** row of six from `md` up
              and on a phone too.

              ## Why the actions left this grid

              It was the seventh cell of a `grid-cols-2 md:grid-cols-7`, and on a
              phone that grid put Stock/Waste on row 1, two foundations on row 2,
              two on row 3 and the actions on row 4 — four rows, measured 502px,
              because each cell carried a card *and* a label *and*, in the
              actions cell, three stacked 50px buttons. Two thirds of that was the
              label text and the button chrome, not the game.

              Six slots across 320px is 44px each, which is exactly the 44px a
              thumb can be relied on to find, so the cards themselves do fit —
              they just have to be the only thing in the row. `md:` puts the
              actions back into the same grid as a seventh column, which is
              where they have always been on a desktop. */}
          <div className="grid grid-cols-6 md:grid-cols-7 gap-px md:gap-2 items-start">
            <div className="space-y-1">
              <div className="text-[9px] md:text-xs uppercase text-slate-300">
                Stock
              </div>
              <button
                type="button"
                onClick={drawFromStock}
                className="w-[var(--card-w)] h-[var(--card-h)] border border-white/40 rounded bg-slate-700 hover:bg-slate-600 grid place-items-center text-[10px] md:text-xs"
              >
                {gameState.stock.length > 0
                  ? `${gameState.stock.length}`
                  : gameState.passesRemaining > 0
                    ? "RESET"
                    : "EMPTY"}
              </button>
            </div>

            <div className="space-y-1">
              <div className="text-[9px] md:text-xs uppercase text-slate-300">
                Waste
              </div>
              {activeDifficulty.drawCount === 3 ? (
                /* The three-card fan is 92 x 80 today, which is wider than a
                   44px slot: at a 24px step it is 44 + 48 = 92 and would
                   overlap the foundation beside it. The step is a variable of
                   its own so it can shrink with the card rather than being a
                   second hard-coded pair of numbers. */
                <div
                  className="relative [--fan-step:0px] md:[--fan-step:32px]"
                  style={{
                    width: "calc(var(--card-w) + 2 * var(--fan-step))",
                    height: "var(--card-h)",
                  }}
                  onClick={selectWaste}
                >
                  {gameState.waste.length === 0
                    ? renderCardBack()
                    : (() => {
                        const visible = gameState.waste.slice(
                          Math.max(0, gameState.waste.length - 3),
                        );
                        return visible.map((card, i) => {
                          const isTop = i === visible.length - 1;
                          return (
                            <div
                              key={card.rank + card.suit}
                              className="absolute"
                              style={{
                                left: `calc(${i} * var(--fan-step))`,
                                top: 0,
                                pointerEvents: isTop ? "auto" : "none",
                                zIndex: i,
                              }}
                              onDoubleClick={
                                isTop ? () => smartMove("waste") : undefined
                              }
                            >
                              {renderCard(
                                card,
                                isTop && gameState.selected?.source === "waste",
                              )}
                            </div>
                          );
                        });
                      })()}
                </div>
              ) : (
                <div
                  onClick={selectWaste}
                  onDoubleClick={() => smartMove("waste")}
                >
                  {gameState.waste.length > 0
                    ? renderCard(
                        gameState.waste[gameState.waste.length - 1],
                        gameState.selected?.source === "waste",
                      )
                    : renderCardBack()}
                </div>
              )}
            </div>

            {SUITS.map((suit) => {
              const pile = gameState.foundations[suit];
              const top = pile[pile.length - 1];

              return (
                <div key={suit} className="space-y-1">
                  <div className="text-[9px] md:text-xs uppercase text-slate-300">
                    {suit}
                  </div>
                  <button
                    type="button"
                    onClick={() => moveSelectedToFoundation(suit)}
                    className="w-[var(--card-w)] h-[var(--card-h)] rounded border border-white/30 bg-slate-700/70 grid place-items-center"
                  >
                    {top ? (
                      <div>{renderCard(top)}</div>
                    ) : (
                      <SquareIcon icon={suitImages[suit]} width={9} />
                    )}
                  </button>
                </div>
              );
            })}

            {/* The desktop's copy of the three actions: the seventh column of
                this same grid, exactly where it has always been. The phone's row
                below is the other one — one element per breakpoint rather than
                two grids, so the buttons cannot drift apart. */}
            <div className="hidden md:block space-y-1">
              <div className="text-xs uppercase text-slate-300">Actions</div>
              <Button
                onClick={undoMove}
                disabled={undosRemaining === 0 || undoCount === 0}
              >
                Undo ({undosRemaining})
              </Button>
              <Button onClick={autoMoveToFoundation}>Auto Foundation</Button>
              {onClose && (
                <Button
                  onClick={() => {
                    if (solved) {
                      returnToMenu();
                      return;
                    }

                    setShowExitConfirm(true);
                  }}
                >
                  Exit
                </Button>
              )}
            </div>
          </div>

          {/* The three actions, as their own row on a phone and back inside the
              grid above from `md` up. `Button` renders `w-full` unless its
              className carries a width, so the phone row needs `flex-1 w-auto`
              to split the width three ways; `md:flex-none md:w-full` restores
              the stacked desktop column, because `flex-1` sets
              `flex-basis: 0%` and would otherwise beat `width` there too. */}
          <div className="flex flex-nowrap md:hidden gap-1.5">
            <Button
              onClick={undoMove}
              disabled={undosRemaining === 0 || undoCount === 0}
              className="flex-1 w-auto text-xs"
            >
              Undo ({undosRemaining})
            </Button>
            <Button
              onClick={autoMoveToFoundation}
              className="flex-1 w-auto text-xs"
            >
              Auto
            </Button>
            {onClose && (
              <Button
                onClick={() => {
                  if (solved) {
                    returnToMenu();
                    return;
                  }

                  setShowExitConfirm(true);
                }}
                className="flex-1 w-auto text-xs"
              >
                Exit
              </Button>
            )}
          </div>

          {/* The seven tableau piles.

              ## Why four across on a phone and not seven

              Seven piles across the 274px a 320px viewport leaves for content
              is 37px each, and the floor for a card a thumb can find is 44px —
              so a single row is not available at any card size that is legal to
              tap. `grid-cols-4` gives 64px columns for a 48px card and wraps
              into two rows of four and three, which is what every phone Klondike
              does.

              The cost is height: two pile rows at once. At 320x640 the whole
              column is 578px and the pile rows get ~330 of it between them,
              which is what sizes the reveal in the overlap constants above —
              13 cards (the most a Klondike pile can hold) at 10px of reveal is
              64 + 120 = 184px of stack in a 200px slot.

              From `lg` up this is the original `grid-cols-7`, one row, one
              280px min-height — the desktop is untouched. */}
          <div className="mt-0.5 md:mt-1 grid grid-cols-4 lg:grid-cols-7 gap-1 md:gap-2 flex-1 lg:flex-none min-h-0">
            {gameState.tableau.map((pile, pileIndex) => (
              <button
                type="button"
                key={`tableau-${pileIndex}`}
                onClick={() => moveSelectedToTableau(pileIndex)}
                className="min-h-[172px] md:min-h-[280px] rounded border border-slate-600 bg-slate-900/40 p-1 text-left flex flex-col"
              >
                <div className="text-[9px] md:text-[10px] uppercase text-slate-400 mb-0.5 md:mb-1">
                  Pile {pileIndex + 1}
                </div>
                <div className="flex flex-col items-center justify-start h-full">
                  {pile.faceDown.map((card, downIndex) => (
                    <div
                      key={`down-${card.suit}-${card.rank}-${downIndex}`}
                      className={downIndex > 0 ? FACE_DOWN_OVERLAP_CLASS : ""}
                    >
                      {renderCardBack()}
                    </div>
                  ))}
                  {pile.faceUp.map((card, upIndex) => {
                    const isSelectedFromPile =
                      gameState.selected?.source === "tableau" &&
                      gameState.selected.pileIndex === pileIndex &&
                      upIndex >= gameState.selected.cardIndex;
                    const isFirstFaceUpAfterFaceDown =
                      upIndex === 0 && pile.faceDown.length > 0;
                    const isRevealSpacingCard = upIndex === 1;

                    return (
                      <div
                        key={`up-${card.suit}-${card.rank}-${upIndex}`}
                        className={
                          isFirstFaceUpAfterFaceDown
                            ? FACE_UP_AFTER_FACE_DOWN_OVERLAP_CLASS
                            : isRevealSpacingCard
                              ? FACE_UP_TOP_CARD_OVERLAP_CLASS
                              : upIndex > 0
                                ? FACE_UP_STACK_OVERLAP_CLASS
                                : ""
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          handleTableauCardClick(pileIndex, upIndex);
                        }}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          smartMove({ pileIndex, cardIndex: upIndex });
                        }}
                      >
                        {renderCard(card, isSelectedFromPile)}
                      </div>
                    );
                  })}
                </div>
              </button>
            ))}
          </div>

          {/* One line on a phone, the full two-sentence version from `md` up. At
              `text-xs` across 274px the original wraps to three lines and eats
              48px of the vertical budget the pile rows need; what survives is
              the part that is not obvious from looking at it. */}
          <div className="text-[10px] md:text-xs text-slate-300 leading-tight">
            <span className="md:hidden">
              Tap a card, then a pile. Empty piles take Kings only.
            </span>
            <span className="hidden md:inline">
              Click a card to select it, then click a tableau pile or foundation
              to move. Empty tableau piles only accept Kings.
            </span>
            {selectedCard && (
              <span className="ml-2 text-yellow-300">
                Selected: {selectedCard.rank} of {selectedCard.suit}
              </span>
            )}
          </div>
        </div>

        {showExitConfirm && (
          <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded border border-white/30 bg-slate-900 p-4 space-y-4 text-white">
              <h3 className="text-lg font-bold">Exit Solitaire?</h3>
              <p className="text-sm text-slate-200">
                Are you sure you want to exit? Current progress will be lost.
              </p>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setShowExitConfirm(false)}>
                  CANCEL
                </Button>
                <Button
                  onClick={() => {
                    if (solved) {
                      returnToMenu();
                      return;
                    }

                    onClose?.();
                  }}
                >
                  EXIT
                </Button>
              </div>
            </div>
          </div>
        )}
      </InnerPanel>
    </OuterPanel>
  );
};
