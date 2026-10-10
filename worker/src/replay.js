/**
 * Server-side replay: re-simulating a claimed run from its logged inputs.
 *
 * ## The guarantee this exists to build
 *
 * Checkpoints ask "could a run like this have happened?" — fifteen moments at
 * which the claimed state is not impossible. A plausible-looking forgery clears
 * that bar. Replay asks a different and much harder question: "did it?" The
 * worker rebuilds the match from `(seed, playerId, difficulty)` and feeds it the
 * player's own per-tick inputs, then reads the score that falls out. That score
 * is the only one worth paying, because it is the only one derived from
 * something the player actually did rather than something they asserted.
 *
 * ## Why the engine is imported, not reimplemented
 *
 * `createMatch` and `stepMatch` below are the *client's* engine, bundled by
 * wrangler from `src/features/arcade/games/sunflowerbrawler/engine.ts`. Writing
 * a second simulation here would be the single most dangerous thing this
 * package could do: two implementations of one ruleset will disagree, and a
 * cheater plays whichever one is more lenient. One engine, one file, imported
 * by both ends.
 *
 * ## Why chunked
 *
 * A run to the finale is ~10,000 ticks, and the worker's CPU budget per request
 * is 10 ms. Replaying the whole run in one request would blow it. So a replay
 * advances in fixed slices, and the `MatchState` between slices is parked in
 * D1 and resumed by the next request. The step count per slice is a config
 * value, not a structural limit: if the plan is ever upgraded off the free
 * tier, raising it collapses the whole replay into a single call with no other
 * change.
 *
 * See `CHUNK_TICKS` for the arithmetic behind the default.
 */

import {
  createMatch,
  stepMatch,
  emptyInput,
  FIXED_STEP_MS,
  INPUT_BUFFER_MS,
} from "../../src/features/arcade/games/sunflowerbrawler/engine.ts";
import { FIGHTERS } from "../../src/features/arcade/games/sunflowerbrawler/fighters.ts";
import { SUNFLOWER_BRAWLER_DIFFICULTIES } from "../../src/features/arcade/games/sunflowerbrawler/session.ts";
import { applyMask, decodeInputLog } from "@nightshade/shared/inputLog";
import { CHUNK_TICKS, MAX_REPLAY_TICKS } from "@nightshade/shared/replayBudget";

/**
 * Re-exported so callers keep one import. The numbers themselves are shared
 * with the client, which needs the same pair to bound its continuation loop —
 * see `@nightshade/shared/replayBudget` for why two ends must not choose them
 * separately.
 */
export { CHUNK_TICKS, MAX_REPLAY_TICKS };

/** The champions a replay may name. Derived from the engine's own roster. */
const VALID_FIGHTER_IDS = new Set(FIGHTERS.map((fighter) => fighter.id));

/** The difficulties a replay may name, keyed the way the client names them. */
const DIFFICULTY_BY_NAME = new Map(
  SUNFLOWER_BRAWLER_DIFFICULTIES.map((difficulty) => [difficulty.name, difficulty]),
);

/**
 * A replay that could not be started, with the reason a human would want.
 *
 * This is a *rejection*, not a mismatch. A mismatch is a run that replayed to a
 * different outcome and is evidence worth recording; a rejection means the
 * submission was malformed and says nothing about whether the run was real.
 * Conflating the two would poison the match rate with protocol errors, so the
 * caller keeps them apart.
 */
class ReplayInputError extends Error {}

/**
 * Build the resumable replay state a claim opens, or explain why it cannot be.
 *
 * Everything validated here is validated against tables the engine itself
 * exports, never against a list written out again by hand: a champion added to
 * `FIGHTERS` is immediately replayable, and a made-up id is refused rather than
 * being coerced into the first fighter — coercion would simulate a different
 * game than the one played and report the divergence as cheating.
 *
 * Split into `validateReplay` and `startReplay` because a claim's replay spans
 * many requests, and the two halves need very different things. Validation runs
 * once per claim — on the request that supplies the log, so a submission cannot
 * smuggle in a mismatched `ticks` — while constructing a match is comparatively
 * expensive and must also run *once*, on the first chunk only. A resumed replay
 * neither validates again nor reconstructs: `resumeReplay` reads back the row
 * the claim parked, log included, so the continuation steps bytes it never saw
 * submitted and cannot swap them out from under a match already part-stepped.
 *
 * @param {{ seed: unknown, playerId: unknown, difficulty: unknown,
 *           ticks: unknown, inputs: unknown }} replay The claim's `replay` field.
 * @returns {{ seed: number, playerId: string, difficulty: object,
 *             inputs: Uint8Array, total: number }}
 * @throws {ReplayInputError} when the submission cannot describe a run.
 */
