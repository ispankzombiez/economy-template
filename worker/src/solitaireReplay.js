/**
 * Server-side Solitaire replay: re-applying a claimed game's moves to its deal.
 *
 * ## The guarantee this exists to build
 *
 * The same question the brawler's replay asks, in the only form Solitaire can
 * answer it: not "could a game like this have happened?" but "did this game
 * happen?" The worker rebuilds the deal from `(seed, difficulty)` and
 * re-applies the player's own action log, one move at a time, then reads the
 * board that falls out. Only a board with all fifty-two cards on the
 * foundations is a win worth paying for — because it is the only outcome
 * derived from moves the player actually made rather than a score they
 * asserted.
 *
 * ## Why this is simpler than the brawler's verifier — and why that is safe
 *
 * `replay.js` parks, chunks, resumes and bounds a CPU budget, because ten
 * thousand ticks of fighting cannot fit in one 10 ms request. Solitaire has
 * none of that machinery, and the difference is structural rather than a
 * shortcut: a turn-based game's proof is its *move list*, not its tick trace.
 * A win is a couple hundred actions at two bytes each; re-applying them is a
 * few hundred rule checks on seven piles — microseconds, comfortably inside
 * one request. One request also means no parked state to bind, no chunk to
 * trust, and no continuation to hijack: the entire replay is validated and
 * replayed in the same instant the claim arrives, and `replay_state` is never
 * touched for this cabinet.
 *
 * Undo is the one thing that does not fit an applier — undoing is reverting a
 * state, not transforming it — so the history stack lives here, in
 * `replaySolitaireActions` (engine.ts), kept by exactly the rule the component
 * keeps: one entry per action that changed the state, popped by `UNDO`, with
 * the count over the allowance (`MAX_UNDOS_PER_GAME`) refused as not-this-game's
 * log however well the remaining moves replay.
 *
 * ## Why the engine is imported, not reimplemented
 *
 * `createInitialState` and `replaySolitaireActions` below are the *client's*
 * engine, bundled by wrangler from `src/features/arcade/games/solitaire/engine.ts`
 * — the same file the component plays on. Writing a second set of rules here
 * would be the single most dangerous thing this package could do: two
 * implementations of one ruleset disagree, and a cheater plays whichever one
 * is more lenient. One source, imported by both sides, is what makes "the
 * worker re-applied the player's moves" mean the same thing on both sides.
 *
 * ## Why difficulty is re-derived, never trusted
 *
 * The claim names a difficulty, but the worker decides what today's reward
 * difficulty actually is from the UTC date (`getSolitaireDifficulty`, the same
 * function the client's reward path calls) and requires the claim's name to
 * match it. Believing the claim would be free money: draw count and stock
 * passes decide how easy the deal is to grind, so "always claim easy" would
 * empty the vault without a single forged move. Yesterday's name is accepted
 * beside today's because a run legitimately straddles UTC midnight — the player
 * opens it at 23:58 and finishes at 00:02, and neither the run nor the deal
 * changes when the date does.
 *
 * ## Why the seed is the *resolved* one
 *
 * The client's `createSolvableDeal` may walk up to 100 seeds forward before
 * finding a solvable one and returns the seed it landed on; the claim carries
 * that one. Solvability itself is a client-side courtesy — the player gets a
 * winnable board — and is deliberately *not* re-checked here: the proof of a
 * win is the move list replaying to fifty-two cards, and re-running the
 * solver's search would hand any caller a way to burn the worker's 10 ms
 * budget on a hundred greedy passes before the moves are even read.
 */

import {
  createInitialState,
  getFoundationsCount,
  MAX_UNDOS_PER_GAME,
  replaySolitaireActions,
  SOLITAIRE_WIN_SCORE,
} from "../../src/features/arcade/games/solitaire/engine.ts";
import {
  getSolitaireDifficulty,
} from "../../src/features/arcade/games/solitaire/session.ts";
import {
  decodeActionLog,
  decodeSolitaireLog,
  MAX_SOLITAIRE_ACTIONS,
} from "@nightshade/shared/solitaireLog";

/**
 * A malformed submission — not evidence of anything.
 *
 * A decode failure means the client and worker disagree about the protocol, or
 * someone is probing the endpoint. Either way it must not count as a mismatch,
 * or protocol noise would drown the signal the verdict rows exist to measure.
 * The caller keeps these apart from genuine replay mismatches.
 */
export class SolitaireReplayInputError extends Error {}

const ONE_DAY_MS = 86_400_000;

/**
 * How far the client's `createSolvableDeal` may walk forward from the base seed
 * before it gives up on finding a solvable deal.
 *
 * Mirrors the loop bound in the client's `engine.ts`. The two must agree
 * exactly: this constant is the window inside which the worker accepts a
 * claim's *resolved* seed, so a client that walked further than this bound
 * would land on a seed the worker refuses.
 */
export const SOLITAIRE_SEED_WALK = 100;

