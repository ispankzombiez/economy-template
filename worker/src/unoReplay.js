/**
 * Server-side Uno replay: re-applying a claimed game's player choices to its
 * deal, re-simulating the three bots in between.
 *
 * ## The guarantee this exists to build
 *
 * The Solitaire twin (see `solitaireReplay.js` for the full argument), in the
 * only form a four-player game can answer it: not "could a game like this
 * have happened?" but "did this game happen?" The worker rebuilds the deck
 * from `(seed, choices)` — the seed fixes the shuffle *and* every bot colour
 * pick *and* every refill after it, because all three draw from the one
 * generator stream the deal was built over — then re-applies the player's
 * choices while re-simulating bots 1–3 from the same rules and the same
 * stream. Only a game that ends with the player's hand empty is a win worth
 * paying for.
 *
 * ## Why the bots are re-simulated, not logged
 *
 * A four-player game might look like it needs four logs. It does not. Bots
 * have no choices of their own: `botChooseCard` reads only the hand, the
 * discard top and the active colour, and the one roll per Wild comes from the
 * seeded stream above. So the log is the player's choices and nothing else,
 * and this module re-runs the bots between them exactly as the client did.
 * Recording a bot move would only re-record what the rules already determine,
 * and a recorded bot move the rules disagree with would be a hole, not a
 * proof — which is why the log deliberately cannot carry one.
 *
 * ## Why one request, no parking, no chunks
 *
 * The same structural reason as Solitaire and Go Fish: a turn-based game's
 * proof is its *choice list*, not a tick trace. A complete game is a hundred
 * or so bytes — one to three per choice — and replaying it is a few dozen
 * O(hand) state transitions plus at most three bot turns between each pair of
 * player choices: microseconds, comfortably inside the single 10 ms request
 * the claim arrives in. The brawler's `openChunkReplay` /
 * `appendChunkInputs` machinery exists because ten thousand physics ticks
 * cannot fit in that budget; none of it applies here.
 *
 * ## Why there is no difficulty check
 *
 * Uno has no difficulty at all: the lobby offers a daily reward run, but the
 * game itself deals the same way from its seed every time (see the game's
 * `session.ts`). So the replay validates a seed and the choices and nothing
 * else; a `difficulty` field, if one ever arrives, is ignored rather than
 * believed, since there is no table to disagree with.
 *
 * ## What is checked, in order
 *
 *  1. **The log decoded** (throwing `UnoReplayInputError`) — a log that
 *     cannot be decoded was not produced by the client's encoder, and is
 *     protocol garbage rather than a game that failed to match. Recorded as
 *     `matched: null`, kept apart from genuine mismatches so verdict noise
 *     cannot drown the signal.
 *  2. **Every choice applied** — the engine returns its input unchanged for
 *     an illegal choice (not the player's turn, game over, a card the hand
 *     does not hold, a play the active colour refuses, a Wild with no colour
 *     named). The client only logs choices the engine applied. A dead choice
 *     at index *i* means the log was assembled for a different deal, spliced,
 *     or forged whole.
 *  3. **The bots could be driven** — `failedAt: -2` means the bot loop never
 *     reached the player's turn again. That is unreachable in both honest and
 *     hostile play (every bot turn advances the seat), so it is a defect in
 *     this engine rather than evidence about the player, and is recorded as
 *     an input/infra error (`matched: null`) rather than a mismatch.
 *  4. **The game ended** — a log that stops mid-game is not a win.
 *  5. **The player won** — a bot winning, or a game still in progress, is
 *     still no coin: the cabinet pays only on a player-emptying win.
 *  6. **The claim's score agrees with its own log** — a win claim asserts a
 *     score of exactly 1; anything else (a loss submitted as a win) is a
 *     claim whose own numbers disagree with the game it describes.
 *
 * Every reason goes into `replay_verdicts`, so the first check that fires is
 * the one an operator will read months later.
 */

import {
  createInitialState,
  replayUnoActions,
} from "../../src/features/arcade/games/uno/engine.ts";
import {
  decodeUnoActionLog,
  decodeUnoLog,
  MAX_UNO_ACTIONS,
} from "@nightshade/shared/unoLog";

/**
 * A malformed submission — not evidence of anything.
 *
 * A decode failure means the client and worker disagree about the protocol,
 * or someone is probing the endpoint. Either way it must not count as a
 * mismatch, or protocol noise would drown the signal the verdict rows exist
 * to measure. The caller keeps these apart from genuine replay mismatches.
 */
export class UnoReplayInputError extends Error {}

/**
 * Validate a claim's replay payload: shape, seed, action log.
 *
 * Pure — no D1, no clock. Throws `UnoReplayInputError` on anything that could
 * not have come from the client's encoder; returns the decoded components for
 * `runUnoReplay`.
 *
 * @param {unknown} replay The claim's `replay` field.
 * @returns {{ seed: number, actions: object[], total: number }}
 */