export function validateReplay(replay) {
  const seed = Number(replay?.seed);
  if (!Number.isFinite(seed)) {
    throw new ReplayInputError("the replay is missing its seed");
  }

  const playerId = String(replay?.playerId ?? "");
  if (!VALID_FIGHTER_IDS.has(playerId)) {
    throw new ReplayInputError(`unknown champion "${playerId.slice(0, 32)}"`);
  }

  const difficulty = DIFFICULTY_BY_NAME.get(String(replay?.difficulty ?? ""));
  if (!difficulty) {
    throw new ReplayInputError(`unknown difficulty "${String(replay?.difficulty).slice(0, 32)}"`);
  }

  let inputs;
  try {
    inputs = decodeInputLog(String(replay?.inputs ?? ""));
  } catch {
    throw new ReplayInputError("the input log is not decodable");
  }

  const total = Number(replay?.ticks);
  if (!Number.isInteger(total) || total !== inputs.length) {
    throw new ReplayInputError(
      `the log says ${replay?.ticks} ticks but carries ${inputs.length} bytes of input`,
    );
  }
  if (total === 0) {
    throw new ReplayInputError("the input log is empty");
  }
  if (total > MAX_REPLAY_TICKS) {
    throw new ReplayInputError(`the input log is implausibly long (${total} ticks)`);
  }

  return { seed, playerId, difficulty, inputs, total };
}

/**
 * Open a replay: validate the claim, then build the match it will step.
 *
 * The match comes from the same three constants the client opened with. The RNG
 * is seeded here and nowhere else, so the worker's stream and the client's are
 * the same stream — which is the entire reason Stage A moved every
 * `Math.random` out of the simulation.
 *
 * @returns {{ match: object, inputs: Uint8Array, cursor: number, total: number }}
 * @throws {ReplayInputError} when the submission cannot describe a run.
 */
export function startReplay(replay) {
  const { seed, playerId, difficulty, inputs, total } = validateReplay(replay);
  return {
    match: createMatch({ playerId, difficulty, input: emptyInput(), seed }),
    inputs,
    cursor: 0,
    total,
  };
}

/**
 * Revive a parked replay so the next chunk can resume it.
 *
 * The continuation is sent nothing but its intent — deliberately. The inputs it
 * steps are the ones the claim submitted and this function validated, read back
 * from the row the claim parked; a continuation that supplied its own log could
 * supply a *different* one of the same length, steering the re-simulation away
 * from what was claimed while the parked match carried on, and corrupting
 * exactly the match rate Stage B exists to measure.
 *
 * The length check is the binding between the two: it is what proves the parked
 * log still describes `total` ticks, so a truncated or swapped row fails here
 * rather than mid-step, where it would surface as a bogus mismatch.
 *
 * @param {{ state: object, cursor: number, total: number, inputs: string }} park
 * @returns {{ match: object, inputs: Uint8Array, cursor: number, total: number }}
 * @throws {ReplayInputError} when the parked row cannot describe its own run.
 */
export function resumeReplay(park) {
  let inputs;
  try {
    inputs = decodeInputLog(String(park?.inputs ?? ""));
  } catch {
    throw new ReplayInputError("the parked input log is not decodable");
  }

  const total = Number(park?.total);
  if (inputs.length !== total) {
    throw new ReplayInputError(
      `the parked log holds ${inputs.length} ticks but claims ${park?.total}`,
    );
  }

  const cursor = Number(park?.cursor);
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > total) {
    throw new ReplayInputError(`the parked cursor ${park?.cursor} is outside its log`);
  }

  return { match: park.state, inputs, cursor, total };
}

/**
 * Advance the replay by up to `CHUNK_TICKS`, mutating `state`.
 *
 * The input is restored the way the client wrote it — masked onto the shared
 * input object with the engine's own buffer constant, *before* the step, since
 * the step drains the attack and magic buffers and sampling afterwards would
 * record the press as already spent.
 *
 * @returns {number} ticks actually stepped this call.
 */
export function stepReplay(state, maxTicks = CHUNK_TICKS) {
  const start = state.cursor;
  const stop = Math.min(state.cursor + maxTicks, state.total);
  while (state.cursor < stop) {
    applyMask(state.match.playerInput, state.inputs[state.cursor], INPUT_BUFFER_MS);
    stepMatch(state.match, FIXED_STEP_MS);
    state.cursor += 1;
  }
  return state.cursor - start;
}

/** True once every logged tick has been re-simulated. */
export function isReplayComplete(state) {
  return state.cursor >= state.total;
}

/**
 * The outcome of a finished replay, as the fields a verdict compares.
 *
 * Read straight off the settled state rather than through `readHud`, because
 * the HUD exists to be drawn and this exists to be diffed — it needs the same
 * numbers and nothing else.
 */
export function replayOutcome(state) {
  const match = state.match;
  return {
    score: match.score,
    wave: match.waveIndex,
    lives: match.lives,
    hp: match.player.hp,
    magic: match.magic,
    reachedFinale: match.reachedFinale,
    result: match.result,
    ticks: state.cursor,
  };
}

export { ReplayInputError };
