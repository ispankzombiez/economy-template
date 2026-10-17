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
 * The match comes from the same three constants the client opened with, but its
 * RNG is seeded from the **issued** seed — the number this worker drew when the
 * run opened (`active_runs.seed`), passed by the caller and never read back out
 * of the claim. The claim's own `seed` field is the browser's word; a seed the
 * client picks is one the client can also satisfy, which would make the replay
 * a restatement of the request rather than a check on it. The two are compared
 * rather than reconciled: a claim whose declared seed is not the issued one did
 * not play the run the ledger holds, and is refused by name.
 *
 * @param {{ seed: unknown, playerId: unknown, difficulty: unknown,
 *           ticks: unknown, inputs: unknown }} replay The claim's `replay` field.
 * @param {unknown} issuedSeed The seed the server issued for this run.
 * @returns {{ match: object, inputs: Uint8Array, cursor: number, total: number }}
 * @throws {ReplayInputError} when the submission cannot describe a run, or its
 *   seed was not the one issued.
 */
export function startReplay(replay, issuedSeed) {
  const { seed, playerId, difficulty, inputs, total } = validateReplay(replay);
  return {
    match: createMatch({
      playerId,
      difficulty,
      input: emptyInput(),
      seed: bindIssuedSeed(seed, issuedSeed),
    }),
    inputs,
    cursor: 0,
    total,
  };
}

/**
 * The issued seed, or a refusal.
 *
 * Two refusals, for two different facts. A run opened before `active_runs.seed`
 * existed has no seed at all — there is no fallback to a day hash or a client
 * value, because verifying against a seed anyone could work out is the exact
 * outcome the column exists to prevent; better to refuse and say why. A run
 * whose ledger seed disagrees with the seed the claim declares is a client that
 * played something other than what it was issued — seed shopping, or a stale
 * bundle — and is refused just as plainly rather than being papered over with a
 * score mismatch nobody can debug.
 *
 * The `typeof` guard first, deliberately: `Number(null)` is `0`, and a null
 * ledger column must refuse rather than silently become seed 0.
 *
 * @param {number} declaredSeed The seed the claim says it played from.
 * @param {unknown} issuedSeed The ledger's seed for this run.
 * @returns {number} The issued seed.
 * @throws {ReplayInputError} when the run has no issued seed, or the claim's
 *   seed is not it.
 */
function bindIssuedSeed(declaredSeed, issuedSeed) {
  if (
    typeof issuedSeed !== "number" ||
    !Number.isInteger(issuedSeed) ||
    issuedSeed < 0 ||
    issuedSeed > 0xffffffff
  ) {
    throw new ReplayInputError(
      "This run has no server-issued seed; it was opened before seeding and cannot be verified.",
    );
  }
  if (declaredSeed !== issuedSeed) {
    throw new ReplayInputError("the replay's seed was not issued for this run");
  }
  return issuedSeed;
}

/**
 * Whether a parked row can be adopted by a claim whose log is *longer* than the
 * park holds.
 *
 * ## Why this exists
 *
 * The park used to have to match the claim's log in size, exactly. That is a far
 * stricter condition than it looks: a streamed run's park is built window by
 * window over several minutes of play, and the claim's log is however long the
 * run finally turned out to be. Any single window that failed to land — one
 * dropped connection, one request the network never answered — leaves the park
 * short, and an exact-size test throws away *all* the stepping that did survive
 * and restarts the run from tick zero.
 *
 * For a short run that is merely wasteful. For a long one it is unrecoverable:
 * the worker's whole budget is one 600-tick slice per request, so a 23,556-tick
 * run restarted from zero can never be finished by the claim alone, no matter how
 * many times it is retried. The run is stranded, and with it the player's coin.
 *
 * ## Why a prefix is safe to adopt
 *
 * Adopting is only sound if the parked match was stepped over *this claim's*
 * bytes. So the parked log is compared byte-for-byte against the claim's own
 * first `park.total` bytes, and any difference — a different run, an edited
 * window, a swapped row — declines adoption and falls back to a fresh start,
 * exactly as before.
 *
 * This is a strictly weaker precondition than "same size and same run key" *and*
 * strictly stronger than trusting the park's length alone: the bytes the parked
 * match already consumed are proven to be the claim's bytes, so continuing from
 * `park.cursor` steps precisely the remaining input, in order, with no gap and no
 * overlap.
 *
 * @param {{ total: unknown, inputs: unknown }} park
 * @param {Uint8Array} claimInputs The claim's own decoded log.
 * @returns {boolean} True when the park is a verified prefix of the claim.
 */
