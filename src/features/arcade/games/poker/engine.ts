/**
 * Poker — the pure rules engine, shared verbatim by the cabinet and the
 * Cloudflare Worker's replay verifier.
 *
 * The worker mints a Raven Coin only if its own replay of the claimed session
 * ends in a session win (targetChips reached within maxHands) at the chip
 * count the claim asserts. That guarantee has exactly one shape: the same
 * rules, on both sides, from the same source. A second implementation of these
 * rules — even an honest one, written here for the server — would be the single
 * most dangerous thing this package could do: two implementations of one
 * ruleset disagree, and a cheater plays whichever one is more lenient. So the
 * worker imports *this* file, the one the component deals from.
 *
 * ## The seeded session, and the RNG that outlives it
 *
 * A Poker session is a sequence of hands (up to `POKER_MAX_HANDS`). Each hand
 * deals from a fresh `PokerDeck` built over the *session's* generator stream,
 * so the seed fixes every shuffle: hand 1 consumes 51 draws for its Fisher-
 * Yates swap, hand 2 the next 51, and so on. `state.rng` is the plain `{ a }`
 * object from `rng.js` mutated in place — the state spreads share that one
 * reference, the same bargain the deck itself makes (`deal()` mutates the
 * deck's private array while the state around it is copied freely). There is
 * no branching anywhere below: one linear session, one stream, both sides.
 *
 * A client cannot precompute a winning action sequence any more than the
 * brawler can precompute a winning input log: both would need to know a seed
 * the run carries from its start.
 *
 * ## The action log, and what it does not include
 *
 * The log records only the player's choices: the bet for each hand, and the
 * player's street choices within it (FOLD/CHECK/BET). The house's play is *not*
 * logged — `HouseAI.decideBetAction` reads only the house's cards, the board
 * and what it must match — so the replay re-runs it deterministically from the
 * same deal. The log stays tiny (3 bytes per hand, 15 bytes for a full
 * session), which is why the whole thing replays inside the claim's own
 * request (see `pokerReplay.js` for why there are no chunks).
 *
 * ## The steps, and why they are separate functions
 *
 * The cabinet shows a staged hand: the player acts, the house answers half a
 * second later, the street advances, the showdown resolves. Each stage is its
 * own pure function here so the component can keep those beats (each call
 * inside its own `setTimeout`) while the replay driver simply calls the same
 * functions back to back with no clock. One sequence, two tempos:
 *
 *   `startHand` → `placeBet` → ( `applyPlayerChoice` → `resolveHouse` →
 *   `advanceStreet` → `resolveShowdown` when the river lands )
 *
 * ## Legality is reported, never inferred from references
 *
 * A CHECK is legal and changes nothing — the cabinet's reducer has always
 * returned `state` for it — so "did this action apply?" cannot be read off
 * reference equality or the replay would call every honest check a dead
 * action. `applyPlayerChoice` therefore answers `{ state, applied, handEnded }`
 * explicitly, and a bet the chips cannot cover is refused outright rather than
 * driving the stack negative the way the old reducer would have (the cabinet
 * disables the button under exactly that condition, so an honest log never
 * contains one).
 *
 * ## Two shipped behaviours this file preserves on purpose
 *
 *  1. **The showdown scores only the first five of seven cards.** Each side is
 *     evaluated on `[own two hole cards, board]` `.slice(0, 5)` — the hole
 *     cards plus the *flop* — so the turn and river are dealt, shown, and then
 *     not consulted (`getBestHand`, the best-of-seven helper, exists in
 *     `evaluateHand.ts` but the cabinet never calls it). Verification
 *     certifies the game as it plays, not as it was meant to; a worker that
 *     "fixed" the evaluation would refuse every honest win. See the header of
 *     `resolveShowdown`.
 *  2. **A tie pays the player the whole pot** (`winnings = winner === "house"
 *     ? 0 : winAmount`), so a split pot lands as a win for the player. That is
 *     the reducer's own arithmetic and it is reproduced exactly.
 *
 * The house also never folds in practice — its weakest possible preflop hand
 * scores 2/14 ≈ 0.143 against a 0.1 fold threshold, and postflop the cabinet
 * resets `currentBet` to 0 by the time the house answers, which `decideBetAction`
 * reads as "nothing to call". Both branches are still executed faithfully, so a
 * future balance change to either number keeps client and worker in lockstep.
 */

