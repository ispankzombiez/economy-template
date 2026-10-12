/**
 * Uno — the pure rules engine, shared verbatim by the cabinet and the
 * Cloudflare Worker's replay verifier.
 *
 * ## Why this file exists
 *
 * The worker mints a Raven Coin only if its own replay of the claimed game
 * ends with the *player* emptying their hand. That guarantee has exactly one
 * shape: the same rules, on both sides, from the same source. A second
 * implementation of these rules — even an honest one, written here for the
 * server — would be the single most dangerous thing this package could do:
 * two implementations of one ruleset disagree, and a cheater plays whichever
 * one is more lenient. So the worker imports *this* file, the one the
 * component deals from.
 *
 * ## The seeded deal, and the two kinds of randomness that follow it
 *
 * Uno's randomness is not all in the shuffle:
 *
 *  1. **The shuffle** — 107 Fisher-Yates swaps, the first draws from the
 *     run's generator.
 *  2. **The bots' colour picks** — when a bot drops a Wild, it names a
 *     colour, and the original chose it with `Math.random()`. That is now one
 *     more draw from the *same* stream, so the worker reproduces it.
 *  3. **Refills** — when the deck empties, the discard (minus its top card)
 *     is shuffled back in, consuming as many draws as its size.
 *
 * All three run through `advanceRng(state.rng)`, whose state rides in the
 * game state. That is the same bargain Go Fish makes (see gofish/engine.ts):
 * one 32-bit integer stream, identical in integer arithmetic on a phone and
 * on a worker. The client cannot precompute a winning line any more than the
 * brawler can precompute a winning input log — both would need a seed the
 * run carries from its start.
 *
 * `state.rng` is a plain `{ a }` object (see `rng.js`) mutated in place; the
 * state spreads share that one reference, exactly as the deck array is
 * mutated in place while the state around it is copied freely.
 *
 * ## The three bots are re-simulated, not logged
 *
 * A four-player game might look like it needs four action logs. It does not.
 * Bots 1–3 have no choices of their own: `botChooseCard` reads only the hand,
 * the discard top and the active colour, and the one roll per Wild comes from
 * the seeded stream above. So the log records the player's choices and the
 * worker re-simulates the bots between them — recording a bot move would only
 * be re-recording what the rules already determine, and a recorded bot move
 * the rules disagree with would be a hole, not a proof.
 *
 * ## Legality is enforced here, not just in the UI
 *
 * The component only offers buttons for playable cards, but the engine
 * checks every play anyway, because the worker replays *logs*, and a log is
 * attacker-controlled bytes: a play the rules refuse returns the state
 * unchanged, which `replayUnoActions` reports as a dead action at its exact
 * index — the tamper signal, not a weaker check. That includes the two things
 * the UI guaranteed but the log cannot be trusted to: that it is the player's
 * turn, and that a Wild names a colour (a Wild without one, or a colour on a
 * non-Wild, is refused so there is exactly one byte sequence per game).
 */

import type { UnoCard, UnoColor, UnoFace, UnoGameState, UnoWinner } from "./types";
import {
  advanceRng,
  makeRngState,
  type RngState,
} from "@nightshade/shared/anticheat/rng";

/** The game state plus the seeded stream that decides everything not logged. */
export type UnoState = UnoGameState & { rng: RngState };

export const PLAYER_NAMES = ["You", "Bot 1", "Bot 2", "Bot 3"];

export const NON_WILD_COLORS: Exclude<UnoColor, "Wild">[] = [
  "Kale",
  "Barley",
  "Wheat",
  "Radish",
];

/**
 * Bound on the bot turns run between two player actions during replay.
 *
 * Four seats, one of them the player's, and a Skip jumps two — so at most
 * three bot turns can ever separate one player action from the next. The
 * guard is far above that because it is not a rule but a fuse: a log that
 * spins here means the replay cannot make progress, which is our defect (or
 * a hostile log), and it must surface as a refusal rather than as a request
 * that never returns.
 */
export const MAX_BOT_TURNS = 16;

export const isWild = (card: UnoCard): boolean => card.color === "Wild";

