/**
 * Go Fish — the pure rules engine, shared verbatim by the cabinet and the
 * Cloudflare Worker's replay verifier.
 *
 * ## Why this file exists
 *
 * The worker mints a Raven Coin only if its own replay of the claimed asks
 * ends in a player win. That guarantee has exactly one shape: the same rules,
 * on both sides, from the same source. A second implementation of these rules
 * — even an honest one, written here for the server — would be the single most
 * dangerous thing this package could do: two implementations of one ruleset
 * disagree, and a cheater plays whichever one is more lenient. So the worker
 * imports *this* file, the one the component deals from.
 *
 * ## The seeded deal, and the RNG that outlives it
 *
 * Solitaire's replay rebuilds its deal from a seed and then plays a purely
 * deterministic game — no further randomness touches the board. Go Fish has
 * one more roll: the dealer's choice of which rank to ask for, once per dealer
 * turn. So the seed does not stop at the shuffle; the *same* generator that
 * shuffled the deck keeps advancing through the game, and its state rides in
 * `state.rng` so the next ask resumes the identical stream.
 *
 * That is why `PokerDeck` takes an RNG function (see poker/deck.ts): the deck
 * is built over `() => advanceRng(rngState)`, so the 51 shuffle swaps and every
 * dealer choice after them come from one 32-bit integer stream — identical in
 * integer arithmetic on a phone and on a worker. The client cannot precompute
 * a winning ask sequence any more than the brawler can precompute a winning
 * input log: both would need to know a seed the run carries from its start.
 *
 * `state.rng` is a plain `{ a }` object (see `rng.js`) mutated in place, and
 * the state spreads share that one reference — the same bargain the deck
 * itself makes (`deal()` mutates the deck's private array while the state
 * around it is copied freely). There is no branching anywhere below: one
 * linear game, one stream, both sides.
 *
 * ## The ask is validated here, not just in the UI
 *
 * A player may only ask for a rank they hold — that is both a rule of the
 * game and the reason an honest log can never contain a dead action. The
 * component already only offers buttons for held ranks, but the engine
 * enforces it too, because the worker replays *logs*, and a log is
 * attacker-controlled bytes: an ask for an unheld rank returns the state
 * unchanged, which `replayGoFishActions` reports as a dead action at its
 * exact index — the tamper signal, not a weaker check.
 *
 * ## Known quirks, preserved on purpose
 *
 * Two softlocks exist in the original game and are kept, because "fix the
 * rules" and "verify the rules" are different changes and this file is the
 * second: (1) if the dealer's hand empties while the player still holds cards
 * and the stock is empty, the turn stays with a dealer who cannot act; (2) an
 * empty player hand with a non-empty stock is not auto-refilled at the start
 * of the player's turn (only after a take or a matched draw). Both end runs
 * without a claim — they can never mint on a replay the worker accepts.
 */

import type { Card, CardRank } from "../poker/types";
import { PokerDeck } from "../poker/deck";
import {
  advanceRng,
  makeRngState,
  type RngState,
} from "@nightshade/shared/anticheat/rng";

