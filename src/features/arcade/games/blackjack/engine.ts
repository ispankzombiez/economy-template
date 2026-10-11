/**
 * Blackjack — the pure rules engine, shared verbatim by the cabinet and the
 * Cloudflare Worker's replay verifier.
 *
 * The worker mints a Raven Coin only if its own replay of the claimed session
 * ends in a session win (targetChips reached within maxHands) at the chip
 * count the claim asserts. That guarantee has exactly one shape: the same
 * rules, on both sides, from the same source. A second implementation of these
 * rules — even an honest one, written here for the server — would be the
 * single most dangerous thing this package could do: two implementations of
 * one ruleset disagree, and a cheater plays whichever one is more lenient. So
 * the worker imports *this* file, the one the component deals from.
 *
 * ## The seeded session, and the RNG that outlives it
 *
 * A Blackjack session is a sequence of hands. Each hand deals from a fresh
 * BlackjackDeck (which uses the same RNG stream the session was created with).
 * The seed fixes every shuffle: hand 1 consumes 52 draws from the generator,
 * hand 2 the next 52, and so on. The *same* generator that shuffles the first
 * deck keeps advancing through the session, and its state rides in
 * `state.rng` so the next hand resumes the identical stream. The client cannot
 * precompute a winning action sequence any more than the brawler can
 * precompute a winning input log: both would need to know a seed the run
 * carries from its start.
 *
 * `state.rng` is a plain `{ a }` object (see `rng.js`) mutated in place, and
 * the state spreads share that one reference — the same bargain the deck
 * itself makes (`deal()` mutates the deck's private array while the state
 * around it is copied freely). There is no branching anywhere below: one
 * linear session, one stream, both sides.
 *
 * ## The action log, and what it does not include
 *
 * The log records only the player's choices: the bet for each hand, and the
 * player's actions within it (HIT/STAND/DOUBLE). The dealer's play is *not*
 * logged — it is a pure function of the remaining deck (hit until soft 17+),
 * so the replay engine re-runs it deterministically from the same deck state.
 * This keeps the log tiny: a session is a few dozen bytes, and replaying it is
 * microseconds.
 *
 * ## Daily difficulty: derived, not believed
 *
 * Blackjack has a daily difficulty (targetChips, maxHands) derived from the
 * UTC date — exactly like Solitaire. The client's `getBlackjackDifficulty`
 * is imported and re-run by the worker, so a table change here and on the
 * worker cannot drift apart. A claim may cross UTC midnight; yesterday's
 * difficulty is the only other acceptable answer. Any other difficulty name is
 * refused as the "always claim easy" hole, closed by re-deriving from the
 * date.
 *
 * The difficulty is *not* encoded in the action log — it is a separate field
 * in the claim's replay payload, validated before any replay begins.
 */

import type { Card, CardRank } from "../poker/types";
import { PokerDeck } from "../poker/deck";
import {
  advanceRng,
  makeRngState,
  type RngState,
} from "@nightshade/shared/anticheat/rng";
import {
  BLACKJACK_DIFFICULTIES,
  getBlackjackDifficulty,
  type BlackjackDifficulty,
  type BlackjackDifficultyName,
} from "./session";
import {
  BLACKJACK_ACTION,
  MAX_BLACKJACK_ACTIONS,
  MAX_BLACKJACK_HANDS,
} from "@nightshade/shared/anticheat/blackjackLog";

/** Ranks in canonical order — same as poker deck. */
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

export type BlackjackStatus =
  | "idle"
  | "dealing"
  | "player_turn"
  | "dealer_turn"
  | "gameover";

export type BlackjackResult = "player" | "dealer" | "push" | "blackjack";

export interface BlackjackHandState {
  playerHand: Card[];
  dealerHand: Card[];
  currentBet: number;
  status: BlackjackStatus;
  lastResult: BlackjackResult | null;
  lastNetChips: number;
  deck: PokerDeck;
  handStartChips: number;
  handBet: number;
}

export interface BlackjackSessionState {
  /** The run's RNG stream, advanced in place across all hands. */
  rng: RngState;
  /** The difficulty this session was started with. */
  difficulty: BlackjackDifficulty;
  /** Session-level totals. */
  handsPlayed: number;
  playerChips: number;
  totalWinnings: number;
  totalLosses: number;
  /** Current hand state, or null between hands. */
  currentHand: BlackjackHandState | null;
  /** Session-level game over flag. */
  sessionOver: boolean;
  /** Whether the session was won (targetChips reached). */
  sessionWon: boolean;
}

/** The full state the cabinet and worker share. */
export type BlackjackState = BlackjackSessionState;

