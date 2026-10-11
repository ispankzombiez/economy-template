/**
 * Server-side Blackjack replay: re-applying a claimed session's bets and
 * actions to its seeded deal.
 *
 * ## The guarantee this exists to build
 *
 * The Solitaire/Go Fish twins (see `solitaireReplay.js` and
 * `gofishReplay.js` for the full argument), in the form Blackjack can
 * answer it: not "could a session like this have happened?" but "did this
 * session happen?" The worker rebuilds the session from `(seed, difficulty,
 * bets+actions)` — the seed fixes every shuffle across all hands, the
 * difficulty fixes targetChips/maxHands (re-derived from the UTC date, not
 * believed from the claim), and the action log fixes every player choice —
 * then reads the session that falls out. Only a session that ends with
 * playerChips >= targetChips, within maxHands, at the chip count the claim
 * asserts, is a win worth paying for.
 *
 * ## Why one request, no parking, no chunks
 *
 * The same structural reason as Solitaire/Go Fish: a turn-based session's
 * proof is its *bet/action list*, not a tick trace. A complete session is a
 * few dozen bytes and replays in microseconds (each action is O(52) deck ops,
 * ~30 hands max, ~10 actions per hand = ~150 actions = ~15k operations).
 * The brawler's `openChunkReplay`/`appendChunkInputs` machinery exists
 * because ten thousand physics ticks cannot fit in the 10 ms budget; none
 * of it applies here, and the chunk intents deliberately do not accept this
 * cabinet (see `intentVerifyChunk`).
 *
 * ## Difficulty check: the worker's, not the claim's
 *
 * Blackjack re-derives today's difficulty from the UTC date (via
 * `getBlackjackDifficulty`), because its difficulty decides the chip target
 * and hand limit — "always claim easy" would be free money. The claim names
 * a difficulty index; the worker re-derives and only accepts today's or
 * yesterday's (a run may cross UTC midnight). Any other difficulty is refused.
 *
 * ## What is checked, in order
 *
 *  1. **The log decoded** (throwing `BlackjackReplayInputError`) — a log that
 *     cannot be decoded was not produced by the client's encoder, and is
 *     protocol garbage rather than a game that failed to match. Recorded as
 *     `matched: null`, kept apart from genuine mismatches so verdict noise
 *     cannot drown the signal.
 *  2. **Difficulty validated** — the claim's difficulty must be today's or
 *     yesterday's. Refused here, before replay.
 *  3. **Every action applied** — the engine returns its input unchanged for
 *     an illegal action (wrong turn, hand over, session over, invalid bet,
 *     insufficient chips for double), and the client only logs actions the
 *     engine applied. A dead action at index *i* means the log was assembled
 *     for a different deal, spliced, or forged whole.
 *  4. **The session ended** — a log that stops mid-session is not a win.
 *  5. **The session was won** — a session that replays perfectly but ends in
 *     a loss (chips < targetChips) is still no coin: the cabinet pays on a
 *     cleared session, and a verifier that paid partial sessions would be
 *     verifying a different game than it deals.
 *  6. **The claim's score agrees with its own log** — the final chip count
 *     the claim asserts must be the chip count the replay produced.
 *
 * Every reason goes into `replay_verdicts`, so the first check that fires is
 * the one an operator will read months later.
 */

import {
  createInitialState,
  getDifficultyIndex,
  replayBlackjackActions,
  resolveHand,
} from "../../src/features/arcade/games/blackjack/engine.ts";
import {
  BLACKJACK_DIFFICULTIES,
  getBlackjackDifficulty,
} from "../../src/features/arcade/games/blackjack/session.ts";
import {
  BLACKJACK_BET_AMOUNTS,
  decodeBlackjackActionLog,
  decodeBlackjackLog,
  MAX_BLACKJACK_ACTIONS,
  MAX_BLACKJACK_HANDS,
} from "@nightshade/shared/blackjackLog";

/**
 * A malformed submission — not evidence of anything.
 *
 * A decode failure means the client and worker disagree about the protocol,
 * or someone is probing the endpoint. Either way it must not count as a
 * mismatch, or protocol noise would drown the signal the verdict rows exist
 * to measure. The caller keeps these apart from genuine replay mismatches.
 */
