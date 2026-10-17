/**
 * Server-side Raven Bubbles replay: re-running a claimed ceiling session from
 * its per-step input log.
 *
 * ## The guarantee this exists to build
 *
 * The same one as `replay.js` (the brawler's, whose chunk machinery this
 * cabinet shares), in the form Raven Bubbles can answer it: not "could a run
 * like this have happened?" but "did this run happen?" The worker rebuilds the
 * run from `(difficulty, seed, inputs)` — the difficulty fixes the target
 * score, the *issued* seed fixes every roll the run makes while it is played
 * (the opening deal, every screen refill, and every queue deal of
 * `pickNextColor`), the log fixes what each 16 ms step was fed (the quantised
 * aim angle, the fire press) — then reads the score that falls out. Only a run
 * whose replay ends `gameOver && won` at the score the claim asserts is a win
 * worth paying for.
 *
 * ## Why the streamed shape, not a whole-log one
 *
 * `WHOLE_LOG_VERIFIERS` is for turn-based cabinets whose entire proof is a
 * short action list that re-applies in microseconds. A bubble run is tens of
 * thousands of steps of continuous flight, and each shot's resolution re-runs
 * the queue's weighting — a real share of the Worker's 10 ms CPU budget — so a
 * claim that replayed its whole log in one request would be killed
 * mid-simulation on long honest wins. It therefore joins `STREAMED_CABINETS`
 * instead: the client posts `verify-chunk` windows while the run is played,
 * each request steps one `CHUNK_TICKS` slice and parks, and the claim arrives
 * to find the park already fully stepped — resuming it and stepping the short
 * tail is all that is left. See `intentVerifyChunk` for the park's rules.
 *
 * ## Why the seed is issued, not named
 *
 * Unlike Pac-Man's and Barley Breaker's engines, this one has genuine runtime
 * RNG — the call sites are listed in the header of
 * `../../src/features/arcade/games/ravenbubbles/engine.ts`. A seed the client
 * picked is a run the client could shop for (a board dealt with the triples
 * already in place, a queue that always hands over the completing colour), so
 * the seed is read from `active_runs.seed` — the number this worker drew when
 * the run opened — exactly as Tetris's, Frogger's, Barley Breaker's, Frogger's
 * and the brawler's replays do. The claim carries no seed field at all; a run
 * opened before seeding (a null ledger seed) is refused with the reason rather
 * than verified against something guessable.
 *
 * ## Difficulty: the worker's, not the claim's
 *
 * The claim names a difficulty *by name*; the worker re-derives today's from
 * the UTC date (via `getRavenBubblesDifficulty`) and accepts only today's or
 * yesterday's — a run may open before UTC midnight and finish after it. Any
 * other name is refused before a single step: "always claim easy" would turn
 * the daily target into a formality.
 *
 * ## What is checked, in order
 *
 *  1. **The log decoded** — a log that cannot be decoded was not produced by
 *     the client's encoder: protocol garbage, not a mismatch. Recorded as
 *     `matched: null`, kept apart from genuine disagreements.
 *  2. **Difficulty validated** — known name, and today's or yesterday's.
 *  3. **Every byte is an input the client can produce** — a byte outside the
 *     encoding (see `decodeTick`) was never written by `encodeTick`. For this
 *     cabinet's layout (fire in bit 7, a 128-level aim in the rest) that is
 *     every byte 0..255, so the check fires only on values no `Uint8Array`
 *     could carry anyway.
 *  4. **Lengths agree** — `ticks` must equal the log's byte count, non-zero,
 *     under the shared `MAX_REPLAY_TICKS` ceiling.
 *  5. **The replay finished** — a log that runs out mid-run is not a win.
 *  6. **The replay won** — a run that replays exactly but ends below the
 *     target (or with the cluster over the line) is still no coin.
 *  7. **The claim's score agrees with its own log** — the number the claim
 *     asserts must be the number the replay produced.
 *
 * Every reason goes into `replay_verdicts`, so the first check that fires is
 * the one an operator will read months later.
 */

import {
  createRuntime,
  decodeTick,
  tick,
  FIXED_STEP_MS,
} from "../../src/features/arcade/games/ravenbubbles/engine.ts";
import {
  RAVEN_BUBBLES_DIFFICULTIES,
  getRavenBubblesDifficulty,
} from "../../src/features/arcade/games/ravenbubbles/session.ts";
import { decodeInputLog } from "@nightshade/shared/inputLog";
import { MAX_REPLAY_TICKS } from "@nightshade/shared/anticheat/replayBudget";
import { CHUNK_TICKS, ReplayInputError } from "./replay.js";

