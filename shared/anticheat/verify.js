/**
 * Checkpoint verification — the game-agnostic anti-cheat core.
 *
 * ## What this is and is not
 *
 * A player who beats a cabinet says "I won, here is my score." The server cannot
 * trust that. Full tick-by-tick replay (record every input, re-simulate the
 * whole run) would be the gold standard, but a multi-minute run at 60Hz is tens
 * of thousands of steps and far too large for a Worker to re-simulate inside its
 * CPU budget — and too large for a mobile player to upload on cellular.
 *
 * So instead of proving *"these exact inputs produced this,"* the server proves
 * *"this claimed outcome is reachable by a legitimate run"* — by checking a
 * handful of **checkpoints** the client emits at legal milestones (each wave
 * clear, each boss defeat, the finale) against the run's hard invariants. A
 * forged claim almost always violates one of them, because the easiest way to
 * cheat — invent a high score — is exactly what these rules catch.
 *
 * The invariants checked here are the ones no honest run can break:
 *
 *  - **Score never decreases, and never exceeds its proven ceiling.** The engine
 *    caps how many points a run *could* have earned by the waves cleared; a
 *    claim above that ceiling is arithmetic no amount of skill reaches.
 *  - **Wave progression is monotonic and legal.** You cannot clear wave 9 before
 *    wave 8, skip a boss, or clear a wave twice.
 *  - **Resources stay in range.** Health and magic are never negative and never
 *    exceed their maxima; lives never go negative.
 *  - **The run is physically possible.** A run cannot be cleared faster than the
 *    engine's own minimum (walks between waves, wave-clear banners, boss
 *    health). A "5000-point Expert run in 4 seconds" is refused on pace alone.
 *
 * ## Why the rules are data, not code
 *
 * A game supplies a `CheckpointRules` object describing its own ceilings and
 * floors (max score per wave, minimum ms per wave, resource maxima). This module
 * never hard-codes a specific cabinet's numbers — so the same verifier powers
 * every game, and adding a cabinet means describing its rules, not extending
 * this engine. That keeps the anti-cheat honest: the rules live next to the game
 * they describe, and this file stays a fixed, auditable set of invariants.
 *
 * Like `rng.js`, this is a plain ES module so the Worker imports it natively and
 * the Vite client shares the exact same implementation. Types are in
 * `verify.d.ts`.
 */

/**
 * @typedef {Object} Checkpoint
 * @property {number} seq      Ordinal index, 0-based, contiguous. No gaps.
 * @property {number} wave     1-based wave this checkpoint marks reaching.
 * @property {number} score    Cumulative score at this checkpoint.
 * @property {number} hp       Player health, 0..maxHp.
 * @property {number} magic    Player magic meter, 0..maxMagic.
 * @property {number} lives    Lives remaining.
 * @property {number} ms       Elapsed run time in ms at this checkpoint.
 */

/**
 * @typedef {Object} CheckpointRules
 * @property {number} maxWave          Highest legal wave index (1-based).
 * @property {number} maxScoreCeiling  Absolute score ceiling for a full run.
 * @property {number} maxHp            Player health maximum.
 * @property {number} maxMagic         Magic meter maximum.
 * @property {number} maxLives         Lives the run started with.
 * @property {number} minMsPerWave     Physical floor: ms a legitimate run needs
 *                                     per wave (walks + banners + boss health).
 * @property {number} finaleWave       The wave that constitutes a win.
 */

/**
 * @typedef {Object} VerifyInput
 * @property {Checkpoint[]} checkpoints  Emitted in play order.
 * @property {CheckpointRules} rules
 * @property {number} claimedScore      The score the player says they earned.
 * @property {boolean} claimedWin       Whether they claim a win (finale cleared).
 * @property {number} elapsedMs         Total run wall time.
 */

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} ok
 * @property {string} [reason]  Human-readable refusal. Present iff !ok.
 */

/**
 * The score ceiling for a run that has reached `wave` waves.
 *
 * This is the single most important anti-cheat number and it is deliberately
 * *derivable* rather than asserted: a run's score is bounded by the waves it has
 * actually cleared, so the ceiling grows with progress and a claim that outruns
 * its own progress is caught immediately.
 *
 * **Two shapes, in order of preference.** A game that can compute its exact
 * per-wave maxima supplies `rules.maxScoreByWave` (index 0 = wave 1) and that
 * table is read directly — no interpolation, no approximation, the precise bound
 * the engine itself enforces. A game that cannot falls back to a flat linear
 * share of `maxScoreCeiling`, which is a safe upper bound that still grows with
 * progress, so a claim far beyond the waves cleared is refused either way.
 *
 * The exact table is preferred because Sunflower Brawler's score is heavily
 * *back-loaded* — bosses at waves 5, 10 and 15 award 2000, 3000 and 5000
 * points, plus a finale bonus — so a linear fraction would permit roughly twice
 * the real score in the early waves while being far too tight in the middle.
 * Only the exact curve is honest about that shape.
 *
 * @param {CheckpointRules} rules
 * @param {number} wave
 * @returns {number}
 */
