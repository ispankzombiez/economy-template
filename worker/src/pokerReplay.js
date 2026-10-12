/**
 * Server-side Poker replay: re-applying a claimed session's bets and street
 * choices to its seeded deal.
 *
 * ## The guarantee this exists to build
 *
 * The Blackjack twin (see `blackjackReplay.js` for the full argument), in the
 * form Poker can answer it: not "could a session like this have happened?" but
 * "did this session happen?" The worker rebuilds the session from
 * `(seed, difficulty, bets+choices)` — the seed fixes every shuffle across all
 * hands, the difficulty fixes the chip target (re-derived from the UTC date,
 * not believed from the claim), and the log fixes every player choice — then
 * reads the session that falls out. Only a session that ends with
 * playerChips >= targetChips within `POKER_MAX_HANDS`, at the chip count the
 * claim asserts, is a win worth paying for.
 *
 * ## Why one request, no parking, no chunks
 *
 * The same structural reason as Solitaire / Go Fish / Blackjack / Uno: a
 * turn-based session's proof is its *bet/choice list*, not a tick trace. A
 * full session is 15 bytes and replays in microseconds — five hands, nine
 * cards each, a `HouseAI` answer per street, no loops that can be long. The
 * brawler's `openChunkReplay`/`appendChunkInputs` machinery exists because ten
 * thousand physics ticks cannot fit in the 10 ms budget; none of it applies
 * here, and the chunk intents deliberately do not accept this cabinet (see
 * `intentVerifyChunk`).
 *
 * ## Difficulty check: the worker's, not the claim's
 *
 * Poker re-derives today's difficulty from the UTC date (via
 * `getPokerDifficulty`), because its difficulty decides the chip target —
 * "always claim easy" would be free money. The claim names a difficulty index;
 * the worker re-derives and only accepts today's or yesterday's (a run may
 * cross UTC midnight). Any other difficulty is refused.
 *
 * ## What is checked, in order
 *
 *  1. **The log decoded** (throwing `PokerReplayInputError`) — a log that
 *     cannot be decoded was not produced by the client's encoder, and is
 *     protocol garbage rather than a game that failed to match. Recorded as
 *     `matched: null`, kept apart from genuine mismatches so verdict noise
 *     cannot drown the signal.
 *  2. **Difficulty validated** — the claim's must be today's or yesterday's.
 *  3. **Every hand and choice applied** — the engine reports the step it died
 *     at (a refused bet, a dead street choice, a choice after the hand ended,
 *     a hand logged after the session was already decided). A dead step means
 *     the log was assembled for a different deal, spliced, or forged whole.
 *  4. **The session ended** — a log that stops mid-session is not a win.
 *  5. **The session was won** — a session that replays perfectly but ends
 *     below the target is still no coin: the cabinet pays on a cleared
 *     session, and a verifier that paid partial sessions would be verifying a
 *     different game than it deals.
 *  6. **The claim's score agrees with its own log** — the final chip count the
 *     claim asserts must be the chip count the replay produced.
 *
 * Every reason goes into `replay_verdicts`, so the first check that fires is
 * the one an operator will read months later.
 */

import {
  createPokerState,
  replayPokerSession,
  sessionOver,
  sessionWon,
} from "../../src/features/arcade/games/poker/engine.ts";
import {
  POKER_DIFFICULTIES,
  getPokerDifficulty,
} from "../../src/features/arcade/games/poker/session.ts";
import {
  POKER_BET_AMOUNTS,
  decodePokerActionLog,
  decodePokerLog,
  MAX_POKER_ACTIONS,
  MAX_POKER_HANDS,
} from "@nightshade/shared/pokerLog";

/**
 * A malformed submission — not evidence of anything.
 *
 * A decode failure means the client and worker disagree about the protocol,
 * or someone is probing the endpoint. Either way it must not count as a
 * mismatch, or protocol noise would drown the signal the verdict rows exist
 * to measure. The caller keeps these apart from genuine replay mismatches.
 */
export class PokerReplayInputError extends Error {}

/**
 * Validate a claim's replay payload: shape, seed, difficulty, action log.
 *
 * Pure — no D1, no clock. Throws `PokerReplayInputError` on anything that
 * could not have come from the client's encoder; returns the decoded
 * components for `runPokerReplay`.
 *
 * @param {unknown} replay The claim's `replay` field.
 * @returns {{
 *   seed: number,
 *   difficultyIdx: number,
 *   hands: { betIdx: number; actions: number[] }[],
 *   totalActions: number,
 * }}
 */
