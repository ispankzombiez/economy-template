/**
 * The size limits of a server-side replay, shared by the two ends that must
 * agree about them.
 *
 * A replay of a claimed run advances in chunks: the worker's CPU budget is 10 ms
 * per request and a run to the finale is ~10,000 ticks, so the worker steps a
 * slice, parks the match in D1, and lets the client's continuation intent pull
 * the next slice. Two numbers describe that arrangement:
 *
 *  - **`CHUNK_TICKS`** — how many ticks one request steps.
 *  - **`MAX_REPLAY_TICKS`** — the longest log a claim may submit at all.
 *
 * ## Why they live here and not in the worker
 *
 * Because the *client* needs them too, and for a reason that is easy to miss.
 * `continue-verification` loops a bounded number of times before it gives up,
 * and if that bound times the chunk size falls short of the worker's log
 * ceiling, a legal submission exists that can never finish verifying: the client
 * stops, the park stays half-stepped, and the verdict is never recorded. The
 * two numbers were independently chosen — 100 × 600 against a 64,000 ceiling —
 * and that is exactly the disagreement.
 *
 * So the budget is derived here, once, and both ends read it: the worker
 * enforces the ceiling, the client derives its continuation count from the same
 * pair. Raising either limit is a one-file change that cannot strand a run.
 */

/**
 * Ticks stepped per continuation request.
 *
 * Sized from the measured worst case, not guessed. The heaviest span observed —
 * expert difficulty, wave 4, six enemies live — costs ~1.98 ms of simulation
 * for 600 ticks, plus ~1.1 ms of request/serialisation overhead, so a chunk
 * lands around 3–5 ms of the 10 ms budget. The remainder is left free for GC
 * and for the cold-start penalty, which is a fixed ~0.8–2.4 ms paid once per
 * isolate on the first `stepMatch` call and is *not* a rate — modelling it as
 * one would over-reserve on every subsequent chunk.
 *
 * Deliberately a named constant rather than an inline number, because the
 * correct value depends on the engine's cost per tick. When combat gets
 * cheaper this can rise; when it gets more expensive it must fall. Either way
 * it is one number in one file.
 */
export const CHUNK_TICKS = 600;

/**
 * Ceiling on a replayed log, in ticks.
 *
 * ~18 minutes of simulated time. A certified run ends at the finale, which the
 * pace floor alone puts at ~60 s, and even a dawdling honest player is done
 * inside a few minutes. A log longer than this is not a slow run — it is a
 * buffer being inflated to consume verification effort, so it is refused
 * before a single tick is stepped rather than after the budget is spent.
 */
export const MAX_REPLAY_TICKS = 64_000;