export function scoreCeilingForWave(rules, wave) {
  const table = rules.maxScoreByWave;
  if (Array.isArray(table) && table.length > 0) {
    const index = Math.min(Math.max(Math.floor(wave), 1), table.length) - 1;
    return table[index];
  }

  // Linear share of the absolute ceiling, scaled by waves cleared and clamped.
  const frac = rules.maxWave > 0 ? Math.min(wave / rules.maxWave, 1) : 1;
  return Math.ceil(rules.maxScoreCeiling * frac);
}

/**
 * Verify a claimed outcome against its checkpoints.
 *
 * Returns `{ ok: true }` when the claim is reachable by a legitimate run, or
 * `{ ok: false, reason }` naming the first invariant the claim broke.
 *
 * @param {VerifyInput} input
 * @returns {VerifyResult}
 */
export function verifyCheckpoints(input) {
  const { checkpoints, rules, claimedScore, claimedWin, elapsedMs } = input;

  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return { ok: false, reason: "No checkpoints were supplied." };
  }

  // ── Structural: the log must be contiguous and in order ────────────────────
  for (let i = 0; i < checkpoints.length; i++) {
    const cp = checkpoints[i];
    if (cp.seq !== i) {
      return { ok: false, reason: "Checkpoint sequence is not contiguous." };
    }
    if (i > 0 && cp.ms < checkpoints[i - 1].ms) {
      return { ok: false, reason: "Checkpoint timestamps go backwards." };
    }
  }

  const last = checkpoints[checkpoints.length - 1];

  // ── Wave progression: monotonic, in-range, no skipped bosses ───────────────
  let prevWave = 0;
  for (const cp of checkpoints) {
    if (!Number.isInteger(cp.wave) || cp.wave < 1 || cp.wave > rules.maxWave) {
      return { ok: false, reason: `Wave ${cp.wave} is out of range.` };
    }
    // A run advances one wave at a time. Jumping ahead would mean skipping the
    // fights (and their score) in between — the classic "teleport to the end"
    // cheat.
    if (cp.wave !== prevWave + 1) {
      return {
        ok: false,
        reason: `Wave progression jumped from ${prevWave} to ${cp.wave}.`,
      };
    }
    prevWave = cp.wave;
  }

  // ── Score: monotonic, non-negative, within the proven ceiling ──────────────
  let prevScore = 0;
  for (const cp of checkpoints) {
    if (!Number.isFinite(cp.score) || cp.score < 0) {
      return { ok: false, reason: "Score is negative." };
    }
    if (cp.score < prevScore) {
      return { ok: false, reason: "Score decreased during the run." };
    }
    const ceiling = scoreCeilingForWave(rules, cp.wave);
    if (cp.score > ceiling) {
      return {
        ok: false,
        reason: `Score ${cp.score} exceeds the ${ceiling} possible at wave ${cp.wave}.`,
      };
    }
    prevScore = cp.score;
  }

  // ── The claimed score must match what the checkpoints actually reached ─────
  if (claimedScore !== last.score) {
    return {
      ok: false,
      reason: `Claimed score ${claimedScore} does not match the final checkpoint (${last.score}).`,
    };
  }

  // ── Resources: in range at every checkpoint ────────────────────────────────
  for (const cp of checkpoints) {
    if (!Number.isFinite(cp.hp) || cp.hp < 0 || cp.hp > rules.maxHp) {
      return { ok: false, reason: `Health ${cp.hp} is out of range.` };
    }
    if (!Number.isFinite(cp.magic) || cp.magic < 0 || cp.magic > rules.maxMagic) {
      return { ok: false, reason: `Magic ${cp.magic} is out of range.` };
    }
    if (!Number.isInteger(cp.lives) || cp.lives < 0 || cp.lives > rules.maxLives) {
      return { ok: false, reason: `Lives ${cp.lives} is out of range.` };
    }
  }

  // ── Win claim: the finale must actually have been reached ──────────────────
  if (claimedWin && last.wave < rules.finaleWave) {
    return {
      ok: false,
      reason: `Claimed a win but only reached wave ${last.wave}, not ${rules.finaleWave}.`,
    };
  }

  // ── Pace: the run must have taken a physically possible time ───────────────
  const minMs = rules.minMsPerWave * rules.maxWave;
  if (elapsedMs < minMs) {
    return {
      ok: false,
      reason: `Run finished in ${elapsedMs}ms, faster than the ${minMs}ms minimum.`,
    };
  }
  if (elapsedMs < last.ms) {
    return { ok: false, reason: "Elapsed time is less than the final checkpoint." };
  }

  return { ok: true };
}