export function validateUnoReplay(replay) {
  if (!replay || typeof replay !== "object") {
    throw new UnoReplayInputError("the replay is missing");
  }

  const seed = replay.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new UnoReplayInputError("the replay's seed is not a 32-bit integer");
  }

  const actionsBase64 = replay.actions;
  if (typeof actionsBase64 !== "string" || actionsBase64.length === 0) {
    throw new UnoReplayInputError("the replay carries no action log");
  }

  let actions;
  try {
    // Both layers throw on anything malformed — a wild play missing its
    // colour byte, a colour over 3, a log over the ceiling, un-base64-able
    // input. Refused here, before any replay: a log that cannot be decoded
    // was not produced by the client's encoder, and is protocol garbage
    // rather than a game that failed to match.
    actions = decodeUnoActionLog(decodeUnoLog(actionsBase64));
  } catch (error) {
    throw new UnoReplayInputError(
      error instanceof Error
        ? error.message
        : "the action log could not be decoded",
    );
  }

  if (actions.length === 0) {
    throw new UnoReplayInputError("the action log is empty");
  }
  if (actions.length > MAX_UNO_ACTIONS) {
    // Belt and braces: `decodeUnoActionLog` already enforces the ceiling, but
    // the ceiling is a hard resource bound (it caps this request's work and
    // the base64's size), so it is checked against the *decoded count* here
    // too rather than trusted to one layer.
    throw new UnoReplayInputError("the action log is over the ceiling");
  }

  return { seed, actions, total: actions.length };
}

/**
 * Re-apply a validated replay to its deal and read the game that falls out.
 *
 * Pure: no D1, no KV, no network — the caller records whatever it learns.
 * May throw only on a genuinely impossible state (the engine's own
 * invariants); every ordinary forgery is reported through `failedAt` or the
 * final winner, because a forged log that *crashed* the verifier would look
 * like an outage rather than a refusal.
 *
 * @param {{ seed: number, actions: object[], total: number }} validated
 * @returns {{
 *   replayScore: number,
 *   failedAt: number,
 *   gameOver: boolean,
 *   winner: string|null,
 *   total: number,
 * }}
 */
export function runUnoReplay({ seed, actions, total }) {
  // One `createInitialState`, no solver search — the claim's seed is the one
  // the deck was dealt from, so this rebuilds the exact game the player
  // played on, bot colour picks and refills included (they resume the same
  // generator stream the shuffle consumed).
  const initial = createInitialState(seed);
  const replayed = replayUnoActions(initial, actions);

  return {
    // The cabinet's score is binary — a win is 1, anything else is 0 — which
    // is exactly what the client submits alongside a claim, so this number
    // can be compared directly against what the claim asserts.
    replayScore: replayed.state.winner === "player" ? 1 : 0,
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
 * the coin, so they are ordered from the most *useful* reason to the least: a
 * tampered choice, then an engine that could not be driven, then an unfinished
 * game, then an outcome that is not a player win, then a claim whose score
 * disagrees with its own log. Each reason goes into `replay_verdicts`, so the
 * first check that fires is the one an operator will read months later.
 *
 * `matched` is true only for a log that replayed choice-for-choice to a
 * finished player win *and* a claim asserting a score of 1. A game that
 * replayed perfectly but ended with a bot winning is still no coin: Uno pays
 * only on the player emptying their hand.
 *
 * `failedAt: -2` is deliberately returned as `matched: null` rather than a
 * mismatch — see the note in the module header: it is our defect, not the
 * player's, and counting it as a mismatch would poison the verdict table.
 *
 * @param {ReturnType<typeof runUnoReplay>} replayed
 * @param {number|null} claimScore The score the claim asserts.
 * @returns {{ matched: boolean|null, replayScore: number, reason: string|null }}
 */
export function unoReplayOutcome(replayed, claimScore) {
  const { replayScore, failedAt, gameOver, winner, total } = replayed;

  if (failedAt === -2) {
    return {
      matched: null,
      replayScore,
      reason: `the bot loop did not converge while replaying choice ${total} (engine defect, not a mismatch)`,
    };
  }

  if (failedAt >= 0) {
    // The client logs a choice only when the engine changed the state, so in
    // an honest log every choice applies. A choice that changed nothing means
    // the log was assembled for a different deal, spliced, or forged whole.
    return {
      matched: false,
      replayScore,
      reason: `choice ${failedAt} of ${total} changed nothing when replayed`,
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
      reason: `the claim asserts ${claimScore}, the replay produced ${replayScore}`,
    };
  }

  return { matched: true, replayScore, reason: null };
}
