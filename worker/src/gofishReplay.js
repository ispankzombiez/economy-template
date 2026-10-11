/**
 * Server-side Go Fish replay: re-applying a claimed game's asks to its deal.
 *
 * ## The guarantee this exists to build
 *
 * The Solitaire twin (see `solitaireReplay.js` for the full argument), in the
 * only form Go Fish can answer it: not "could a game like this have
 * happened?" but "did this game happen?" The worker rebuilds the deck from
 * `(seed, asks)` — the seed fixes the shuffle *and* every dealer choice after
 * it, because the dealer's per-turn rank pick draws from the same generator
 * stream the deck was built over — then reads the game that falls out. Only a
 * game that ends with more books for the player than the dealer, at the book
 * count the claim asserts, is a win worth paying for.
 *
 * ## Why one request, no parking, no chunks
 *
 * The same structural reason as Solitaire: a turn-based game's proof is its
 * *ask list*, not a tick trace. A complete game is a few dozen bytes — one
 * byte per ask — and replaying it is a few dozen O(52) state transitions on
 * two hands of cards: microseconds, comfortably inside the single 10 ms
 * request the claim arrives in. The brawler's `openChunkReplay` /
 * `appendChunkInputs` machinery exists because ten thousand physics ticks
 * cannot fit in that budget; none of it applies here, and the chunk intents
 * deliberately do not accept this cabinet (see `intentVerifyChunk`).
 *
 * ## Why there is no difficulty check
 *
 * Solitaire re-derives today's difficulty from the UTC date, because its
 * difficulty decides stock passes and draw count and "always the easy one"
 * would be free money. Go Fish has no difficulty at all: the lobby's "Daily"
 * label is decorative (see the game's `session.ts`) — every game deals the
 * same way from its seed. So the replay validates a seed and the asks and
 * nothing else; a `difficulty` field, if one ever arrives, is ignored rather
 * than believed, since there is no table to disagree with.
 *
 * ## What is checked, in order
 *
 *  1. **The log decoded** (throwing `GoFishReplayInputError`) — a log that
 *     cannot be decoded was not produced by the client's encoder, and is
 *     protocol garbage rather than a game that failed to match. Recorded as
 *     `matched: null`, kept apart from genuine mismatches so verdict noise
 *     cannot drown the signal.
 *  2. **Every ask applied** — the engine returns its input unchanged for an
 *     illegal ask (wrong turn, game over, or a rank the player does not
 *     hold), and the client only logs asks the engine applied. A dead ask at
 *     index *i* means the log was assembled for a different deal, spliced, or
 *     forged whole.
 *  3. **The game ended** — a log that stops mid-game is not a win.
 *  4. **The player won** — a dealer win or a tie replaying perfectly is still
 *     no coin: the cabinet pays on a player win, and a verifier that paid
 *     other outcomes would be verifying a different game than it deals.
 *  5. **The claim's score agrees with its own log** — the books the claim
 *     asserts must be the books the replay produced.
 *
 * Every reason goes into `replay_verdicts`, so the first check that fires is
 * the one an operator will read months later.
 */

import {
  createInitialState,
  replayGoFishActions,
} from "../../src/features/arcade/games/gofish/engine.ts";
import {
  decodeGoFishActionLog,
  decodeGoFishLog,
  MAX_GO_FISH_ACTIONS,
} from "@nightshade/shared/goFishLog";

/**
 * A malformed submission — not evidence of anything.
 *
 * A decode failure means the client and worker disagree about the protocol,
 * or someone is probing the endpoint. Either way it must not count as a
 * mismatch, or protocol noise would drown the signal the verdict rows exist
 * to measure. The caller keeps these apart from genuine replay mismatches.
 */
export class GoFishReplayInputError extends Error {}

/**
 * Validate a claim's replay payload: shape, seed, action log.
 *
 * Pure — no D1, no clock. Throws `GoFishReplayInputError` on anything that
 * could not have come from the client's encoder; returns the decoded
 * components for `runGoFishReplay`.
 *
 * @param {unknown} replay The claim's `replay` field.
 * @returns {{ seed: number, actions: number[], total: number }}
 */