export class BlackjackReplayInputError extends Error {}

/**
 * Validate a claim's replay payload: shape, seed, difficulty, action log.
 *
 * Pure — no D1, no clock. Throws `BlackjackReplayInputError` on anything
 * that could not have come from the client's encoder; returns the decoded
 * components for `runBlackjackReplay`.
 *
 * @param {unknown} replay The claim's `replay` field.
 * @returns {{
 *   seed: number,
 *   difficultyIdx: number,
 *   hands: { betIdx: number; actions: number[] }[],
 *   totalActions: number,
 * }}
 */
export function validateBlackjackReplay(replay) {
  if (!replay || typeof replay !== "object") {
    throw new BlackjackReplayInputError("the replay is missing");
  }

  const seed = replay.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new BlackjackReplayInputError(
      "the replay's seed is not a 32-bit integer",
    );
  }

  const difficultyIdx = replay.difficulty;
  if (!Number.isInteger(difficultyIdx) || difficultyIdx < 0 || difficultyIdx > 3) {
    throw new BlackjackReplayInputError("the replay's difficulty index is invalid");
  }

  const actionsBase64 = replay.actions;
  if (typeof actionsBase64 !== "string" || actionsBase64.length === 0) {
    throw new BlackjackReplayInputError("the replay carries no action log");
  }

  let decoded;
  try {
    decoded = decodeBlackjackActionLog(decodeBlackjackLog(actionsBase64));
  } catch (error) {
    throw new BlackjackReplayInputError(
      error instanceof Error ? error.message : "the action log could not be decoded",
    );
  }

  if (decoded.difficultyIdx !== difficultyIdx) {
    throw new BlackjackReplayInputError(
      "the replay's difficulty index disagrees with the log's",
    );
  }

  // Now validate the difficulty against the date — today's or yesterday's only
  const now = Date.now();
  const today = getBlackjackDifficulty(now);
  const yesterday = getBlackjackDifficulty(now - 86_400_000);
  const todayIdx = BLACKJACK_DIFFICULTIES.findIndex((d) => d.name === today.name);
  const yesterdayIdx = BLACKJACK_DIFFICULTIES.findIndex((d) => d.name === yesterday.name);

  if (difficultyIdx !== todayIdx && difficultyIdx !== yesterdayIdx) {
    throw new BlackjackReplayInputError(
      `the replay names difficulty ${BLACKJACK_DIFFICULTIES[difficultyIdx]?.name ?? difficultyIdx}, but only ${today.name} (today) or ${yesterday.name} (yesterday) are accepted`,
    );
  }

  const { hands } = decoded;
  if (hands.length === 0) {
    throw new BlackjackReplayInputError("the session has no hands");
  }
  if (hands.length > MAX_BLACKJACK_HANDS) {
    throw new BlackjackReplayInputError(`the session has ${hands.length} hands, over the ceiling of ${MAX_BLACKJACK_HANDS}`);
  }

  const totalActions = hands.reduce((sum, h) => sum + h.actions.length, 0);
  if (totalActions === 0) {
    throw new BlackjackReplayInputError("the action log is empty");
  }
  if (totalActions > MAX_BLACKJACK_ACTIONS) {
    throw new BlackjackReplayInputError(`total actions ${totalActions} exceeds ceiling ${MAX_BLACKJACK_ACTIONS}`);
  }

  // Validate each hand's betIdx and action sequence structure
  for (let h = 0; h < hands.length; h++) {
    const hand = hands[h];
    if (hand.betIdx < 0 || hand.betIdx > 4) {
      throw new BlackjackReplayInputError(`hand ${h}: invalid bet index ${hand.betIdx}`);
    }
    // Allow empty action sequences (e.g., immediate blackjack on deal)
    if (!hand.actions) {
      throw new BlackjackReplayInputError(`hand ${h}: missing action sequence`);
    }
    // Last action must be STAND or DOUBLE (or implied by bust)
    const lastAction = hand.actions[hand.actions.length - 1];
    if (lastAction !== 1 && lastAction !== 2) {
      // Could be a HIT that busted — the replay engine handles that.
      // We don't reject here; the replay will catch it if the hand didn't actually end.
    }
    for (let a = 0; a < hand.actions.length; a++) {
      const action = hand.actions[a];
      if (action < 0 || action > 2) {
        throw new BlackjackReplayInputError(`hand ${h}, action ${a}: invalid action ${action}`);
      }
    }
  }

  return { seed, difficultyIdx, hands, totalActions };
}