/**
 * Resolve the difficulty a replay names, refusing anything the date would not
 * have chosen.
 *
 * @param {unknown} name The claim's difficulty name.
 * @returns {import("../../src/features/arcade/games/ravenbubbles/session.ts").RavenBubblesDifficulty}
 * @throws {ReplayInputError} for an unknown name or one that is neither
 *   today's nor yesterday's.
 */
function resolveRavenBubblesDifficulty(name) {
  const known = RAVEN_BUBBLES_DIFFICULTIES.find((d) => d.name === name);
  if (!known) {
    throw new ReplayInputError(
      `unknown difficulty "${String(name).slice(0, 32)}"`,
    );
  }

  const now = Date.now();
  const today = getRavenBubblesDifficulty(now);
  const yesterday = getRavenBubblesDifficulty(now - 86_400_000);

  if (known.name !== today.name && known.name !== yesterday.name) {
    throw new ReplayInputError(
      `the replay names difficulty ${known.name}, but only ${today.name} (today) or ${yesterday.name} (yesterday) are accepted`,
    );
  }

  return known;
}

/**
 * The issued seed, or a refusal.
 *
 * A row written before `active_runs.seed` existed has none, and there is no
 * fallback to a day hash or any other guessable number: that would verify the
 * run against a seed anyone could work out, which for *this* engine — whose
 * deals and queue all derive from the seed — would verify a run anyone could
 * have shopped for. Better to refuse the run and say why.
 *
 * @param {unknown} seed The ledger's `active_runs.seed` for this run.
 * @returns {number} The seed as an unsigned 32-bit integer.
 * @throws {ReplayInputError} when the run has no usable issued seed.
 */
function assertRunSeed(seed) {
  // `typeof` first on purpose: `Number(null)` is 0, and `Number("")` is 0 —
  // coercing before checking would turn a run with *no* seed into the guessable
  // seed 0 and sail past the very refusal this function exists to make.
  const numeric = typeof seed === "number" ? seed : Number(seed);
  if (
    typeof seed !== "number" ||
    !Number.isInteger(numeric) ||
    numeric < 0 ||
    numeric > 0xffffffff
  ) {
    throw new ReplayInputError(
      "This run has no server-issued seed; it was opened before seeding and cannot be verified.",
    );
  }
  return numeric;
}

/**
 * Refuse any byte `encodeTick` could not have written.
 *
 * @param {Uint8Array} inputs
 * @param {string} where Which log this is, for the error message.
 * @throws {ReplayInputError} on the first byte outside the encoding.
 */
function validateInputBytes(inputs, where) {
  for (let i = 0; i < inputs.length; i++) {
    if (decodeTick(inputs[i]) === null) {
      throw new ReplayInputError(
        `${where} byte ${i} is ${inputs[i]}, which is not an input the client can produce`,
      );
    }
  }
}

/**
 * Validate a claim's replay payload: shape, difficulty, input log.
 *
 * Pure — no D1, no engine stepping, and deliberately no seed: the seed is the
 * ledger's column, passed separately where it is needed, so a claim cannot
 * name one. Throws `ReplayInputError` on anything that could not have come
 * from the client; returns the decoded components for `startRavenBubblesReplay`.
 *
 * @param {unknown} replay The claim's `replay` field.
 * @returns {{ difficulty: object, inputs: Uint8Array, total: number }}
 * @throws {ReplayInputError} when the submission cannot describe a run.
 */
export function validateRavenBubblesReplay(replay) {
  if (!replay || typeof replay !== "object") {
    throw new ReplayInputError("the replay is missing");
  }

  const difficulty = resolveRavenBubblesDifficulty(replay.difficulty);

  let inputs;
  try {
    inputs = decodeInputLog(String(replay?.inputs ?? ""));
  } catch {
    throw new ReplayInputError("the input log is not decodable");
  }

  const total = Number(replay.ticks);
  if (!Number.isInteger(total) || total !== inputs.length) {
    throw new ReplayInputError(
      `the log says ${replay.ticks} steps but carries ${inputs.length} bytes of input`,
    );
  }
  if (total === 0) {
    throw new ReplayInputError("the input log is empty");
  }
  if (total > MAX_REPLAY_TICKS) {
    throw new ReplayInputError(
      `the input log is implausibly long (${total} steps)`,
    );
  }

  validateInputBytes(inputs, "the input log's");

  return { difficulty, inputs, total };
}