import type { EvaluatedHand, PokerGameState } from "./types";
import { PokerDeck } from "./deck";
import { HouseAI } from "./houseAI";
import { evaluateHand, compareHands } from "./evaluateHand";
import {
  advanceRng,
  makeRngState,
  type RngState,
} from "@nightshade/shared/anticheat/rng";
import {
  POKER_DIFFICULTIES,
  POKER_MAX_HANDS,
  POKER_STARTING_CHIPS,
  type PokerDifficulty,
} from "./session";
import {
  POKER_ACTION,
  POKER_BET_AMOUNTS,
  type PokerHandLog,
} from "@nightshade/shared/anticheat/pokerLog";

/** One house opponent for the whole process — `HouseAI` holds no state. */
const HOUSE = new HouseAI();

/**
 * The full state the cabinet and the worker share.
 *
 * `PokerGameState` is the shape the cabinet's screens have always read; the
 * three fields below are what makes a *replayable* session out of it, and the
 * only fields the old `useReducer` never held (the deck used to live in its
 * own `useState`, the difficulty in a `useMemo`, the RNG nowhere at all).
 */
export interface PokerState extends PokerGameState {
  /** The run's RNG stream, advanced in place across all hands. */
  rng: RngState;
  /** The current hand's shuffled deck, or null before the session starts. */
  deck: PokerDeck | null;
  /** The table this session was started on — the worker re-derives it. */
  difficulty: PokerDifficulty;
}

/** The three choices the player has on a betting street. */
export type PlayerChoice = "fold" | "check" | "bet";

/** The action bytes as the log carries them — must equal `POKER_ACTION`. */
export const PLAYER_CHOICE_CODES: Record<PlayerChoice, number> = {
  fold: POKER_ACTION.FOLD,
  check: POKER_ACTION.CHECK,
  bet: POKER_ACTION.BET,
};

/** Inverse of `PLAYER_CHOICE_CODES`; the codec refuses any other byte. */
const CHOICES_BY_CODE: PlayerChoice[] = [
  "fold",
  "check",
  "bet",
];

/**
 * Why a replay stopped, when it stopped.
 *
 * A negative code means the log itself was fine up to the end (or could not
 * have come from this engine at all); a non-negative code is
 * `(handIndex << 8) | step`, so the verdict can name the exact hand and stage
 * an operator should look at. `step` is the street-relative position:
 *
 *   0 — the hand's bet was refused (wrong status, no deck, chips cannot cover)
 *   1 — the preflop choice changed nothing
 *   2 — the postflop choice changed nothing
 *   3 — a choice arrived after the hand had already ended (fold spliced)
 *   4 — the hand had not finished when its choices ran out
 *   5 — a whole hand began after the session was already over (spliced hand)
 */
export const POKER_REPLAY_CLEAN = -1;
export const POKER_REPLAY_DIFFICULTY_MISMATCH = -2;