/**
 * Bind a claim's *resolved* seed to the *base* seed the server issued when the
 * run was opened.
 *
 * ## Why this is a window and not an equality
 *
 * Solitaire is the one seeded cabinet whose board is not dealt from the issued
 * seed itself. `createSolvableDeal` walks `(base + i) >>> 0` forward — up to
 * `SOLITAIRE_SEED_WALK` steps — until it lands on a solvable deal, and the
 * claim names *that* seed, because the worker rebuilds the board with a single
 * `createInitialState` rather than repeating the solver's hundred-pass search.
 * So the seed the worker must bind is the resolved one, and the property it
 * enforces is that the resolved seed is one the client's own walk could have
 * reached from the issued base.
 *
 * ## What this closes
 *
 * Without it, the claim's seed is the client's to choose, and a chosen seed is
 * a chosen board: a caller could search the whole 32-bit space for a deal its
 * solver already knows a short path through, then bot the moves to a win. With
 * it, the search space is the hundred seeds forward of a base the *server*
 * drew — exactly the space an honest client searches, and no more.
 *
 * ## Why `>>> 0`
 *
 * The client's walk wraps at 2^32 (`(seed + i) >>> 0`), so this check wraps the
 * same way. `(resolved - base) >>> 0` is the unsigned distance *forward*, which
 * equals the walk step `i` for any base — including one near `0xffffffff`,
 * where the walk crosses zero and a plain subtraction would go negative.
 *
 * @param {number} resolvedSeed  The claim's `replay.seed` — the deal's seed.
 * @param {number|null} baseSeed  The seed the server issued for this run.
 * @throws {SolitaireReplayInputError} when the run has no issued seed, or the
 *   resolved seed is not reachable from it by the client's walk.
 */
export function assertIssuedSeed(resolvedSeed, baseSeed) {
  // `typeof ... !== "number"` first on purpose: `Number(null)` is `0` and
  // `Number(undefined)` is `NaN`, so a bare `Number()` coercion would turn a
  // *missing* seed (a row written before the column existed) into a legitimate
  // base of `0` and let a client-chosen deal bind to it. The type check rejects
  // the absent seed — and any string or fraction — before it can be coerced.
  if (
    typeof baseSeed !== "number" ||
    !Number.isInteger(baseSeed) ||
    baseSeed < 0 ||
    baseSeed > 0xffffffff
  ) {
    // Fails closed: a run opened before the column was populated has no seed to
    // bind to, and a run verified against a seed the client chose is not a
    // certified run. Refusing is the only answer that keeps that promise.
    throw new SolitaireReplayInputError(
      "this run has no server-issued seed, so its deal cannot be verified",
    );
  }

  // `resolvedSeed` is the claim's `replay.seed`, already shape-checked to a
  // clean 32-bit integer by `validateSolitaireReplay` before this is called.
  const distance = (resolvedSeed - baseSeed) >>> 0;
  if (distance >= SOLITAIRE_SEED_WALK) {
    throw new SolitaireReplayInputError(
      "the replay's seed was not issued for this run",
    );
  }
}

/**
 * Validate a claim's `replay` payload against what the worker itself derives.
 *
 * Everything re-derivable is re-derived: the difficulty's parameters come from
 * the worker's own copy of the date table, never from the claim. What cannot
 * be re-derived — the deal's seed and the player's moves — is checked only for
 * shape, because the replay *is* the check: a well-formed log that replays to
 * fifty-two cards is the proof, and no pre-validation can make it stronger.
 *
 * @param {unknown} replay  The claim's `replay` object.
 * @returns {{ seed: number, difficulty: object, actions: object[], total: number }}
 * @throws {SolitaireReplayInputError} on anything malformed.
 */
