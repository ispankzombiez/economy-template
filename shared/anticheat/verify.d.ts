/**
 * Types for `verify.js`.
 *
 * Same reasoning as `rng.d.ts`: `verify.js` is a plain ES module so the
 * Cloudflare Worker imports it natively while Vite shares the identical
 * implementation for the client. These declarations give the client types
 * without putting TypeScript syntax in the file the worker imports.
 */

/** One milestone the client emitted during a run (a wave clear, boss, finale). */
export interface Checkpoint {
  /** Ordinal index, 0-based, contiguous. No gaps. */
  seq: number;
  /** 1-based wave this checkpoint marks reaching. */
  wave: number;
  /** Cumulative score at this checkpoint. */
  score: number;
  /** Player health, 0..maxHp. */
  hp: number;
  /** Player magic meter, 0..maxMagic. */
  magic: number;
  /** Lives remaining. */
  lives: number;
  /** Elapsed run time in ms at this checkpoint. */
  ms: number;
}

/** A game's own ceilings and floors, supplied by that cabinet. */
export interface CheckpointRules {
  /** Highest legal wave index (1-based). */
  maxWave: number;
  /**
   * Absolute score ceiling for a full run.
   *
   * Only consulted when `maxScoreByWave` is absent — a game that can compute
   * its exact per-wave maxima should, since this flat value forces the verifier
   * onto a linear approximation of what is usually a very non-linear curve.
   */
  maxScoreCeiling: number;
  /**
   * Exact score ceiling after clearing each wave, index 0 = wave 1.
   *
   * Preferred over `maxScoreCeiling`: read directly, no interpolation, so the
   * bound the verifier enforces is the bound the engine actually enforces.
   */
  maxScoreByWave?: readonly number[];
  /** Player health maximum. */
  maxHp: number;
  /** Magic meter maximum. */
  maxMagic: number;
  /** Lives the run started with. */
  maxLives: number;
  /**
   * Physical floor: ms a legitimate run needs per wave (walks + banners +
   * boss health). A claim faster than this is refused on pace alone.
   */
  minMsPerWave: number;
  /** The wave that constitutes a win. */
  finaleWave: number;
}

export interface VerifyInput {
  /** Emitted in play order. */
  checkpoints: Checkpoint[];
  rules: CheckpointRules;
  /** The score the player says they earned. */
  claimedScore: number;
  /** Whether they claim a win (finale cleared). */
  claimedWin: boolean;
  /** Total run wall time in ms. */
  elapsedMs: number;
}

export interface VerifyResult {
  ok: boolean;
  /** Human-readable refusal. Present iff !ok. */
  reason?: string;
}

/** The score ceiling for a run that has reached `wave` waves. */
export declare function scoreCeilingForWave(
  rules: CheckpointRules,
  wave: number,
): number;

/** Verify a claimed outcome against its checkpoints. */
export declare function verifyCheckpoints(input: VerifyInput): VerifyResult;
