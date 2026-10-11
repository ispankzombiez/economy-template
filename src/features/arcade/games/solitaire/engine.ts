/**
 * Solitaire's rules engine — the pure half of the cabinet.
 *
 * ## Why this file exists
 *
 * The rules used to live inside `SolitaireGame.tsx`'s callbacks, which is
 * exactly where rules for a *verified* cabinet cannot stay: the reward worker
 * re-simulates a claimed game from its action log, and re-simulation means
 * running the same transitions the player ran. Two options — copy the rules
 * into the worker, or import them — have only one safe answer. A second
 * implementation of one ruleset is two opinions about what a legal move is,
 * and a cheater always plays the more lenient one. So the rules live here, and
 * both the React component and the worker import this file; `engine.ts` sits
 * under `src/` (not `shared/`) for the same reason the brawler's does — it is
 * the client's engine, imported by the server, not a negotiated protocol.
 *
 * ## Why moves are semantic, not click-by-click
 *
 * The UI is selection-based (tap a card, tap a target), but the appliers take
 * an explicit *source* and a target. Selection is UI state: it is fully
 * determined by the sources of the moves that follow it, and replaying taps
 * would double the log's length to reconstruct information the verifier never
 * needs. Each applier is the exact body the component's callback used to run
 * inline, with `previous.selected` replaced by the `source` parameter — the
 * one substitution a logged move requires.
 *
 * ## The one rule replay must add: undo
 *
 * Every applier returns the *same object* when a move is illegal or changes
 * nothing, and that identity is load-bearing. The client logs an action only
 * when its applier returned a new state, so a log contains exactly the moves
 * that changed the game — and the driver below treats an action that changes
 * nothing as a hard stop (`failedAt`), which is what turns a tampered log into
 * a refusal rather than a plausible-looking replay. Undo cannot be an applier
 * on a single state (it *reverts* one), so `replaySolitaireActions` keeps the
 * history stack the component keeps in `undoHistoryRef`, pushing under the
 * same rule: one entry per action that changed the state, popped by `UNDO`,
 * capped by `MAX_UNDOS_PER_GAME` — the allowance is a rule of this game, and
 * a verifier that let a log undo fifty times would be verifying a different
 * game than the one the cabinet deals.
 *
 * No `Math.random` and no clock anywhere below this line — the same deal and
 * the same moves must produce the same board on a phone and on a worker.
 */

import type { Card, CardRank, CardSuit } from "../poker/types";
import type { SolitaireAction } from "@nightshade/shared/anticheat/solitaireLog";
import { SOLITAIRE_OPS } from "@nightshade/shared/anticheat/solitaireLog";
import type {
  FoundationPiles,
  SelectedCard,
  SolitaireState,
  TableauPile,
} from "./types";