/** Ranks in canonical order — also the codec's byte values (2–A as 0–12). */
export const RANK_ORDER: CardRank[] = [
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

export type GoFishTurn = "player" | "dealer";
export type GoFishWinner = "player" | "dealer" | "tie";

export type GoFishState = {
  /** Seeded over the run's generator — `deal()` draws from `state.rng`. */
  deck: PokerDeck;
  /**
   * The run's RNG stream, advanced in place.
   *
   * The single source of randomness the replay must reproduce: the shuffle
   * consumed the first 51 draws when the deck was built, and every dealer
   * ask consumes one more. Plain `{ a }` so a parked verifier could round-trip
   * it — Go Fish replays whole in one request, but the state shape stays
   * serializable so nothing about it is accidentally unverifiable later.
   */
  rng: RngState;
  playerHand: Card[];
  dealerHand: Card[];
  playerBooks: CardRank[];
  dealerBooks: CardRank[];
  turn: GoFishTurn;
  selectedRank: CardRank | null;
  /** Display log, newest first. UI only — the action log is the proof. */
  log: string[];
  gameOver: boolean;
  winner: GoFishWinner | null;
};

export const sortHand = (hand: Card[]): Card[] => {
  return [...hand].sort(
    (a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank),
  );
};

export const getRanksInHand = (hand: Card[]): CardRank[] => {
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

export const drawCard = (deck: PokerDeck): Card | null => {
  if (deck.getRemaining() <= 0) {
    return null;
  }

  return deck.deal();
};

export const extractBooks = (
  hand: Card[],
): { books: CardRank[]; hand: Card[] } => {
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

export const removeRankCards = (
  hand: Card[],
  rank: CardRank,
): { removed: Card[]; remaining: Card[] } => {
  const removed = hand.filter((card) => card.rank === rank);
  const remaining = hand.filter((card) => card.rank !== rank);

  return { removed, remaining };
};

export const groupCardsByRank = (hand: Card[]): Card[][] => {
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

export const maybeFinalizeGame = (state: GoFishState): GoFishState => {
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

  const winner: GoFishWinner =
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

/**
 * Deal a fresh game from a seed.
 *
 * The seed is the run's whole proof: it fixes the shuffle (51 draws from the
 * generator) *and* every dealer choice that follows, because the deck's RNG
 * and `state.rng` are the same stream. The client picks the seed when the run
 * opens — the same client-chosen-seed posture as Solitaire and the brawler,
 * which becomes server-issued for every cabinet together in Stage C, not here.
 */
export const createInitialState = (seed: number): GoFishState => {
  const rng = makeRngState(seed);
  const deck = new PokerDeck(() => advanceRng(rng));

  let playerHand = deck.dealMultiple(7);
  let dealerHand = deck.dealMultiple(7);

  const playerBookResult = extractBooks(playerHand);
  playerHand = playerBookResult.hand;

  const dealerBookResult = extractBooks(dealerHand);
  dealerHand = dealerBookResult.hand;

  const state: GoFishState = {
    deck,
    rng,
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

export const playerDrawIfNeeded = (nextState: GoFishState): GoFishState => {
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
};

export const dealerDrawIfNeeded = (nextState: GoFishState): GoFishState => {
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
};

/**
 * The dealer's whole turn, run synchronously — asks, takes, go-fish draws and
 * the bookkeeping between them — exactly as the component ran it inside the
 * player's click handler.
 *
 * The one roll per ask (`advanceRng`) draws from the run's shared stream, so
 * replaying the same asks from the same seed reaches the same dealer choices:
 * the turn has no wall clock and no closure state, only the state passed in
 * and the stream it advances.
 */
export const dealerTurn = (current: GoFishState): GoFishState => {
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
      rankOptions[Math.floor(advanceRng(next.rng) * rankOptions.length)];

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
};

/**
 * Ask the dealer for `rank` — the one player action, and the whole player
 * half of the game.
 *
 * Returns the state unchanged for anything that is not a legal ask (not the
 * player's turn, game over, or a rank the player does not hold). The
 * component logs an action only when the state changed, so an honest log
 * contains exactly the asks that happened — and `replayGoFishActions` treats
 * an unchanged return as a dead action, the tamper signal described above.
 */
export const askForRank = (
  currentState: GoFishState,
  rank: CardRank,
): GoFishState => {
  if (currentState.turn !== "player" || currentState.gameOver) {
    return currentState;
  }

  if (!currentState.playerHand.some((card) => card.rank === rank)) {
    return currentState;
  }

  let next: GoFishState = {
    ...currentState,
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

    return maybeFinalizeGame(next);
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

    return maybeFinalizeGame(next);
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
    return next;
  }

  // Both trailing finalize calls are kept from the component's original flow.
  // Neither can fire (the draw paths above already finalized, and neither
  // follow-up changes the book count or empties both hands), but the sequence
  // is transcribed verbatim: "verify the rules" must not drift from them.
  if (drawn.rank === rank) {
    return maybeFinalizeGame(playerDrawIfNeeded(next));
  }

  return maybeFinalizeGame(
    dealerTurn({
      ...next,
      turn: "dealer",
    }),
  );
};

/**
 * Re-apply a claimed game's asks to its deal — the worker's half.
 *
 * Same contract as Solitaire's `replaySolitaireActions`: an ask that changes
 * nothing is a dead action, and the index it died at is returned rather than
 * thrown, so the verdict can say *where* the log stopped being a game. An
 * honest log has no dead asks (the component only logs asks the engine
 * applied), so `failedAt !== -1` always means the log was not produced by
 * this engine.
 *
 * @param initial  State from `createInitialState(seed)`.
 * @param ranks    Rank indices (codec bytes), in play order.
 * @returns The final state, and `failedAt` (`-1` when every ask applied).
 */
export const replayGoFishActions = (
  initial: GoFishState,
  ranks: number[],
): { state: GoFishState; failedAt: number } => {
  let state = initial;

  for (let i = 0; i < ranks.length; i++) {
    const rank = RANK_ORDER[ranks[i]];
    if (rank === undefined) {
      return { state, failedAt: i };
    }

    const next = askForRank(state, rank);
    if (next === state) {
      return { state, failedAt: i };
    }

    state = next;
  }

  return { state, failedAt: -1 };
};