export function validatePokerReplay(replay) {
  if (!replay || typeof replay !== "object") {
    throw new PokerReplayInputError("the replay is missing");
  }

  const seed = replay.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new PokerReplayInputError(
      "the replay's seed is not a 32-bit integer",
    );
  }

  const difficultyIdx = replay.difficulty;
  if (
    !Number.isInteger(difficultyIdx) ||
    difficultyIdx < 0 ||
    difficultyIdx > 3
  ) {
    throw new PokerReplayInputError(
      "the replay's difficulty index is invalid",
    );
  }

  const actionsBase64 = replay.actions;
  if (typeof actionsBase64 !== "string" || actionsBase64.length === 0) {
    throw new PokerReplayInputError("the replay carries no action log");
  }

  let decoded;
  try {
    decoded = decodePokerActionLog(decodePokerLog(actionsBase64));
  } catch (error) {
    throw new PokerReplayInputError(
      error instanceof Error
        ? error.message
        : "the action log could not be decoded",
    );
  }

  if (decoded.difficultyIdx !== difficultyIdx) {
    throw new PokerReplayInputError(
      "the replay's difficulty index disagrees with the log's",
    );
  }

  // Now validate the difficulty against the date — today's or yesterday's only.
  const now = Date.now();
  const today = getPokerDifficulty(now);
  const yesterday = getPokerDifficulty(now - 86_400_000);
  const todayIdx = POKER_DIFFICULTIES.findIndex(
    (d) => d.name === today.name,
  );
  const yesterdayIdx = POKER_DIFFICULTIES.findIndex(
    (d) => d.name === yesterday.name,
  );

  if (difficultyIdx !== todayIdx && difficultyIdx !== yesterdayIdx) {
    throw new PokerReplayInputError(
      `the replay names difficulty ${
        POKER_DIFFICULTIES[difficultyIdx]?.name ?? difficultyIdx
      }, but only ${today.name} (today) or ${yesterday.name} (yesterday) are accepted`,
    );
  }

  const { hands } = decoded;
  if (hands.length === 0) {
    throw new PokerReplayInputError("the session has no hands");
  }
  if (hands.length > MAX_POKER_HANDS) {
    throw new PokerReplayInputError(
      `the session has ${hands.length} hands, over the ceiling of ${MAX_POKER_HANDS}`,
    );
  }

  const totalActions = hands.reduce((sum, h) => sum + h.actions.length, 0);
  if (totalActions === 0) {
    throw new PokerReplayInputError("the action log is empty");
  }
  if (totalActions > MAX_POKER_ACTIONS) {
    throw new PokerReplayInputError(
      `total actions ${totalActions} exceeds ceiling ${MAX_POKER_ACTIONS}`,
    );
  }

  // Structural re-checks: the decoder already enforced them, but a claim whose
  // shape disagrees with the cabinet's rules should be named as protocol
  // trouble before a single card is dealt.
  for (let h = 0; h < hands.length; h++) {
    const hand = hands[h];
    if (hand.betIdx < 0 || hand.betIdx > POKER_BET_AMOUNTS.length - 1) {
      throw new PokerReplayInputError(
        `hand ${h}: invalid bet index ${hand.betIdx}`,
      );
    }
    if (!hand.actions || hand.actions.length < 1 || hand.actions.length > 2) {
      throw new PokerReplayInputError(
        `hand ${h}: a hand carries 1 or 2 street choices`,
      );
    }
    for (let a = 0; a < hand.actions.length; a++) {
      const action = hand.actions[a];
      if (action < 0 || action > 2) {
        throw new PokerReplayInputError(
          `hand ${h}, action ${a}: invalid action ${action}`,
        );
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
 *   targetChips: number,
 *   totalActions: number,
 * }}
 */
export function runPokerReplay({ seed, difficultyIdx, hands, totalActions }) {
  const difficulty = POKER_DIFFICULTIES[difficultyIdx];
  if (!difficulty) {
    throw new Error(`Internal: invalid difficulty index ${difficultyIdx}`);
  }

  const initial = createPokerState(seed, difficulty);
  const replayed = replayPokerSession(initial, { difficultyIdx, hands });

  return {
    replayScore: replayed.state.playerChips,
    failedAt: replayed.failedAt,
    sessionOver: sessionOver(replayed.state),
    sessionWon: sessionWon(replayed.state),
    targetChips: difficulty.targetChips,
    totalActions,
  };
}

/**
 * Turn a finished replay into the claim's verdict.
 *
 * The order of the checks is diagnostic, not defensive — any failure refuses
 * the coin, so they are ordered from the most *useful* reason to the least: a
 * tampered or spliced log, then an unfinished session, then a session that is
 * not a win, then a claim whose score disagrees with its own log. Each reason
 * goes into `replay_verdicts`, so the first check that fires is the one an
 * operator will read months later.
 *
 * `matched` is true only for a log that replayed choice-for-choice to a
 * finished session win *and* a claim asserting that same chip count. A
 * half-finished session replaying perfectly is still no coin: Poker pays on a
 * cleared session, and a verifier that paid partial sessions would be
 * verifying a different game than the cabinet deals.
 *
 * @param {ReturnType<typeof runPokerReplay>} replayed
 * @param {number|null} claimScore The score the claim asserts (final chip count).
 * @returns {{ matched: boolean, replayScore: number, reason: string|null }}
 */
export function pokerReplayOutcome(replayed, claimScore) {
  const {
    replayScore,
    failedAt,
    sessionOver: over,
    sessionWon: won,
    targetChips,
    totalActions,
  } = replayed;

  if (failedAt >= 0) {
    // The client logs a choice only when the engine accepted it, so in an
    // honest log every choice applies. A step that did nothing — or a hand
    // logged past where the cabinet would have offered one — means the log was
    // assembled for a different deal, spliced, or forged whole.
    const handIdx = failedAt >> 8;
    const step = failedAt & 0xff;

    const stepReasons = [
      `the bet for hand ${handIdx} was refused when replayed`,
      `choice 1 of hand ${handIdx} (of ${totalActions} total) changed nothing when replayed`,
      `choice 2 of hand ${handIdx} (of ${totalActions} total) changed nothing when replayed`,
      `a choice arrived after hand ${handIdx} had already ended`,
      `hand ${handIdx} had not finished when its choices ran out`,
      `hand ${handIdx} began after the session was already over`,
    ];
    return {
      matched: false,
      replayScore,
      reason: stepReasons[step] ?? `replay stopped at hand ${handIdx}, step ${step}`,
    };
  }

  if (failedAt === -2) {
    return {
      matched: false,
      replayScore,
      reason: "the replay's difficulty disagrees with the seed's session",
    };
  }

  if (!over) {
    return {
      matched: false,
      replayScore,
      reason: "the replayed session had not finished when the log ran out",
    };
  }

  if (!won) {
    return {
      matched: false,
      replayScore,
      reason: `the replayed session ended with ${replayScore} chips, below the ${targetChips} target`,
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
