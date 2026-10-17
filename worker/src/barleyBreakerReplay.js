/**
 * Server-side Barley Breaker replay: re-running a claimed breaker session from
 * its per-step input log.
 *
 * ## The guarantee this exists to build
 *
 * The same one as `replay.js` (the brawler's, whose chunk machinery this
 * cabinet shares), in the form Barley Breaker can answer it: not "could a run
 * like this have happened?" but "did this run happen?" The worker rebuilds the
 * run from `(difficulty, inputs)` — the difficulty fixes the target score,
 * starting lives and drop rolls, the log fixes what each 16 ms step was fed
 * (direction, launch, touch scrub) — then reads the score that falls out. Only
 * a run whose replay ends `gameOver && won` at the score the claim asserts is
 * a win worth paying for.
 *
 * ## Why the streamed shape, not a whole-log one
 *
 * `WHOLE_LOG_VERIFIERS` is for turn-based cabinets whose entire proof is a
 * short action list that re-applies in microseconds. A breaker run is
 * 6,000–40,000 steps of continuous physics: even at a microsecond a step is
 * several times the Worker's 10 ms CPU budget, so a claim that replayed its
 * whole log in one request would be killed mid-simulation on every honest win
 * long enough to matter. It therefore joins `STREAMED_CABINETS` instead: the
 * client posts `verify-chunk` windows while the run is played, each request
 * steps one `CHUNK_TICKS` slice and parks, and the claim arrives to find the
 * park already fully stepped — resuming it and stepping the short tail is all
 * that is left. See `intentVerifyChunk` for the park's rules.
 *
 * ## Why there is no seed
 *
 * The brawler's and Tetris's replays open with a *issued* seed because their
 * engines roll dice and deal a bag. Barley Breaker's engine does neither: the
 * drop rolls and strong-brick layouts are an integer hash of
 * `(wave, row, col, salt)`, there is no clock anywhere in the step, and the
 * difficulty is fixed at run-open (baked into the runtime so a park resumed
 * days later still steps under the target it was played with). Zero RNG means
 * the inputs alone carry the run — which is also why `SEEDED_CABINETS` does
 * not grow today: a seed nothing reads is a round trip and a column to keep
 * backfilled, for nothing. See the header of `../../src/features/arcade/games/
 * barleybreaker/engine.ts` for the exactness argument (no transcendentals —
 * `Math.sin` and friends are implementation-defined, and a breakout's chaos
 * amplifies one ulp into a different run).
 *
 * ## Difficulty: the worker's, not the claim's
 *
 * The claim names a difficulty *by name*; the worker re-derives today's from
 * the UTC date (via `getBarleyBreakerDifficulty`) and accepts only today's or
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
 *     encoding (see `decodeTick`) was never written by `encodeTick`.
 *  4. **Lengths agree** — `ticks` must equal the log's byte count, non-zero,
 *     under the shared `MAX_REPLAY_TICKS` ceiling.
 *  5. **The replay finished** — a log that runs out mid-run is not a win.
 *  6. **The replay won** — a run that replays exactly but ends below the
 *     target (or out of lives) is still no coin.
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
} from "../../src/features/arcade/games/barleybreaker/engine.ts";
import {
  BARLEY_BREAKER_DIFFICULTIES,
  getBarleyBreakerDifficulty,
} from "../../src/features/arcade/games/barleybreaker/session.ts";
import { decodeInputLog } from "@nightshade/shared/inputLog";
import { MAX_REPLAY_TICKS } from "@nightshade/shared/anticheat/replayBudget";
import { CHUNK_TICKS, ReplayInputError } from "./replay.js";

/**
 * Resolve the difficulty a replay names, refusing anything the date would not
 * have chosen.
 *
 * @param {unknown} name The claim's difficulty name.
 * @returns {import("../../src/features/arcade/games/barleybreaker/session.ts").BarleyBreakerDifficulty}
 * @throws {ReplayInputError} for an unknown name or one that is neither
 *   today's nor yesterday's.
 */