export function validateSolitaireReplay(replay) {
  if (!replay || typeof replay !== "object") {
    throw new SolitaireReplayInputError("the replay is missing");
  }

  const seed = replay.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new SolitaireReplayInputError(
      "the replay's seed is not a 32-bit integer",
    );
  }

  const difficultyName = replay.difficulty;
  if (typeof difficultyName !== "string" || difficultyName.length === 0) {
    throw new SolitaireReplayInputError("the replay does not name a difficulty");
  }

  // Today's reward difficulty, derived from the UTC date — the client's own
  // `getSolitaireDifficulty`, imported rather than re-derived by hand, so a
  // table change here and on the client cannot drift apart. Yesterday's is the
  // only other acceptable answer: a run may cross UTC midnight, and its deal
  // does not change when the date does.
  const now = Date.now();
  const today = getSolitaireDifficulty(now);
  const yesterday = getSolitaireDifficulty(now - ONE_DAY_MS);

  let difficulty = null;
  if (difficultyName === today.name) {
    difficulty = today;
  } else if (difficultyName === yesterday.name) {
    difficulty = yesterday;
  }
  if (difficulty === null) {
    throw new SolitaireReplayInputError(
      `"${difficultyName}" is not the reward difficulty for today`,
    );
  }

  const actionsBase64 = replay.actions;
  if (typeof actionsBase64 !== "string" || actionsBase64.length === 0) {
    throw new SolitaireReplayInputError("the replay carries no action log");
  }

  let actions;
  try {
    // Both layers throw on anything malformed — unknown opcode, out-of-range
    // pile/suit/cardIndex, odd length, over the ceiling. Refused here, before
    // any replay: a log that cannot be decoded was not produced by the client's
    // encoder, and is protocol garbage rather than a game that failed to match.
    actions = decodeActionLog(decodeSolitaireLog(actionsBase64));
  } catch (error) {
    throw new SolitaireReplayInputError(
      error instanceof Error ? error.message : "the action log could not be decoded",
    );
  }

  if (actions.length === 0) {
    throw new SolitaireReplayInputError("the action log is empty");
  }
  if (actions.length > MAX_SOLITAIRE_ACTIONS) {
    // Belt and braces: `decodeActionLog` already enforces the ceiling, but the
    // ceiling is a hard resource bound (it caps this request's work and the
    // base64's size), so it is checked against the *decoded count* here too
    // rather than trusted to one layer.
    throw new SolitaireReplayInputError("the action log is over the ceiling");
  }

  return { seed, difficulty, actions, total: actions.length };
}

/**
 * Re-apply a validated replay to its deal and read the board that falls out.
 *
 * Pure: no D1, no KV, no network — the caller records whatever it learns. May
 * throw only on a genuinely impossible state (the engine's own invariants);
 * every ordinary forgery is reported through `failedAt` or a score, because a
 * forged log that *crashed* the verifier would look like an outage rather than
 * a refusal.
 *
 * @param {{ seed: number, difficulty: object, actions: object[], total: number }} validated
 * @returns {{
 *   replayScore: number,
 *   failedAt: number,
 *   undoCount: number,
 *   undoLimitExceeded: boolean,
 *   total: number,
 * }}
 */
export function runSolitaireReplay({ seed, difficulty, actions, total }) {
  // One `createInitialState`, no solver search — the claim's seed is the one
  // the deck was dealt from, so this rebuilds the exact board the player
  // played on. See the module header: solvability is a client-side courtesy,
  // not a security property.
  const initial = createInitialState(seed, difficulty.maxPasses);
  const replayed = replaySolitaireActions(
    initial,
    actions,
    difficulty.drawCount,
  );

  return {
    replayScore: getFoundationsCount(replayed.state),
    failedAt: replayed.failedAt,
    undoCount: replayed.undoCount,
    undoLimitExceeded: replayed.undoLimitExceeded,
    total,
  };
}

/**
 * Turn a finished replay into the claim's verdict.
 *
 * The order of the checks is diagnostic, not defensive — any failure refuses
 * the coin, so they are ordered from the most *useful* reason to the least:
 * a tampered move, then an over-allowance undo count, then a board that is not
 * a win, then a claim whose score disagrees with its own log. Each reason goes
 * into `replay_verdicts`, so the first check that fires is the one an operator
 * will read months later.
 *
 * `matched` is true only for a log that replayed move-for-move to a complete
 * fifty-two-card board *and* a claim asserting that same completed deal. A
 * half-finished game replaying perfectly is still no coin: Solitaire pays on a
 * won deal, and a verifier that paid partial boards would be verifying a
 * different game than the cabinet deals.
 *
 * @param {ReturnType<typeof runSolitaireReplay>} replayed
 * @param {number|null} claimScore The score the claim asserts.
 * @returns {{ matched: boolean, replayScore: number, reason: string|null }}
 */
export function solitaireReplayOutcome(replayed, claimScore) {
  const { replayScore, failedAt, undoLimitExceeded, undoCount, total } = replayed;

  if (failedAt >= 0) {
    // The client logs an action only when its applier changed the state, so in
    // an honest log every action applies. An action that changed nothing means
    // the log was assembled for a different deal, spliced, or forged whole.
    return {
      matched: false,
      replayScore,
      reason: `action ${failedAt} of ${total} changed nothing when replayed`,
    };
  }

  if (undoLimitExceeded) {
    return {
      matched: false,
      replayScore,
      reason: `the log undoes ${undoCount} times; a game allows ${MAX_UNDOS_PER_GAME}`,
    };
  }

  if (replayScore !== SOLITAIRE_WIN_SCORE) {
    return {
      matched: false,
      replayScore,
      reason: `the replayed game ended on ${replayScore} of ${SOLITAIRE_WIN_SCORE} cards, not a won deal`,
    };
  }

  if (claimScore !== SOLITAIRE_WIN_SCORE) {
    return {
      matched: false,
      replayScore,
      reason: `the claim asserts ${claimScore}, but only a won deal of ${SOLITAIRE_WIN_SCORE} pays`,
    };
  }

  return { matched: true, replayScore, reason: null };
}