/**
 * Calculate hand value — pure function, no side effects.
 * Identical to session.ts's calculateHandValue; must not diverge.
 */
export function calculateHandValue(hand: Card[]): {
  hard: number;
  soft: number;
  isBust: boolean;
  isBlackjack: boolean;
} {
  const RANK_VALUES: Record<CardRank, number> = {
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
    "8": 8,
    "9": 9,
    "10": 10,
    J: 10,
    Q: 10,
    K: 10,
    A: 11,
  };

  let total = 0;
  let aces = 0;

  for (const card of hand) {
    const value = RANK_VALUES[card.rank];
    total += value;
    if (card.rank === "A") aces++;
  }

  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }

  const isBlackjack = hand.length === 2 && total === 21;

  const hard = hand.reduce(
    (sum, c) => sum + (c.rank === "A" ? 1 : RANK_VALUES[c.rank]),
    0,
  );

  return {
    hard,
    soft: total,
    isBust: total > 21,
    isBlackjack,
  };
}

/**
 * Create a fresh BlackjackDeck using the session's RNG stream.
 * The deck's shuffle consumes 51 draws from the generator.
 */
export function createDeckFromRng(rng: () => number): PokerDeck {
  return new PokerDeck(rng);
}

/**
 * Deal the initial 2 cards to player and dealer for a new hand.
 * Returns the new hand state.
 */
export function dealInitialHand(
  deck: PokerDeck,
  bet: number,
  handStartChips: number,
): BlackjackHandState {
  const playerHand = [deck.deal(), deck.deal()];
  const dealerHand = [deck.deal(), deck.deal()];

  // Check for immediate blackjacks
  const pv = calculateHandValue(playerHand);
  const dv = calculateHandValue(dealerHand);

  let status: BlackjackStatus = "player_turn";
  let lastResult: BlackjackResult | null = null;
  let lastNetChips = 0;

  if (pv.isBlackjack || dv.isBlackjack) {
    status = "gameover";
    // Resolution happens in resolveHand, but we mark it for the UI
  }

  return {
    playerHand,
    dealerHand,
    currentBet: bet,
    status,
    lastResult,
    lastNetChips,
    deck,
    handStartChips,
    handBet: bet,
  };
}

/**
 * Resolve a hand: play out dealer, determine result, compute net chips.
 * Returns the updated session state.
 */
export function resolveHand(
  session: BlackjackSessionState,
  hand: BlackjackHandState,
): BlackjackSessionState {
  const deck = hand.deck;
  const bet = hand.currentBet;
  const chipsAfterBet = hand.handStartChips - bet;

  // Dealer plays: hit until soft 17+
  const dealerFinal = [...hand.dealerHand];
  let dv = calculateHandValue(dealerFinal);

  while (dv.soft < 17) {
    dealerFinal.push(deck.deal());
    dv = calculateHandValue(dealerFinal);
  }

  const pv = calculateHandValue(hand.playerHand);

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
  const wonSession = finalChips >= session.difficulty.targetChips;
  const endSession =
    wonSession || finalChips <= 0 || session.handsPlayed >= session.difficulty.maxHands;

  const won = netChips > 0 ? netChips : 0;
  const lost = netChips < 0 ? Math.abs(netChips) : 0;

  return {
    ...session,
    handsPlayed: session.handsPlayed + 1,
    playerChips: finalChips,
    totalWinnings: session.totalWinnings + won,
    totalLosses: session.totalLosses + lost,
    currentHand: {
      ...hand,
      dealerHand: dealerFinal,
      status: "gameover",
      lastResult: result,
      lastNetChips: netChips,
    },
    sessionOver: endSession,
    sessionWon: wonSession,
  };
}

/**
 * Apply a player action to the current hand.
 * Returns the updated hand state, or the same state if the action is illegal.
 */
export function applyAction(
  session: BlackjackSessionState,
  action: number,
): BlackjackSessionState {
  if (!session.currentHand || session.currentHand.status !== "player_turn") {
    return session;
  }

  const hand = session.currentHand;
  const deck = hand.deck;

  if (action === BLACKJACK_ACTION.HIT) {
    const card = deck.deal();
    const newPlayerHand = [...hand.playerHand, card];
    const pv = calculateHandValue(newPlayerHand);

    if (pv.isBust || pv.soft === 21) {
      // Hand ends — resolve it
      return resolveHand(session, {
        ...hand,
        playerHand: newPlayerHand,
        status: "dealer_turn",
      });
    }

    return {
      ...session,
      currentHand: {
        ...hand,
        playerHand: newPlayerHand,
      },
    };
  }

  if (action === BLACKJACK_ACTION.STAND) {
    return resolveHand(session, {
      ...hand,
      status: "dealer_turn",
    });
  }

  if (action === BLACKJACK_ACTION.DOUBLE) {
    if (hand.handStartChips - hand.handBet < hand.handBet) {
      return session; // not enough chips to double
    }
    const card = deck.deal();
    const newPlayerHand = [...hand.playerHand, card];
    return resolveHand(session, {
      ...hand,
      currentBet: hand.currentBet * 2,
      playerHand: newPlayerHand,
      status: "dealer_turn",
    });
  }

  return session;
}