export const canPlay = (
  card: UnoCard,
  topCard: UnoCard,
  currentColor: UnoColor,
): boolean => {
  if (card.color === "Wild") return true;
  if (card.color === currentColor) return true;
  if (card.face === topCard.face) return true;
  return false;
};

const isCounter = (card: UnoCard, topCard: UnoCard): boolean =>
  (topCard.face === "DrawTwo" && card.face === "DrawTwo") ||
  (topCard.face === "WildDrawFour" && card.face === "WildDrawFour");

export const nextPlayerIndex = (
  current: number,
  direction: 1 | -1,
  skip = false,
): number => {
  const step = skip ? 2 : 1;
  return ((((current + direction * step) % 4) + 4) % 4);
};

// ─── The deck ────────────────────────────────────────────────────────────────

/**
 * Build the 108-card deck in the original's exact order, with deterministic
 * ids.
 *
 * Ids used to come from a module-level counter, which is fine for React keys
 * and useless for replay: the worker rebuilds a deck too, and a comparison of
 * two games that disagree only in id numbering would be comparing nothing. So
 * an id is the card's position in this build order — stable, unique within the
 * deck, and identical on both sides. Nothing in the rules reads an id except
 * "remove this card from the hand", which only needs uniqueness.
 */
export const buildDeck = (): UnoCard[] => {
  const deck: UnoCard[] = [];
  const repeated: UnoFace[] = [
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "Skip",
    "Reverse",
    "DrawTwo",
  ];

  for (const color of NON_WILD_COLORS) {
    deck.push({ color, face: "0", id: String(deck.length) });
    for (const face of repeated) {
      deck.push({ color, face, id: String(deck.length) });
      deck.push({ color, face, id: String(deck.length) });
    }
  }

  for (let i = 0; i < 4; i++) {
    deck.push({ color: "Wild", face: "Wild", id: String(deck.length) });
    deck.push({
      color: "Wild",
      face: "WildDrawFour",
      id: String(deck.length),
    });
  }

  return deck;
};

/** Fisher-Yates over the run's stream — the shuffle the replay must reproduce. */
const shuffleInPlace = (cards: UnoCard[], rng: RngState): void => {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(advanceRng(rng) * (i + 1));
    const swap = cards[i];
    cards[i] = cards[j];
    cards[j] = swap;
  }
};

/**
 * Pop one card, refilling from the discard when the deck has run out.
 *
 * The refill keeps the discard's top card in play and shuffles the rest back
 * in — consuming one generator draw per card shuffled, so the stream stays
 * shared with everything else. Returns the state as it was when there was
 * genuinely nothing to draw (an empty deck *and* a discard of one card), which
 * the callers treat as "no card", exactly as the original did.
 */
export const drawOne = (
  state: UnoState,
): { state: UnoState; card: UnoCard | null } => {
  let deck = state.deck;
  let discard = state.discard;

  if (deck.length === 0 && discard.length > 1) {
    const topCard = discard[discard.length - 1];
    deck = [...discard.slice(0, discard.length - 1)];
    shuffleInPlace(deck, state.rng);
    discard = [topCard];
  }

  const card = deck.pop() ?? null;

  return { state: { ...state, deck, discard }, card };
};

// ─── Initial deal ────────────────────────────────────────────────────────────

/**
 * Deal a fresh four-handed game from a seed.
 *
 * The seed is the run's whole proof: it fixes the shuffle *and* every bot
 * colour pick and refill that follows, because all three draw from the one
 * stream in `state.rng`. The client picks the seed when the run opens — the
 * same client-chosen-seed posture as the other verified cabinets, which
 * becomes server-issued for all of them together in Stage C, not here.
 */