export function validateGoFishReplay(replay) {
  if (!replay || typeof replay !== "object") {
    throw new GoFishReplayInputError("the replay is missing");
  }

  const seed = replay.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new GoFishReplayInputError(
      "the replay's seed is not a 32-bit integer",
    );
  }

  const actionsBase64 = replay.actions;
  if (typeof actionsBase64 !== "string" || actionsBase64.length === 0) {
    throw new GoFishReplayInputError("the replay carries no action log");
  }

  let actions;
  try {
    // Both layers throw on anything malformed — a rank byte over 12, a log
    // over the ceiling, un-base64-able input. Refused here, before any
    // replay: a log that cannot be decoded was not produced by the client's
    // encoder, and is protocol garbage rather than a game that failed to
    // match.
    actions = decodeGoFishActionLog(decodeGoFishLog(actionsBase64));
  } catch (error) {
    throw new GoFishReplayInputError(
      error instanceof Error ? error.message : "the action log could not be decoded",
    );
  }

  if (actions.length === 0) {
    throw new GoFishReplayInputError("the action log is empty");
  }
  if (actions.length > MAX_GO_FISH_ACTIONS) {
    // Belt and braces: `decodeGoFishActionLog` already enforces the ceiling,
    // but the ceiling is a hard resource bound (it caps this request's work
    // and the base64's size), so it is checked against the *decoded count*
    // here too rather than trusted to one layer.
    throw new GoFishReplayInputError("the action log is over the ceiling");
  }

  return { seed, actions, total: actions.length };
}

/**
 * Re-apply a validated replay to its deal and read the game that falls out.
 *
 * Pure: no D1, no KV, no network — the caller records whatever it learns.
 * May throw only on a genuinely impossible state (the engine's own
 * invariants); every ordinary forgery is reported through `failedAt` or the
 * final book counts, because a forged log that *crashed* the verifier would
 * look like an outage rather than a refusal.
 *
 * @param {{ seed: number, actions: number[], total: number }} validated
 * @returns {{
 *   replayScore: number,
 *   failedAt: number,
 *   gameOver: boolean,
 *   winner: string|null,
 *   total: number,
 * }}
 */
export function runGoFishReplay({ seed, actions, total }) {
  // One `createInitialState`, no solver search — the claim's seed is the one
  // the deck was dealt from, so this rebuilds the exact game the player
  // played on, dealer choices included (they resume the same generator
  // stream the shuffle consumed).
  const initial = createInitialState(seed);
  const replayed = replayGoFishActions(initial, actions);

  return {
    replayScore: replayed.state.playerBooks.length,
    failedAt: replayed.failedAt,
    gameOver: replayed.state.gameOver,
    winner: replayed.state.winner,
    total,
  };
}

/**
 * Turn a finished replay into the claim's verdict.
 *
 * The order of the checks is diagnostic, not defensive — any failure refuses
 * the coin, so they are ordered from the most *useful* reason to the least:
 * a tampered ask, then an unfinished game, then an outcome that is not a
 * player win, then a claim whose score disagrees with its own log. Each
 * reason goes into `replay_verdicts`, so the first check that fires is the
 * one an operator will read months later.
 *
 * `matched` is true only for a log that replayed ask-for-ask to a finished
 * player win *and* a claim asserting that same book count. A half-finished
 * game replaying perfectly is still no coin: Go Fish pays on a won game, and
 * a verifier that paid partial boards would be verifying a different game
 * than the cabinet deals.
 *
 * @param {ReturnType<typeof runGoFishReplay>} replayed
 * @param {number|null} claimScore The score the claim asserts.
 * @returns {{ matched: boolean, replayScore: number, reason: string|null }}
 */
export function goFishReplayOutcome(replayed, claimScore) {
  const { replayScore, failedAt, gameOver, winner, total } = replayed;

  if (failedAt >= 0) {
    // The client logs an ask only when the engine changed the state, so in
    // an honest log every ask applies. An ask that changed nothing means the
    // log was assembled for a different deal, spliced, or forged whole.
    return {
      matched: false,
      replayScore,
      reason: `ask ${failedAt} of ${total} changed nothing when replayed`,
    };
  }

  if (!gameOver) {
    return {
      matched: false,
      replayScore,
      reason: "the replayed game had not finished when the log ran out",
    };
  }

  if (winner !== "player") {
    return {
      matched: false,
      replayScore,
      reason: `the replayed game ended as a ${winner} result, not a player win`,
    };
  }

  if (claimScore !== replayScore) {
    return {
      matched: false,
      replayScore,
      reason: `the claim asserts ${claimScore} books, the replay produced ${replayScore}`,
    };
  }

  return { matched: true, replayScore, reason: null };
}