function resolveBarleyBreakerDifficulty(name) {
  const known = BARLEY_BREAKER_DIFFICULTIES.find((d) => d.name === name);
  if (!known) {
    throw new ReplayInputError(
      `unknown difficulty "${String(name).slice(0, 32)}"`,
    );
  }

  const now = Date.now();
  const today = getBarleyBreakerDifficulty(now);
  const yesterday = getBarleyBreakerDifficulty(now - 86_400_000);

  if (known.name !== today.name && known.name !== yesterday.name) {
    throw new ReplayInputError(
      `the replay names difficulty ${known.name}, but only ${today.name} (today) or ${yesterday.name} (yesterday) are accepted`,
    );
  }

  return known;
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
 * Pure — no D1, no engine stepping. Throws `ReplayInputError` on anything
 * that could not have come from the client; returns the decoded components
 * for `startBarleyBreakerReplay`.
 *
 * @param {unknown} replay The claim's `replay` field.
 * @returns {{ difficulty: object, inputs: Uint8Array, total: number }}
 * @throws {ReplayInputError} when the submission cannot describe a run.
 */
export function validateBarleyBreakerReplay(replay) {
  if (!replay || typeof replay !== "object") {
    throw new ReplayInputError("the replay is missing");
  }

  const difficulty = resolveBarleyBreakerDifficulty(replay.difficulty);

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
 * Open a replay: validate the claim, then build the run it will step.
 *
 * The runtime comes from `createRuntime` — the same call the client made at
 * run-open — with the *validated* difficulty, so the win check inside `tick`
 * reuses the target the run was played under while still having refused any
 * target the date would not have chosen.
 *
 * @param {unknown} replay The claim's `replay` field.
 * @returns {{ match: object, inputs: Uint8Array, cursor: number, total: number }}
 * @throws {ReplayInputError} when the submission cannot describe a run.
 */
export function startBarleyBreakerReplay(replay) {
  const { difficulty, inputs, total } = validateBarleyBreakerReplay(replay);
  return {
    match: createRuntime(difficulty),
    inputs,
    cursor: 0,
    total,
  };
}

/**
 * Open the replay of a run whose chunks arrive *during* play, not at claim.
 *
 * Same engine and same difficulty rule as `startBarleyBreakerReplay` — the
 * difference is what it validates: a first chunk carries the opening window of
 * a run still being played, so there is no `ticks` to check yet, only the
 * difficulty the window opens under.
 *
 * @param {{ difficulty: unknown, inputs: Uint8Array }} first The opening
 *   window, already decoded by the chunk intent.
 * @returns {{ match: object, inputs: Uint8Array, cursor: number, total: number }}
 * @throws {ReplayInputError} when the chunk cannot open a run.
 */
export function openBarleyBreakerChunkReplay({ difficulty, inputs }) {
  const resolved = resolveBarleyBreakerDifficulty(difficulty);

  if (!(inputs instanceof Uint8Array) || inputs.length === 0) {
    throw new ReplayInputError("the first chunk carries no inputs");
  }
  validateInputBytes(inputs, "the first chunk's");

  return {
    match: createRuntime(resolved),
    inputs,
    cursor: 0,
    total: inputs.length,
  };
}

/**
 * Advance the replay by up to `maxTicks` steps, mutating `state`.
 *
 * The input byte is read from the log *before* the step it is feeding, in the
 * same order the client pushed it — the log records what the step was taken
 * *under*, because that is what `tick` consumes.
 *
 * The byte was validated when the log was accepted, but a parked log is
 * re-decoded from D1 on every continuation, so the lookup is re-checked here
 * too: an unknown byte mid-step throws rather than silently stepping as
 * "no input", which would re-simulate a different run and blame the player
 * for the divergence.
 *
 * @param {{ match: object, inputs: Uint8Array, cursor: number, total: number }} state
 * @param {number} [maxTicks]
 * @returns {number} steps actually stepped this call.
 * @throws {ReplayInputError} if the parked log holds an undecodable byte.
 */
export function stepBarleyBreakerReplay(state, maxTicks = CHUNK_TICKS) {
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
 * `gameOver` (by the score check inside `tick`), so a run that was still going
 * when the log ran out, or that ended out of lives, reports `false` — and the
 * claim is refused on it before the score is even considered.
 */
export function barleyBreakerOutcome(state) {
  const match = state.match;
  return {
    score: match.score,
    lives: match.lives,
    round: match.wave,
    reachedFinale: match.gameOver === true && match.won === true,
    ticks: state.cursor,
  };
}