export function parkExtendsClaim(park, claimInputs) {
  const total = Number(park?.total);
  if (!Number.isInteger(total) || total <= 0) return false;
  if (total > claimInputs.length) return false;

  let parkedInputs;
  try {
    parkedInputs = decodeInputLog(String(park?.inputs ?? ""));
  } catch {
    return false;
  }
  if (parkedInputs.length !== total) return false;

  for (let i = 0; i < total; i++) {
    if (parkedInputs[i] !== claimInputs[i]) return false;
  }
  return true;
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
 * Open the replay of a run whose chunks arrive *during* play, not at claim.
 *
 * Same engine, same seeding rule as `startReplay` — the difference is what it
 * validates. A claim carries a finished log and asserts its own length; the
 * first chunk carries the opening window of a run still being played, so there
 * is no `ticks` to check yet. Everything else the window names (seed, champion,
 * difficulty) is validated the same way and against the same engine-derived
 * tables, because a park that opened a different match than the run it came
 * from would diverge for reasons that have nothing to do with cheating.
 *
 * @param {{ seed: unknown, playerId: unknown, difficulty: unknown,
 *           inputs: Uint8Array }} first The opening window, already decoded.
 * @returns {{ match: object, inputs: Uint8Array, cursor: number, total: number }}
 * @throws {ReplayInputError} when the chunk cannot open a run.
 */
export function openChunkReplay({ seed, playerId, difficulty, inputs }) {
  const numericSeed = Number(seed);
  if (!Number.isFinite(numericSeed)) {
    throw new ReplayInputError("the first chunk is missing its seed");
  }

  const id = String(playerId ?? "");
  if (!VALID_FIGHTER_IDS.has(id)) {
    throw new ReplayInputError(`unknown champion "${id.slice(0, 32)}"`);
  }

  const diff = DIFFICULTY_BY_NAME.get(String(difficulty ?? ""));
  if (!diff) {
    throw new ReplayInputError(
      `unknown difficulty "${String(difficulty).slice(0, 32)}"`,
    );
  }

  if (!(inputs instanceof Uint8Array) || inputs.length === 0) {
    throw new ReplayInputError("the first chunk carries no inputs");
  }

  return {
    match: createMatch({
      playerId: id,
      difficulty: diff,
      input: emptyInput(),
      seed: numericSeed,
    }),
    inputs,
    cursor: 0,
    total: inputs.length,
  };
}

/**
 * Splice one more live window into a parked replay.
 *
 * The park is a *growing* log: the buffer is exactly as long as the windows
 * received so far, `total` is that same length — which is what keeps
 * `resumeReplay`'s length check true across every write — and the window lands
 * at the cursor, which for a stream that kept its order is the first tick not
 * yet logged. Growing by reallocation rather than pre-sizing to
 * `MAX_REPLAY_TICKS`: a park that died mid-run should cost the bytes it
 * verified, not the ceiling it never reached.
 *
 * @param {{ match: object, inputs: Uint8Array, cursor: number,
 *           total: number }} state The park, grown in place.
 * @param {Uint8Array} chunk The next window; at most `CHUNK_TICKS` long, a
 *   length the caller checks, since the budget is its own concern.
 * @returns {object} `state`.
 * @throws {ReplayInputError} when the window has nothing to add.
 */
export function appendChunkInputs(state, chunk) {
  if (chunk.length === 0) {
    throw new ReplayInputError("the chunk carries no inputs");
  }

  const end = state.cursor + chunk.length;
  if (end > state.inputs.length) {
    const grown = new Uint8Array(end);
    grown.set(state.inputs);
    state.inputs = grown;
  }
  state.inputs.set(chunk, state.cursor);
  state.total = state.inputs.length;
  return state;
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