/**
 * Open a replay from tick zero — a claim with no park to resume.
 *
 * `seed` is the number the server issued for this run, read from
 * `active_runs` at claim time. It is never taken from the claim: the claim is
 * the browser's word, and a seed the client picks is one the client can also
 * satisfy, which would make the replay a restatement of the request rather
 * than a check on it.
 *
 * @param {unknown} replay The claim's `replay` field.
 * @param {unknown} seed The ledger's `active_runs.seed` for this run.
 * @returns {{ match: object, inputs: Uint8Array, cursor: number, total: number }}
 * @throws {ReplayInputError} when the submission cannot describe a run.
 */
export function startRavenBubblesReplay(replay, seed) {
  const { difficulty, inputs, total } = validateRavenBubblesReplay(replay);
  return {
    match: createRuntime(difficulty, assertRunSeed(seed)),
    inputs,
    cursor: 0,
    total,
  };
}

/**
 * Open the replay of a run whose chunks arrive *during* play, not at claim.
 *
 * Same engine and same rules as `startRavenBubblesReplay` — the difference is
 * what it validates: a first chunk carries the opening window of a run still
 * being played, so there is no `ticks` to check yet, only the difficulty the
 * window opens under. The seed is the ledger's, passed in by
 * `intentVerifyChunk` (which read it from `active_runs`, never from the
 * request).
 *
 * @param {{ seed: unknown, difficulty: unknown, inputs: Uint8Array }} first
 *   The opening window: ledger seed, claimed difficulty name, decoded bytes.
 * @returns {{ match: object, inputs: Uint8Array, cursor: number, total: number }}
 * @throws {ReplayInputError} when the chunk cannot open a run.
 */
export function openRavenBubblesChunkReplay({ seed, difficulty, inputs }) {
  const resolved = resolveRavenBubblesDifficulty(difficulty);

  if (!(inputs instanceof Uint8Array) || inputs.length === 0) {
    throw new ReplayInputError("the first chunk carries no inputs");
  }
  validateInputBytes(inputs, "the first chunk's");

  return {
    match: createRuntime(resolved, assertRunSeed(seed)),
    inputs,
    cursor: 0,
    total: inputs.length,
  };
}

/**
 * Advance the replay by up to `maxTicks` steps, mutating `state`.
 *
 * Mutation is the contract, not a style choice: the shared park plumbing
 * (`runReplayVerification`, `intentVerifyChunk`, `intentContinueVerification`)
 * calls `engine.step(state, CHUNK_TICKS)` and ignores what comes back. An
 * engine that returned a new park and left its argument alone would be stepped
 * from zero on every request, every claim would end "replay in progress", and
 * nothing would ever be verified. Same shape as `stepGoblinInvadersReplay`.
 *
 * The input byte is read from the log *before* the step it is feeding, in the
 * same order the client pushed it — the log records what the step was taken
 * *under*, because that is what `tick` consumes.
 *
 * @param {{ match: object, inputs: Uint8Array, cursor: number, total: number }} state
 * @param {number} [maxTicks]
 * @returns {number} steps actually stepped this call.
 * @throws {ReplayInputError} if the parked log holds an undecodable byte.
 */
export function stepRavenBubblesReplay(state, maxTicks = CHUNK_TICKS) {
  const start = state.cursor;
  const stop = Math.min(state.cursor + maxTicks, state.total);
  while (state.cursor < stop) {
    const input = decodeTick(state.inputs[state.cursor]);
    if (input === null) {
      throw new ReplayInputError(
        `the parked log's byte ${state.cursor} is ${state.inputs[state.cursor]}, which is not an input`,
      );
    }
    state.match = tick(state.match, FIXED_STEP_MS, input);
    state.cursor += 1;
  }
  return state.cursor - start;
}

/**
 * The outcome of a finished replay, as the fields a verdict compares.
 *
 * `reachedFinale` is the win latch: `won` is only ever set together with
 * `gameOver` (by the score check at the run's final state inside `tick`), so a
 * run that was still going when the log ran out reports `false` — and the
 * claim is refused on it before the score is even considered.
 */
export function ravenBubblesOutcome(state) {
  const match = state.match;
  return {
    score: match.score,
    ceilingRow: match.ceilingRow,
    reachedFinale: match.gameOver === true && match.won === true,
    ticks: state.cursor,
  };
}