export const createInitialState = (seed: number): UnoState => {
  const rng = makeRngState(seed);
  const deck = buildDeck();
  shuffleInPlace(deck, rng);

  const deal = (): UnoCard[] => [deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!, deck.pop()!];

  const hands: [UnoCard[], UnoCard[], UnoCard[], UnoCard[]] = [
    deal(),
    deal(),
    deal(),
    deal(),
  ];

  // First discard — re-draw if it starts with a Wild. A returned Wild goes to
  // the *front* of the deck (the back of the draw order), exactly as the
  // original's `unshift` did, rather than being silently discarded.
  let firstCard = deck.pop()!;
  while (isWild(firstCard)) {
    deck.unshift(firstCard);
    firstCard = deck.pop()!;
  }

  const state: UnoState = {
    deck,
    discard: [firstCard],
    hands,
    currentPlayer: 0,
    direction: 1,
    currentColor: firstCard.color,
    winner: null,
    gameOver: false,
    log: [`Game started. Top card: ${firstCard.color} ${firstCard.face}.`],
    pendingDrawCount: 0,
    rng,
  };

  return state;
};

// ─── Bot policy ──────────────────────────────────────────────────────────────

/**
 * The colour a bot names when dropping a Wild — one draw from the run's
 * stream, where the original rolled `Math.random()`. This is the second (and
 * only other) place randomness enters a game besides shuffles and refills.
 */
export const botPickColor = (state: UnoState): Exclude<UnoColor, "Wild"> =>
  NON_WILD_COLORS[Math.floor(advanceRng(state.rng) * NON_WILD_COLORS.length)];

/**
 * Which card a bot plays — pure function of what it can see, no randomness.
 *
 * Transcribed from the original: prefer the punishing action cards in order,
 * then any playable card; with a pending penalty, only a matching counter
 * counts as playable at all.
 */