export const SUITS: CardSuit[] = ["Kale", "Barley", "Wheat", "Radish"];
export const RANKS: CardRank[] = [
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

export const RANK_VALUE: Record<CardRank, number> = {
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

/**
 * Undos a player may spend per game.
 *
 * A rule of the cabinet, enforced in the UI by the button's counter and in the
 * verifier by `replaySolitaireActions` counting `UNDO` actions — a log that
 * undoes more than this is not this game's log, however well its moves replay.
 */
export const MAX_UNDOS_PER_GAME = 3;

/** The board a run is won on: every suit, every rank, on the foundations. */
export const SOLITAIRE_WIN_SCORE = 52;

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

export const createInitialState = (
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
export const greedySolve = (
  initial: SolitaireState,
  drawCount: number,
): boolean => {
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

    // 3. Full stack that reveals a face-down card (prefer most fd)
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
 *
 * Returns the *resolved* seed beside the state — the seed the deck was
 * actually dealt from, which is `seed + i` whenever the search did not stop on
 * the first try. The claim carries this one, and the worker rebuilds the deal
 * with a single `createInitialState` rather than repeating the greedy search:
 * solvability is a client-side courtesy (the player gets a winnable board),
 * not a security property — the proof of a win is the move list replaying to
 * fifty-two cards, and re-running the search server-side would hand any caller
 * a way to burn the worker's 10 ms budget on a hundred solver passes.
 */
export const createSolvableDeal = (
  seed: number,
  maxPasses: number,
  drawCount: number,
): { state: SolitaireState; seed: number } => {
  for (let i = 0; i < 100; i++) {
    const trySeed = (seed + i) >>> 0;
    const state = createInitialState(trySeed, maxPasses);
    if (greedySolve(state, drawCount)) return { state, seed: trySeed };
  }
  return { state: createInitialState(seed, maxPasses), seed: seed >>> 0 };
};

export const canPlaceOnTableau = (movingCard: Card, targetTop?: Card) => {
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

export const canPlaceOnFoundation = (card: Card, foundation: Card[]) => {
  if (foundation.length === 0) {
    return card.rank === "A";
  }

  const top = foundation[foundation.length - 1];
  return (
    card.suit === top.suit && RANK_VALUE[card.rank] === RANK_VALUE[top.rank] + 1
  );
};

export const getFoundationsCount = (state: SolitaireState) =>
  SUITS.reduce((total, suit) => total + state.foundations[suit].length, 0);

// ---------------------------------------------------------------------------
// Semantic move appliers
//
// Each is the exact body that used to run inline in the component's
// `setGameStateWithUndo` callback, with `previous.selected` replaced by a
// `source` parameter. Returning the input object unchanged (not a copy) when
// the move is illegal is deliberate and load-bearing: the component logs an
// action only when the returned state differs, and `replaySolitaireActions`
// treats a no-change action in a log as tampering.
// ---------------------------------------------------------------------------

/** Draw from the stock, or recycle the waste when the stock is empty. */
export const applyDraw = (
  previous: SolitaireState,
  drawCount: number,
): SolitaireState => {
  if (previous.stock.length > 0) {
    const count = Math.min(drawCount, previous.stock.length);
    const stock = [...previous.stock];
    const drawn = stock.splice(stock.length - count, count);

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
};

/** Move the selected run — one card off the waste, a run off a tableau pile. */
export const applyMoveToTableau = (
  previous: SolitaireState,
  source: SelectedCard | null,
  targetIndex: number,
): SolitaireState => {
  if (!source) return previous;

  const tableau = previous.tableau.map((pile) => ({
    faceDown: [...pile.faceDown],
    faceUp: [...pile.faceUp],
  }));

  let movingCards: Card[] = [];

  if (source.source === "waste") {
    const wasteTop = previous.waste[previous.waste.length - 1];
    if (!wasteTop) return previous;
    movingCards = [wasteTop];
  } else {
    const sourcePile = tableau[source.pileIndex];
    movingCards = sourcePile.faceUp.slice(source.cardIndex);
  }

  if (movingCards.length === 0) return previous;

  const targetPile = tableau[targetIndex];
  const targetTop = targetPile.faceUp[targetPile.faceUp.length - 1];

  if (!canPlaceOnTableau(movingCards[0], targetTop)) return previous;

  let waste = [...previous.waste];

  if (source.source === "waste") {
    waste = waste.slice(0, -1);
  } else {
    const sourcePile = tableau[source.pileIndex];
    sourcePile.faceUp = sourcePile.faceUp.slice(0, source.cardIndex);

    if (sourcePile.faceUp.length === 0 && sourcePile.faceDown.length > 0) {
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
};

/** Move one card — waste top or tableau top — onto its suit's foundation. */
export const applyMoveToFoundation = (
  previous: SolitaireState,
  source: SelectedCard | null,
  targetSuit: CardSuit,
): SolitaireState => {
  if (!source) return previous;

  let movingCard: Card | undefined;
  let waste = [...previous.waste];
  const tableau = previous.tableau.map((pile) => ({
    faceDown: [...pile.faceDown],
    faceUp: [...pile.faceUp],
  }));

  if (source.source === "waste") {
    movingCard = waste[waste.length - 1];
  } else {
    const sourcePile = tableau[source.pileIndex];
    const isTopCard = source.cardIndex === sourcePile.faceUp.length - 1;
    if (!isTopCard) return previous;

    movingCard = sourcePile.faceUp[sourcePile.faceUp.length - 1];
  }

  if (!movingCard || movingCard.suit !== targetSuit) return previous;

  const foundation = previous.foundations[targetSuit];
  if (!canPlaceOnFoundation(movingCard, foundation)) return previous;

  if (source.source === "waste") {
    waste = waste.slice(0, -1);
  } else {
    const sourcePile = tableau[source.pileIndex];
    sourcePile.faceUp = sourcePile.faceUp.slice(0, -1);

    if (sourcePile.faceUp.length === 0 && sourcePile.faceDown.length > 0) {
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
};

/**
 * Sweep every card that can go up, repeatedly, until none can.
 *
 * One action in the log however many cards it moves — the sweep is a
 * deterministic function of the state, so one action is both how the player
 * experiences it and how the verifier replays it, and one undo reverts the
 * whole sweep exactly as the UI does.
 */
export const applyAutoFoundation = (
  previous: SolitaireState,
): SolitaireState => {
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
};

/**
 * Double-click move: foundation first if the card is a pile top, else the first
 * tableau pile that accepts it (skipping its own).
 */
export const applySmartMove = (
  previous: SolitaireState,
  source: SelectedCard | null,
): SolitaireState => {
  if (!source) return previous;

  const tableau = previous.tableau.map((pile) => ({
    faceDown: [...pile.faceDown],
    faceUp: [...pile.faceUp],
  }));
  let waste = [...previous.waste];

  let movingCard: Card | undefined;
  let isTopCard: boolean;

  if (source.source === "waste") {
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
      if (source.source === "waste") {
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
    source.source === "waste"
      ? [movingCard]
      : tableau[source.pileIndex].faceUp.slice(source.cardIndex);

  for (let i = 0; i < tableau.length; i++) {
    if (source.source === "tableau" && source.pileIndex === i) continue;
    const targetPile = tableau[i];
    const targetTop = targetPile.faceUp[targetPile.faceUp.length - 1];
    if (!canPlaceOnTableau(movingCards[0], targetTop)) continue;

    if (source.source === "waste") {
      waste = waste.slice(0, -1);
    } else {
      const sp = tableau[source.pileIndex];
      sp.faceUp = sp.faceUp.slice(0, source.cardIndex);
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
};

/**
 * Apply one logged action — every opcode except `UNDO`, which reverts state
 * and therefore cannot be an applier on a single state (see
 * `replaySolitaireActions`, which owns the history stack).
 *
 * A decoded `SolitaireSource` is handed to the appliers as-is: the two types
 * are the same shape on purpose, so there is no conversion step where a
 * source could be re-interpreted.
 */
export const applySolitaireAction = (
  state: SolitaireState,
  action: SolitaireAction,
  drawCount: number,
): SolitaireState => {
  switch (action.op) {
    case SOLITAIRE_OPS.DRAW:
      return applyDraw(state, drawCount);
    case SOLITAIRE_OPS.MOVE_TO_TABLEAU:
      return applyMoveToTableau(state, action.source as SelectedCard, action.target);
    case SOLITAIRE_OPS.MOVE_TO_FOUNDATION:
      return applyMoveToFoundation(
        state,
        action.source as SelectedCard,
        SUITS[action.suit],
      );
    case SOLITAIRE_OPS.AUTO_FOUNDATION:
      return applyAutoFoundation(state);
    case SOLITAIRE_OPS.SMART:
      return applySmartMove(state, action.source as SelectedCard);
    default:
      // `UNDO` is handled by the driver; anything else never decoded.
      return state;
  }
};

export type SolitaireReplayResult = {
  /** The board after the last action (or the last one that applied). */
  state: SolitaireState;
  /**
   * Index of the first action that changed nothing, or -1.
   *
   * The client logs an action only when its applier returned a new state, so
   * in an honest log every action applies. An action that changes nothing
   * means the log was assembled for a different deal, spliced, or forged —
   * the driver stops there rather than replaying the rest of a fiction.
   */
  failedAt: number;
  /** How many `UNDO` actions the log contained. */
  undoCount: number;
  /** True when the log undid more than `MAX_UNDOS_PER_GAME` times. */
  undoLimitExceeded: boolean;
};

/**
 * Replay a whole game's action log against its deal.
 *
 * Mirrors the component's bookkeeping exactly: one history entry per action
 * that changed the state, `UNDO` pops one, and the undo allowance is counted
 * (not enforced mid-log — the first three undos are as legal as any move; it
 * is the *count* over the limit that makes the log not-this-game's).
 */
export const replaySolitaireActions = (
  initial: SolitaireState,
  actions: SolitaireAction[],
  drawCount: number,
): SolitaireReplayResult => {
  let state = initial;
  const history: SolitaireState[] = [];
  let undoCount = 0;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];

    if (action.op === SOLITAIRE_OPS.UNDO) {
      if (history.length === 0) {
        return {
          state,
          failedAt: i,
          undoCount,
          undoLimitExceeded: undoCount > MAX_UNDOS_PER_GAME,
        };
      }
      undoCount += 1;
      state = history.pop()!;
      continue;
    }

    const next = applySolitaireAction(state, action, drawCount);
    if (next === state) {
      return {
        state,
        failedAt: i,
        undoCount,
        undoLimitExceeded: undoCount > MAX_UNDOS_PER_GAME,
      };
    }
    history.push(state);
    state = next;
  }

  return {
    state,
    failedAt: -1,
    undoCount,
    undoLimitExceeded: undoCount > MAX_UNDOS_PER_GAME,
  };
};