/**
 * Start a new hand with the given bet.
 * Returns the updated session state.
 */
export function startHand(
  session: BlackjackSessionState,
  bet: number,
): BlackjackSessionState {
  if (session.sessionOver) return session;
  if (session.playerChips < bet) return session;

  const deck = createDeckFromRng(() => advanceRng(session.rng));
  const newHand = dealInitialHand(deck, bet, session.playerChips);

  return {
    ...session,
    currentHand: newHand,
  };
}

/**
 * Start the next hand (between hands) — carries chips forward.
 * Returns the updated session state.
 */
export function nextHand(session: BlackjackSessionState): BlackjackSessionState {
  if (session.sessionOver) return session;
  return {
    ...session,
    currentHand: null,
  };
}

/**
 * Create the initial session state from a seed and difficulty.
 * The seed is the run's whole proof: it fixes every shuffle across all hands.
 */
export function createInitialState(
  seed: number,
  difficulty: BlackjackDifficulty,
): BlackjackState {
  const rng = makeRngState(seed);
  return {
    rng,
    difficulty,
    handsPlayed: 0,
    playerChips: 100, // BLACKJACK_STARTING_CHIPS
    totalWinnings: 0,
    totalLosses: 0,
    currentHand: null,
    sessionOver: false,
    sessionWon: false,
  };
}

/**
 * Re-apply a claimed session's actions to its deal — the worker's half.
 *
 * Same contract as Go Fish's `replayGoFishActions`: an action that changes
 * nothing is a dead action, and the index it died at is returned rather than
 * thrown, so the verdict can say *where* the log stopped being a game. An
 * honest log has no dead actions (the component only logs actions the engine
 * applied), so `failedAt !== -1` always means the log was not produced by
 * this engine.
 *
 * The log format: { difficultyIdx, hands: [{ betIdx, actions: number[] }] }
 *
 * @param initial  State from `createInitialState(seed, difficulty)`.
 * @param log      Decoded action log from the claim.
 * @returns The final state, and `failedAt` (hand index << 16 | action index, or -1 when every action applied).
 */
export function replayBlackjackActions(
  initial: BlackjackState,
  log: { difficultyIdx: number; hands: { betIdx: number; actions: number[] }[] },
): { state: BlackjackState; failedAt: number } {
  let state = initial;

  // Validate difficulty matches
  const initialDifficultyIdx = getDifficultyIndex(initial.difficulty);
  if (log.difficultyIdx !== initialDifficultyIdx) {
    return { state, failedAt: -2 }; // difficulty mismatch
  }

  for (let handIdx = 0; handIdx < log.hands.length; handIdx++) {
    const handLog = log.hands[handIdx];

    // Start hand with the logged bet
    const bet = [5, 10, 25, 50, 100][handLog.betIdx];
    if (bet === undefined) {
      return { state, failedAt: (handIdx << 16) | 0 };
    }

    state = startHand(state, bet);
    if (!state.currentHand) {
      return { state, failedAt: (handIdx << 16) | 0 };
    }

    // Apply each action in this hand
    for (let actionIdx = 0; actionIdx < handLog.actions.length; actionIdx++) {
      const action = handLog.actions[actionIdx];
      const before = state;
      state = applyAction(state, action);
      if (state === before) {
        return { state, failedAt: (handIdx << 16) | actionIdx };
      }
      // Do NOT break on sessionOver here - we must continue processing
      // actions in the current hand to catch spliced post-game actions.
      // The sessionOver check is only for breaking out of the HAND loop.
    }

    // Move to next hand if session not over
    if (!state.sessionOver && handIdx < log.hands.length - 1) {
      state = nextHand(state);
    }
  }

  return { state, failedAt: -1 };
}

/** Get the difficulty index (0-3) for a difficulty object. */
export function getDifficultyIndex(difficulty: BlackjackDifficulty): number {
  return BLACKJACK_DIFFICULTIES.findIndex((d) => d.name === difficulty.name);
}