export const botChooseCard = (
  hand: UnoCard[],
  topCard: UnoCard,
  currentColor: UnoColor,
): UnoCard | null => {
  // A pending +2/+4 is handled by the caller (it must match the top card
  // exactly, or be taken as the penalty), so by the time we get here there is
  // nothing pending and any playable card will do.
  const playable = hand.filter((c) => canPlay(c, topCard, currentColor));

  if (playable.length === 0) return null;

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

// ─── The one place a card enters play ────────────────────────────────────────

/**
 * Play `cardId` from `playerIndex`'s hand — the rules, the legality check and
 * the card effects in one function.
 *
 * Returns the state unchanged for anything the rules refuse: not that
 * player's turn, game over, a card the hand does not hold, a play the active
 * colour and top card do not allow, a penalty the player must take instead of
 * playing, a Wild with no colour named, or a colour named on a non-Wild.
 * That last pair is what makes the action log canonical: the UI always makes
 * the player pick a colour, so an honest log always carries one.
 */
export const playCardById = (
  state: UnoState,
  playerIndex: number,
  cardId: string,
  chosenColor?: Exclude<UnoColor, "Wild">,
): UnoState => {
  if (state.gameOver || state.currentPlayer !== playerIndex) {
    return state;
  }

  const hand = state.hands[playerIndex];
  const card = hand.find((c) => c.id === cardId);
  if (!card) {
    return state;
  }

  const topCard = state.discard[state.discard.length - 1];

  if (state.pendingDrawCount > 0) {
    // A pending +2/+4 can only be met by a matching draw card — anything else
    // must be taken as the penalty draw.
    if (!isCounter(card, topCard)) {
      return state;
    }
  } else if (!canPlay(card, topCard, state.currentColor)) {
    return state;
  }

  // A Wild names a colour; nothing else may.
  if (isWild(card)) {
    if (chosenColor === undefined) return state;
  } else if (chosenColor !== undefined) {
    return state;
  }

  const newHand = hand.filter((c) => c.id !== cardId);
  const newHands = [...state.hands] as UnoGameState["hands"];
  newHands[playerIndex] = newHand;

  const newDiscard = [...state.discard, card];
  const newColor: UnoColor = isWild(card) ? (chosenColor as UnoColor) : card.color;
  let newDirection = state.direction;
  let newPending = state.pendingDrawCount;
  const logEntry: string[] = [];

  // Check win — a hand emptied by this card ends the game before any of the
  // card's effects apply, exactly as the original resolved it.
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

  return {
    ...state,
    hands: newHands,
    discard: newDiscard,
    currentColor: newColor,
    direction: newDirection,
    currentPlayer: nextPlayerIndex(playerIndex, newDirection, skip),
    pendingDrawCount: newPending,
    log: [...logEntry, ...state.log],
  };
};

/** Take a pending +2/+4 as cards instead of countering it. */
export const applyDrawPenalty = (
  state: UnoState,
  playerIndex: number,
): UnoState => {
  if (state.gameOver || state.currentPlayer !== playerIndex) {
    return state;
  }

  const drawCount = state.pendingDrawCount;
  if (drawCount <= 0) {
    return state;
  }

  const drawnCards: UnoCard[] = [];
  let next = state;

  for (let i = 0; i < drawCount; i++) {
    const result = drawOne(next);
    next = result.state;
    if (result.card) drawnCards.push(result.card);
  }

  const newHands = [...next.hands] as UnoGameState["hands"];
  newHands[playerIndex] = [...newHands[playerIndex], ...drawnCards];

  return {
    ...next,
    hands: newHands,
    pendingDrawCount: 0,
    currentPlayer: nextPlayerIndex(playerIndex, next.direction),
    log: [
      `${PLAYER_NAMES[playerIndex]} drew ${drawnCards.length} card(s) as penalty.`,
      ...next.log,
    ],
  };
};

// ─── One bot turn, transcribed ───────────────────────────────────────────────

/**
 * One bot's whole turn, run synchronously — counter or penalty, play, or draw
 * one and play it if it happens to fit.
 *
 * Returns the state unchanged only if it is the player's turn or the game is
 * over; every other path produces a new state, which is what makes the bot
 * loop inside `replayUnoActions` safe to run to convergence.
 */
export const runBotTurn = (state: UnoState): UnoState => {
  if (state.gameOver || state.currentPlayer === 0) {
    return state;
  }

  const playerIndex = state.currentPlayer;
  const hand = state.hands[playerIndex];
  const topCard = state.discard[state.discard.length - 1];

  // Must counter the penalty, or take it.
  if (state.pendingDrawCount > 0) {
    const counter = hand.find((c) => isCounter(c, topCard));

    if (counter) {
      return playCardById(
        state,
        playerIndex,
        counter.id,
        counter.color === "Wild" ? botPickColor(state) : undefined,
      );
    }

    return applyDrawPenalty(state, playerIndex);
  }

  const chosen = botChooseCard(hand, topCard, state.currentColor);

  if (!chosen) {
    const drawn = drawOne(state);
    let next = drawn.state;

    if (drawn.card) {
      const newHands = [...next.hands] as UnoGameState["hands"];
      newHands[playerIndex] = [...hand, drawn.card];
      next = {
        ...next,
        hands: newHands,
        log: [`${PLAYER_NAMES[playerIndex]} drew a card and played it.`, ...next.log],
      };

      // Only if the drawn card actually fits may it go down; otherwise it
      // stays in hand and the turn passes.
      if (canPlay(drawn.card, topCard, next.currentColor)) {
        return playCardById(
          next,
          playerIndex,
          drawn.card.id,
          isWild(drawn.card) ? botPickColor(next) : undefined,
        );
      }
    }

    return {
      ...next,
      currentPlayer: nextPlayerIndex(playerIndex, next.direction),
      log: [
        `${PLAYER_NAMES[playerIndex]} drew a card and passed.`,
        ...next.log,
      ],
    };
  }

  return playCardById(
    state,
    playerIndex,
    chosen.id,
    isWild(chosen) ? botPickColor(state) : undefined,
  );
};

// ─── The player's two actions ────────────────────────────────────────────────

/**
 * Draw one card — voluntarily, or as the pending penalty if there is one.
 *
 * Returns the state unchanged when it is not the player's turn, the game is
 * over, or there is genuinely nothing left to draw (empty deck, one-card
 * discard). As in the original, a drawn card that happens to be playable
 * leaves the turn with the player, who may play it or draw again.
 */
export const playerDraw = (state: UnoState): UnoState => {
  if (state.gameOver || state.currentPlayer !== 0) {
    return state;
  }

  if (state.pendingDrawCount > 0) {
    return applyDrawPenalty(state, 0);
  }

  const topCard = state.discard[state.discard.length - 1];
  const drawn = drawOne(state);

  if (!drawn.card) {
    return state;
  }

  const newHands = [...drawn.state.hands] as UnoGameState["hands"];
  newHands[0] = [...newHands[0], drawn.card];

  const playableNow = canPlay(drawn.card, topCard, drawn.state.currentColor);

  return {
    ...drawn.state,
    hands: newHands,
    currentPlayer: playableNow
      ? 0
      : nextPlayerIndex(0, drawn.state.direction),
    log: [
      playableNow
        ? `You drew ${drawn.card.color} ${drawn.card.face}. You may play it.`
        : `You drew ${drawn.card.color} ${drawn.card.face} and passed.`,
      ...drawn.state.log,
    ],
  };
};

/**
 * Play the card at `index` in the player's hand — the player's other action.
 *
 * `index` is a position in the *engine's* hand order, which is what the
 * action log stores: the sorted display order is a view, and card ids are not
 * shipped. Returns the state unchanged for anything illegal (see
 * `playCardById`), which the replay reads as a dead action.
 */
export const playerPlayCard = (
  state: UnoState,
  index: number,
  color?: Exclude<UnoColor, "Wild">,
): UnoState => {
  if (!Number.isInteger(index)) {
    return state;
  }

  const card = state.hands[0][index];
  if (!card) {
    return state;
  }

  return playCardById(state, 0, card.id, color);
};

// ─── Driving the bots ────────────────────────────────────────────────────────

/**
 * Run bot turns until the game ends or it is the player's turn again.
 *
 * The client runs these one per 700 ms for the animation; the worker runs
 * them in a loop. The state sequence is identical either way — the delay is
 * presentation, and nothing in the rules reads a clock.
 *
 * @returns `exhausted: true` if the fuse above ever tripped, which the caller
 *   treats as an internal error rather than a game result.
 */
export const advanceBots = (
  state: UnoState,
): { state: UnoState; exhausted: boolean } => {
  let next = state;
  let turns = 0;

  while (!next.gameOver && next.currentPlayer !== 0) {
    const after = runBotTurn(next);
    if (after === next) {
      return { state: next, exhausted: true };
    }
    next = after;
    if (++turns > MAX_BOT_TURNS) {
      return { state: next, exhausted: true };
    }
  }

  return { state: next, exhausted: false };
};

// ─── The worker's half ───────────────────────────────────────────────────────

/**
 * Re-apply a claimed game's player choices to its deal — the worker's half.
 *
 * Same contract as Go Fish's `replayGoFishActions`: an action that changes
 * nothing is a dead action, and the index it died at is returned rather than
 * thrown, so the verdict can say *where* the log stopped being a game. An
 * honest log has no dead actions (the component only logs actions the engine
 * applied), so `failedAt !== -1` always means the log was not produced by
 * this engine — it was assembled for a different deal, spliced, or forged
 * whole.
 *
 * `failedAt: -2` is not a game result at all: it means the bots could not be
 * driven to the player's turn, which is a defect in this engine rather than
 * evidence about the player, and the caller records it as such.
 *
 * @param initial  State from `createInitialState(seed)`.
 * @param actions  Decoded player actions, in play order.
 */
export const replayUnoActions = (
  initial: UnoState,
  actions: { kind: string; index?: number; color?: number }[],
): { state: UnoState; failedAt: number } => {
  let state = initial;

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];

    if (state.gameOver || state.currentPlayer !== 0) {
      return { state, failedAt: i };
    }

    const before = state;
    state =
      action.kind === "draw"
        ? playerDraw(state)
        : playerPlayCard(
            state,
            action.index ?? -1,
            action.color === undefined
              ? undefined
              : (NON_WILD_COLORS[action.color] as Exclude<UnoColor, "Wild">),
          );

    if (state === before) {
      return { state, failedAt: i };
    }

    // Deliberately no `break` when the game ends here: an honest log stops
    // at the game's end, so any choice *after* it is a forgery and must be
    // caught by the check at the top of the next iteration rather than
    // skipped over. The engine refuses every choice once the game is over,
    // so such a choice is dead at exactly its own index.
    if (state.gameOver) {
      continue;
    }

    const driven = advanceBots(state);
    if (driven.exhausted) {
      return { state: driven.state, failedAt: -2 };
    }
    state = driven.state;
  }

  return { state, failedAt: -1 };
};
