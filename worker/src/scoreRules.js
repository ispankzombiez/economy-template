/**
 * The score ceiling, derived from the game's own wave data.
 *
 * ## Why this file exists
 *
 * A checkpoint claim is refused when its score exceeds what a legitimate run
 * could have earned at that wave. For that number to mean anything it must
 * match the real game exactly — a ceiling guessed by hand drifts the moment
 * someone tunes an enemy's score, and a drift in the *lenient* direction turns
 * the check into decoration.
 *
 * So this module imports `WAVES` from the client's own `enemies.ts` rather than
 * copying it. One source of truth: the same table the client plays with is the
 * table the worker certifies against. `enemies.ts` is safe to bundle here
 * because its only import from the rest of the game is `import type` — erased
 * at build time — so it pulls in no rendering, no assets and no React.
 *
 * ## What a legitimate score is made of
 *
 * Four sources, exhaustively (see `engine.ts`):
 *
 *   1. a kill — `match.score += victim.score`, every enemy including ambushes;
 *   2. clearing a wave — `WAVE_CLEAR_SCORE + waveIndex * 100`;
 *   3. clearing the finale — `FINALE_BONUS_SCORE`, once;
 *   4. a pickup — `PICKUP_SCORE`.
 *
 * (1)–(3) are computable exactly from the wave table. (4) is not, and neither
 * is the score from **ambushes** — enemies that step out during the walk
 * between waves, drawn from the upcoming wave's grunts, 1–2 at a time at up to
 * two points per walk. Those two sources are therefore added as an explicit
 * allowance rather than omitted: omitting them would reject honest runs, which
 * is worse than the cheat it prevents.
 */

import {
  FINALE_BONUS_SCORE,
  WAVES,
  WAVE_CLEAR_SCORE,
  getEnemySpec,
} from "../../src/features/arcade/games/sunflowerbrawler/enemies.ts";

/** Points a single pickup awards (`pickups.ts`, which bundles art and cannot be imported here). */
const PICKUP_SCORE = 50;

/**
 * Score an ambush could contribute across a whole run, worst case.
 *
 * Up to two points per walk, up to two enemies per point, one walk between each
 * of the fifteen waves, drawn from that wave's grunts — the most valuable of
 * which is the wizard at 340. That is the ceiling, not the expectation: an
 * allowance sized to the expectation would reject a run that got unlucky in the
 * player's favour.
 */
const AMBUSH_ALLOWANCE = 24_000;

/**
 * Score pickups could contribute across a whole run, worst case.
 *
 * Every kill rolls once against its enemy's `dropChance` (1.0 for all three
 * bosses), and `rollPickup` may decline when health and magic are both full.
 * Sized as every kill dropping and every drop collected.
 */
const PICKUP_ALLOWANCE = 6_000;

/** Cumulative maximum score after clearing wave `index` (0-based), per wave. */
const MAX_SCORE_BY_WAVE = (() => {
  const cumulative = [];
  let running = 0;

  for (let index = 0; index < WAVES.length; index++) {
    const wave = WAVES[index];

    // Kills: every spawn in the wave, at its published score.
    for (const spawn of wave.spawns) {
      const spec = getEnemySpec(spawn.id);
      running += spec.score * spawn.count;
    }

    // Wave-clear bonus: `WAVE_CLEAR_SCORE + waveIndex * 100`, applied the
    // moment the wave's last enemy falls — i.e. *at* this wave, index-based.
    running += WAVE_CLEAR_SCORE + index * 100;

    // The finale bonus latches once wave 15 is cleared, so it belongs to the
    // same wave rather than to a sixteenth.
    if (index === WAVES.length - 1) running += FINALE_BONUS_SCORE;

    // The two sources that cannot be computed are spread across the waves they
    // can occur on, proportionally to how far into the run the player is.
    const progress = (index + 1) / WAVES.length;
    const allowance = Math.round((AMBUSH_ALLOWANCE + PICKUP_ALLOWANCE) * progress);

    // Rounded up to the nearest hundred so the published number reads as a
    // bound rather than as false precision.
    cumulative.push(Math.ceil((running + allowance) / 100) * 100);
  }

  return cumulative;
})();

/**
 * The highest score a legitimate run could hold after clearing `wave`
 * (1-based).
 *
 * Out-of-range waves return the last entry: the verifier rejects the claim on
 * wave progression before it ever consults this, so returning the ceiling
 * rather than `Infinity` keeps a malformed claim from reading as "no limit".
 *
 * @param {number} wave  1-based wave reached.
 * @returns {number}
 */
export function maxScoreAtWave(wave) {
  if (!Number.isFinite(wave) || wave < 1) return MAX_SCORE_BY_WAVE[0];
  const index = Math.min(Math.floor(wave), MAX_SCORE_BY_WAVE.length) - 1;
  return MAX_SCORE_BY_WAVE[Math.max(0, index)];
}

/**
 * The raw per-wave ceilings, index 0 = wave 1.
 *
 * Handed to `verifyCheckpoints` as `rules.maxScoreByWave` so the verifier reads
 * the exact bound for the wave rather than interpolating one.
 */
export { MAX_SCORE_BY_WAVE };

/** The ceiling for a full run — wave 15 cleared, finale bonus included. */
export const MAX_RUN_SCORE = MAX_SCORE_BY_WAVE[MAX_SCORE_BY_WAVE.length - 1];