/**
 * Re-apply a validated replay to its deal and read the session that falls out.
 *
 * Pure: no D1, no KV, no network — the caller records whatever it learns.
 * May throw only on a genuinely impossible state (the engine's own
 * invariants); every ordinary forgery is reported through `failedAt` or the
 * final chip count, because a forged log that *crashed* the verifier would
 * look like an outage rather than a refusal.
 *
 * @param {{ seed: number, difficultyIdx: number, hands: { betIdx: number; actions: number[] }[], totalActions: number }} validated
 * @returns {{
 *   replayScore: number,
 *   failedAt: number,
 *   sessionOver: boolean,
 *   sessionWon: boolean,
 *   totalActions: number,
 * }}
 */
export function runBlackjackReplay({ seed, difficultyIdx, hands, totalActions }) {
  const difficulty = BLACKJACK_DIFFICULTIES[difficultyIdx];
  if (!difficulty) {
    throw new Error(`Internal: invalid difficulty index ${difficultyIdx}`);
  }

  const initial = createInitialState(seed, difficulty);
  const replayed = replayBlackjackActions(initial, { difficultyIdx, hands });

  const finalChips = replayed.state.playerChips;
  const sessionOver = replayed.state.sessionOver;
  const sessionWon = replayed.state.sessionWon;

  return {
    replayScore: finalChips,
    failedAt: replayed.failedAt,
    sessionOver,
    sessionWon,
    totalActions,
  };
}

/**
 * Turn a finished replay into the claim's verdict.
 *
 * The order of the checks is diagnostic, not defensive — any failure refuses
 * the coin, so they are ordered from the most *useful* reason to the least:
 * a tampered action, then an unfinished session, then a session that is not
 * a win, then a claim whose score disagrees with its own log. Each reason
 * goes into `replay_verdicts`, so the first check that fires is the one an
 * operator will read months later.
 *
 * `matched` is true only for a log that replayed action-for-action to a
 * finished session win *and* a claim asserting that same chip count. A
 * half-finished session replaying perfectly is still no coin: Blackjack pays
 * on a cleared session, and a verifier that paid partial sessions would be
 * verifying a different game than the cabinet deals.
 *
 * @param {ReturnType<typeof runBlackjackReplay>} replayed
 * @param {number|null} claimScore The score the claim asserts (final chip count).
 * @returns {{ matched: boolean, replayScore: number, reason: string|null }}
 */
export function blackjackReplayOutcome(replayed, claimScore) {
  const { replayScore, failedAt, sessionOver, sessionWon, totalActions } = replayed;

  if (failedAt >= 0) {
    // The client logs an action only when the engine changed the state, so in
    // an honest log every action applies. An action that changed nothing means
    // the log was assembled for a different deal, spliced, or forged whole.
    const handIdx = failedAt >> 16;
    const actionIdx = failedAt & 0xffff;
    return {
      matched: false,
      replayScore,
      reason: `action ${actionIdx} of hand ${handIdx} (of ${totalActions} total) changed nothing when replayed`,
    };
  }

  if (failedAt === -2) {
    return {
      matched: false,
      replayScore,
      reason: "the replay's difficulty disagrees with the seed's session",
    };
  }

  if (!sessionOver) {
    return {
      matched: false,
      replayScore,
      reason: "the replayed session had not finished when the log ran out",
    };
  }

  if (!sessionWon) {
    return {
      matched: false,
      replayScore,
      reason: `the replayed session ended with ${replayScore} chips, below the target`,
    };
  }

  if (claimScore !== replayScore) {
    return {
      matched: false,
      replayScore,
      reason: `the claim asserts ${claimScore} chips, the replay produced ${replayScore}`,
    };
  }

  return { matched: true, replayScore, reason: null };
}