/** The cabinet's untouched opening state, plus the replay fields. */
const INITIAL_GAME_STATE: PokerGameState = {
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

/**
 * Open a session from a seed and a table.
 *
 * The stack is the cabinet's own `POKER_STARTING_CHIPS`, never a value the
 * caller chose: the worker rebuilds a claim's session with this same function
 * and no other parameter, so a starting stack that came from anywhere else
 * would be a stack the replay could not reproduce. (The cabinet's `initialChips`
 * prop is therefore display-only, exactly as Blackjack's is.)
 */
export function createPokerState(
  seed: number,
  difficulty: PokerDifficulty,
): PokerState {
  return {
    ...INITIAL_GAME_STATE,
    playerChips: POKER_STARTING_CHIPS,
    rng: makeRngState(seed),
    deck: null,
    difficulty,
  };
}

/**
 * Open the next hand: a freshly shuffled deck from the session's stream, and
 * the reducer's old `START_GAME` transition.
 *
 * Chips carry over untouched — both call sites (session start and the between-
 * hands NEXT HAND) have always passed the current stack back in, so preserving
 * it here is the same arithmetic with one less opportunity to disagree.
 */
export function startHand(state: PokerState): PokerState {
  const deck = new PokerDeck(() => advanceRng(state.rng));
  return {
    ...state,
    deck,
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
    playerEvalHand: null,
    houseEvalHand: null,
    lastWinner: null,
    lastWinAmount: 0,
  };
}

/**
 * Deal in: PLACE_BET, the four hole cards, and the house's matching call.
 *
 * The cabinet splits this across a 500 ms "house calls" beat, but the beat is
 * cosmetic — the match is not a decision — so the engine folds all three into
 * one step. Returns `state` unchanged when the bet cannot stand, which is what
 * makes an unaffordable bet a *dead* action in the replay.
 */
export function placeBet(state: PokerState, amount: number): PokerState {
  const deck = state.deck;
  if (state.status !== "betting" || deck === null) return state;
  if (!Number.isInteger(amount) || amount <= 0) return state;
  if (state.playerChips < amount) return state;

  const afterBet: PokerState = {
    ...state,
    playerChips: state.playerChips - amount,
    potAmount: state.potAmount + amount,
    playerBetAmount: amount,
    totalPlayerBetAcrossGame: state.totalPlayerBetAcrossGame + amount,
    initialBetAmount: amount,
    currentBet: amount,
  };

  const playerHand = [deck.deal(), deck.deal()];
  const houseHand = [deck.deal(), deck.deal()];

  return {
    ...afterBet,
    playerHand,
    houseHand,
    status: "preflop_betting",
    potAmount: afterBet.potAmount + amount,
    houseBetAmount: amount,
    totalHouseBetAcrossGame: afterBet.totalHouseBetAcrossGame + amount,
  };
}

export interface PlayerAction {
  state: PokerState;
  /** Did the engine accept the choice? A legal CHECK is true. */
  applied: boolean;
  /** Did the hand end here (a fold)? */
  handEnded: boolean;
}

/**
 * Apply the player's choice on the street it was made.
 *
 * A fold ends the hand at once and forfeits the pot to the house (the
 * cabinet's `PLAYER_ACTION` + `GAME_OVER` pair, collapsed). A bet escalates
 * by the player's *cumulative* total — the table's match-your-own-bet rule —
 * and is refused when the stack cannot cover it. A check is legal, returns the
 * state untouched, and still reports `applied: true`.
 */
export function applyPlayerChoice(
  state: PokerState,
  choice: PlayerChoice,
): PlayerAction {
  const onBettingStreet =
    state.status === "preflop_betting" || state.status === "postflop_betting";
  if (!onBettingStreet) {
    return { state, applied: false, handEnded: state.status === "gameover" };
  }

  if (choice === "fold") {
    return {
      state: gameOver(state, "house", state.potAmount),
      applied: true,
      handEnded: true,
    };
  }

  if (choice === "bet") {
    const betAmount = state.totalPlayerBetAcrossGame;
    if (state.playerChips < betAmount) {
      return { state, applied: false, handEnded: false };
    }
    return {
      state: {
        ...state,
        playerChips: state.playerChips - betAmount,
        potAmount: state.potAmount + betAmount,
        playerBetAmount: betAmount,
        totalPlayerBetAcrossGame: state.totalPlayerBetAcrossGame + betAmount,
      },
      applied: true,
      handEnded: false,
    };
  }

  return { state, applied: true, handEnded: false };
}

export interface HouseAction {
  state: PokerState;
  handEnded: boolean;
}

/**
 * Let the house answer the choice that was just made.
 *
 * Runs the cabinet's exact sequence: `HouseAI.decideBetAction` over the house's
 * cards, the board and what it must match; a fold forfeits the pot to the
 * player, otherwise the house calls what the player bet (or checks behind a
 * check). `choice` is passed rather than re-derived because the amounts are the
 * *player's* — the pre-action totals the reducer wrote into `playerBetAmount`.
 */
export function resolveHouse(
  state: PokerState,
  choice: PlayerChoice,
): HouseAction {
  const streetIndex =
    state.status === "preflop_betting"
      ? 0
      : state.status === "postflop_betting"
        ? 1
        : 2;

  const houseDecision = HOUSE.decideBetAction(
    state.houseHand,
    state.communityCards,
    state.potAmount,
    state.currentBet,
    // `decideBetAction` never reads houseChips or streetIndex; the cabinet
    // passed its own starting stack for the former, so this does too.
    POKER_STARTING_CHIPS,
    streetIndex,
  );

  if (houseDecision === "fold") {
    return { state: gameOver(state, "player", state.potAmount), handEnded: true };
  }

  const amount = choice === "bet" ? state.playerBetAmount : 0;
  if (amount > 0) {
    return {
      state: {
        ...state,
        potAmount: state.potAmount + amount,
        houseBetAmount: amount,
        totalHouseBetAcrossGame: state.totalHouseBetAcrossGame + amount,
      },
      handEnded: false,
    };
  }

  return { state, handEnded: false };
}

/**
 * Advance the street: three cards for the flop, two for the turn+river.
 *
 * The street's own bets reset to zero, as the reducer's `DEAL_FLOP` and
 * `DEAL_RIVER` always did — which is also why the house postflop always finds
 * `currentBet === 0` and calls behind every check.
 */
export function advanceStreet(state: PokerState): PokerState {
  const deck = state.deck;
  if (deck === null) return state;

  if (state.status === "preflop_betting") {
    return {
      ...state,
      communityCards: [deck.deal(), deck.deal(), deck.deal()],
      status: "postflop_betting",
      currentBet: 0,
      playerBetAmount: 0,
      houseBetAmount: 0,
    };
  }

  if (state.status === "postflop_betting") {
    return {
      ...state,
      communityCards: [...state.communityCards, deck.deal(), deck.deal()],
      status: "showdown",
      currentBet: 0,
      playerBetAmount: 0,
      houseBetAmount: 0,
    };
  }

  return state;
}

/**
 * Score the showdown and end the hand.
 *
 * **The evaluation is the cabinet's, quirk included.** Each side is scored on
 * the first five of `own hole cards + board`, which is the two hole cards plus
 * the flop: the turn and river are dealt and displayed but never consulted.
 * The best-of-seven helper (`getBestHand`) sits unused in `evaluateHand.ts`,
 * which is almost certainly how the cabinet came to ship this — but a worker
 * that "corrected" it here would compute a different winner than the screen
 * showed and refuse every honest win. The game is verified as played; the fix,
 * if wanted, belongs in one commit that changes both ends at once.
 *
 * The winner takes the pot as it stands (the house has already matched by
 * this point); a tie pays the player the same full pot, because that is what
 * the cabinet's `winnings` arithmetic has always done.
 */
export function resolveShowdown(state: PokerState): PokerState {
  if (state.status !== "showdown") return state;

  const allPlayerCards = state.playerHand.concat(state.communityCards);
  const allHouseCards = state.houseHand.concat(state.communityCards);
  const playerCards = allPlayerCards.slice(0, 5);
  const houseCards = allHouseCards.slice(0, 5);

  const playerEval = evaluateHand(playerCards);
  const houseEval = evaluateHand(houseCards);
  const comparison = compareHands(playerCards, houseCards);
  const winner =
    comparison > 0 ? "player" : comparison < 0 ? "house" : "tie";

  return gameOver(state, winner, state.potAmount, playerEval, houseEval);
}

/** The reducer's `GAME_OVER` transition, byte for byte. */
function gameOver(
  state: PokerState,
  winner: "player" | "house" | "tie",
  winAmount: number,
  playerEvalHand?: EvaluatedHand,
  houseEvalHand?: EvaluatedHand,
): PokerState {
  const winnings = winner === "house" ? 0 : winAmount;
  return {
    ...state,
    status: "gameover",
    playerChips: state.playerChips + winnings,
    playerEvalHand: playerEvalHand ?? null,
    houseEvalHand: houseEvalHand ?? null,
    lastWinner: winner,
    lastWinAmount: winAmount,
    totalWinnings:
      state.totalWinnings + (winner === "player" ? winAmount : 0),
    totalLosses:
      state.totalLosses + (winner === "house" ? winAmount : 0),
  };
}

/**
 * Has the session reached its target?
 *
 * Checked against the state's own table, which the worker populated from the
 * difficulty *it* derived from the date — the claim's target is never believed.
 */
export function sessionWon(state: PokerState): boolean {
  return state.playerChips >= state.difficulty.targetChips;
}

/**
 * Is the session decided — won, bust, or out of hands?
 *
 * The replay calls this at every hand boundary to catch a hand spliced in
 * after the cabinet had already stopped offering one, and the outcome uses it
 * to refuse a log that stops mid-session. It reads no `status`, which is
 * deliberate: every point it is consulted at (a hand boundary, the end of a
 * replay) already sits on `gameover` or `idle`, exactly where the cabinet's
 * own `sessionComplete` is decided.
 */
export function sessionOver(state: PokerState): boolean {
  return (
    sessionWon(state) ||
    state.playerChips <= 0 ||
    state.gameNumber >= POKER_MAX_HANDS
  );
}

/** The log shape the claim carries, after decoding. */
export interface PokerSessionLog {
  difficultyIdx: number;
  hands: PokerHandLog[];
}

/**
 * Re-apply a claimed session's bets and choices to its seeded deal — the
 * worker's half.
 *
 * Same contract as Go Fish's and Blackjack's twins: an action that changes
 * nothing is a dead action, and the step it died at is *returned* rather than
 * thrown, so the verdict can say where the log stopped being a game. An honest
 * log has no dead actions (the cabinet logs a choice only when the engine
 * accepted it), so `failedAt !== -1` always means the log was not produced by
 * this engine — assembled for a different deal, spliced, or forged whole.
 *
 * @param initial State from `createPokerState(seed, difficulty)`.
 * @param log     Decoded action log from the claim.
 * @returns The final state, and `failedAt` (see the step table above, or -1
 *          when every choice applied and every hand finished).
 */
export function replayPokerSession(
  initial: PokerState,
  log: PokerSessionLog,
): { state: PokerState; failedAt: number } {
  let state = initial;

  const initialDifficultyIdx = POKER_DIFFICULTIES.findIndex(
    (d) => d.name === state.difficulty.name,
  );
  if (log.difficultyIdx !== initialDifficultyIdx) {
    return { state, failedAt: POKER_REPLAY_DIFFICULTY_MISMATCH };
  }

  for (let handIdx = 0; handIdx < log.hands.length; handIdx++) {
    const hand = log.hands[handIdx];

    // The cabinet stops offering the next hand the moment the session is
    // decided, so a hand logged past that point was not played on this run.
    if (sessionOver(state)) {
      return { state, failedAt: (handIdx << 8) | 5 };
    }

    state = startHand(state);

    const bet = POKER_BET_AMOUNTS[hand.betIdx];
    if (bet === undefined) {
      return { state, failedAt: (handIdx << 8) | 0 };
    }
    const afterBet = placeBet(state, bet);
    if (afterBet === state) {
      return { state, failedAt: (handIdx << 8) | 0 };
    }
    state = afterBet;

    for (let actionIdx = 0; actionIdx < hand.actions.length; actionIdx++) {
      const code = hand.actions[actionIdx];

      // Which street the choice lands on is read from the state, so a choice
      // arriving after the hand ended is caught here instead of being applied
      // to — or ignored by — whatever street happens to follow.
      const step =
        state.status === "preflop_betting"
          ? 1
          : state.status === "postflop_betting"
            ? 2
            : 3;
      if (step === 3) {
        return { state, failedAt: (handIdx << 8) | 3 };
      }
      if (
        !Number.isInteger(code) ||
        code < POKER_ACTION.FOLD ||
        code > POKER_ACTION.BET
      ) {
        return { state, failedAt: (handIdx << 8) | step };
      }

      const choice = CHOICES_BY_CODE[code];
      const playerMove = applyPlayerChoice(state, choice);
      if (!playerMove.applied) {
        return { state, failedAt: (handIdx << 8) | step };
      }
      state = playerMove.state;

      // Folded (or house folded below): the hand is over, and any choice the
      // log still carries for it trips the `step === 3` check on the next turn.
      if (state.status === "gameover") continue;

      const houseMove = resolveHouse(state, choice);
      state = houseMove.state;
      if (houseMove.handEnded) continue;

      state = advanceStreet(state);
      if (state.status === "showdown") {
        state = resolveShowdown(state);
      }
    }

    // A hand whose choices run out before it ends is a log that stops
    // mid-hand — every finished hand lands on `gameover`.
    if (state.status !== "gameover") {
      return { state, failedAt: (handIdx << 8) | 4 };
    }
  }

  return { state, failedAt: POKER_REPLAY_CLEAN };
}
