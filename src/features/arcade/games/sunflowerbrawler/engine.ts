import {
  ANIM_FRAMES,
  COMBO,
  FRAME_H,
  FRAME_W,
  getFighter,
  moveDurationMs,
  moveImpactMs,
  moveZReach,
  type FighterId,
  type MoveSpec,
  type Sheets,
} from "./fighters";
import {
  FINALE_BONUS_SCORE,
  getEnemySpec,
  getWaveSpec,
  endlessHpScale,
  endlessLoop,
  WAVE_CLEAR_SCORE,
  WAVE_COUNT,
  waveHpMultiplier,
  waveSpeedMultiplier,
  type EnemyId,
  type EnemySpec,
} from "./enemies";
import {
  CAMERA_SETTLED_EPSILON,
  GROUND_TOP,
  LEVEL_W,
  STAGE_H,
  STAGE_W,
  WALL_X,
  Z_MAX,
  stageOffset,
  zoneCamX,
  zToY,
} from "./stage";
import {
  HEALTH_PICKUP_AMOUNT,
  MAGIC_PICKUP_AMOUNT,
  PICKUP_ART,
  PICKUP_REACH_X,
  PICKUP_REACH_Z,
  PICKUP_SCORE,
  PICKUP_SIZE,
  pickupBobY,
  pickupIsBehind,
  rollPickup,
  type Pickup,
} from "./pickups";
import type { SunflowerBrawlerDifficulty } from "./session";

/**
 * The run: a state machine over waves, and a frame of physics under it.
 *
 * ## Shape of a run
 *
 * ```
 * intro ─► walking ─► fighting ─► waveClear ─┬─► walking  (more waves)
 *                        ▲                  ├─► victory  (last wave cleared)
 *                        │                  └─► down ─┬─► fighting (lives left)
 *                        └────────────────────────────┘      └─► gameOver
 * ```
 *
 * Everything a wave can *decide* lives in `stepMatch`; everything it can show
 * lives in `renderMatch`. The React component owns neither: it feeds input in,
 * watches `hudVersion`, and repaints. That split is what lets the loop run at
 * rAF rate without re-rendering a cabinet's worth of DOM sixty times a second.
 *
 * ## Why the depth axis replaces the jump
 *
 * The fighting game this cabinet used to be had no guard — a jump was the only
 * block, and the escape was a timing window over a hitbox band. There is no
 * jump here and no need for one: an attack resolves with
 * `|a.z − b.z| ≤ zReach`, so **stepping off the line is the dodge**. The plane
 * is 210 px deep against a 99 px body — a bit over three body-heights, deep
 * enough that a wave can spread out across it and a player has somewhere to
 * reposition *to*, and shallow enough that the whole band stays on screen
 * without the camera ever tilting.
 *
 * That one rule does a lot of work. It makes positioning a constant decision
 * rather than a single reaction, it lets four enemies share a screen without
 * all four being able to hit you, and it makes the magic meter's *one*
 * depth-ignoring attack worth saving for.
 *
 * ## Why there is a three-hit string instead of two attack buttons
 *
 * With one attack button, "press it again" has to mean something.
 * `combo1 → combo2 → combo3` runs on a 640 ms window and wraps: the third
 * swing is slower, reaches further and throws much harder, so the choice is
 * *finish the string* or *reset it*, and the enemy's approach timing changes
 * with which you did. Mashing still works; it just does not work well.
 */

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Collision box height. Used for the fallback body and the hitFlash overlay. */
const BODY_H = 99;

/** Source pixels the sprite is anchored on: cell centre-x, feet-y. */
const SPRITE_CX = 48;
const SPRITE_FEET = 39;

/**
 * Sheet pixel → stage pixel. 18 source px of body becomes ~97 stage px.
 *
 * Up from 3.6 when the stage went to 960×540: the fighter has to be a
 * meaningful fraction of a taller screen or the depth plane reads as empty
 * grass rather than as floor you are standing on.
 */
const SPRITE_SCALE = 5.4;

/**
 * Milliseconds a swing stays able to connect after its impact frame.
 *
 * Wide enough that a victim who moved along `z` in the same frame still gets
 * hit — the line has to be a line, not a point — short enough that stepping
 * *early* beats stepping late.
 */
const ACTIVE_MS = 110;

/** How far past either screen edge an enemy may stand before entering. */
const ARENA_PAD = 150;

/** Camera smoothing. Snappy enough that it never lags a meaningful distance. */
const CAMERA_LERP = 8;

// ── Timing ───────────────────────────────────────────────────────────────────

const INTRO_MS = 1600;
const WAVE_INTRO_MS = 1400;
const WAVE_CLEAR_MS = 1700;
const DOWN_MS = 1900;

/** How long a corpse stays on the floor playing its death cycle. */
const DEATH_MS = 1600;

/** Fade-in for a freshly spawned enemy. */
const SPAWN_MS = 420;

/**
 * How long a button press stays armed.
 *
 * Zero would mean a press landing during recovery is thrown away — and
 * recovery is exactly when a player *wants* to be buffering the next swing.
 *
 * 140 ms is ~8 frames, deliberately shorter than the fighting game's 180 ms
 * buffer: with a single attack button, a long one turns the three-hit string
 * into something that queues itself. It buys the tail of a recovery, not the
 * whole of it.
 */
export const INPUT_BUFFER_MS = 140;

/** Window in which the next press plays the *next* swing rather than the first. */
const COMBO_WINDOW_MS = 640;

/** Frames a hit freezes the world, by move weight. */
const HITSTOP_LIGHT = 70;
const HITSTOP_HEAVY = 110;

const SHAKE_LIGHT = 5;
const SHAKE_HEAVY = 9;

/** Invulnerability after a hit, on top of the hitstun itself. */
const HIT_INVULN_PAD = 120;

/**
 * How far into a zone the player must be before a wave may open.
 *
 * Half a screen. For every zone after the first this is free — reaching a
 * zone's camera position already means standing past this — so it exists
 * entirely for zone 0, whose camera range is degenerate (`[0, 0]`) and is
 * therefore "settled" from the very first frame. Without it wave 1 would open
 * during the intro banner, before the player had pressed anything.
 */
const WAVE_ENTRY_X = STAGE_W * 0.5;

/**
 * Ambush points along a walk, as a fraction of it.
 *
 * A walk runs from wherever the last wave ended to the point at which the
 * camera settles and the next wave opens — `WAVE_ENTRY_X` past the zone's
 * camera position. Its length therefore varies a lot with how the fight ended,
 * so the ambush points are fractions of the *walk*, not absolute distances.
 *
 * One ambush on a short walk, two on a long one. The threshold is set so the
 * opening walk — which is only a third of a screen, because the player starts
 * mid-screen — gets none: an ambush in the first few paces of a run is an
 * ambush before the player has learned the plane, and it would be the first
 * thing they met.
 */
const roamPoints = (span: number): readonly number[] =>
  span >= STAGE_W * 1.2 ? [0.3, 0.72] : [0.55];

/** Enemies in one ambush. Never a heavy, never more than a pair. */
const ROAM_MIN = 1;
const ROAM_MAX = 2;

/**
 * Health scale for a roamer.
 *
 * Below 1 on purpose. An ambush is an interruption to a walk, not a wave: the
 * player is usually mid-stride, not set, and this should cost a little health
 * at worst rather than a life.
 */
const ROAM_HP_SCALE = 0.72;

/** Distance ahead of the player the first roamer steps out. */
const ROAM_AHEAD_X = 230;

/** Distance behind the player a second roamer comes from. */
const ROAM_BEHIND_X = 190;

/** Banner duration for an ambush. */
const ROAM_BANNER_MS = 950;

/** Invulnerability on respawn, and the shove that clears space for it. */
const RESPAWN_INVULN = 1700;
const RESPAWN_SHOVE = 520;

/** Painted when the tilesheet has not arrived, so the stage never goes blank. */
const BACKDROP_BOTTOM = GROUND_TOP;

/** Stable key the impact sprite is filed under in the `images` map. */
export const SPARK_KEY = "spark";

// ── Resources ────────────────────────────────────────────────────────────────

/** Meter a cast spends — half a bar, so a run holds several casts. */
export const MAGIC_COST = 50;

/** Meter ceiling. */
export const MAGIC_MAX = 100;

/** Lives on a fresh run. */
export const MAX_LIVES = 3;

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * `intro` and `walking` are the between-wave beats; `fighting` is the only one
 * that runs AI or resolves hits. `down` is the pause after a death, and
 * `victory` / `gameOver` are terminal — the React overlay takes over there.
 */
export type Phase =
  | "intro"
  | "walking"
  | "fighting"
  | "waveClear"
  | "down"
  | "gameOver"
  | "victory";

export type Banner = { title: string; subtitle: string } | null;

/**
 * What the cabinet wants this frame.
 *
 * Movement is held; the two buttons are *buffers* the engine drains when the
 * player is next able to act, which is what makes a press during recovery come
 * out on the first legal frame instead of being dropped.
 */
export type PlayerInput = {
  left: boolean;
  right: boolean;
  /** Into the plane — a smaller `z`, further from the camera. */
  up: boolean;
  /** Out of the plane — a larger `z`, nearer the camera. */
  down: boolean;
  attackBuf: number;
  magicBuf: number;
};

export const emptyInput = (): PlayerInput => ({
  left: false,
  right: false,
  up: false,
  down: false,
  attackBuf: 0,
  magicBuf: 0,
});

type AiState = {
  /** Milliseconds until the next decision. */
  timer: number;
  /** Held direction along `x`, -1 | 0 | 1. */
  dx: -1 | 0 | 1;
  /** Held direction along `z`, -1 | 0 | 1. */
  dz: -1 | 0 | 1;
  /**
   * Milliseconds until this enemy may use its `special` again.
   *
   * Separate from `timer` because the two answer different questions:
   * `timer` is "when may I decide something", this is "when may I use *that*".
   * Rolling both together is what turns a strong special into a one-button
   * monster at Expert, where `reactionMs` is 150.
   */
  specialCooldown: number;
};

/**
 * One actor on the plane.
 *
 * `moves` is string-keyed rather than a discriminated union because players
 * (`combo1..combo3`, `magic`) and enemies (`jab`, `heavy`) share every piece of
 * behaviour — timing, hitstun, knockback, animation — and splitting them would
 * mean writing all of it twice. What differs is which keys exist, and that is
 * decided once, at construction.
 */
export type ActorRT = {
  id: number;
  side: "player" | "enemy";
  /** Key into the `sheets` map. The boss has none and draws from its strip. */
  sheetKey: string;
  name: string;
  color: string;
  tier: "player" | "grunt" | "heavy" | "boss";
  x: number;
  /** Depth: 0 is the far edge of the plane, `Z_MAX` the near one. */
  z: number;
  dir: 1 | -1;
  hp: number;
  maxHp: number;
  action: "free" | "attack" | "hurt" | "ko";
  moving: boolean;
  anim: string;
  animElapsed: number;
  moveKind: string | null;
  moveElapsed: number;
  /** Set on the frame the hit resolves, so one swing cannot hit twice. */
  moveConnected: boolean;
  /** Milliseconds left in hitstun. Only meaningful while `hurt`. */
  hurtTimer: number;
  /** Milliseconds of invulnerability left. */
  invulnMs: number;
  /** Milliseconds of death animation left. Only meaningful while `ko`. */
  koTimer: number;
  /** Knockback still to bleed off, stage px/s along `x`. */
  knockV: number;
  /** Knockback along `z`, stage px/s. */
  knockZ: number;
  hitFlash: number;
  /** How long the spawn fade has left. */
  spawnMs: number;
  walkSpeed: number;
  scale: number;
  /** Collision radius along `x`. */
  rx: number;
  /** Collision radius along `z`. */
  rz: number;
  /**
   * String-keyed so players (`combo1..3`, `magic`) and enemies (`jab`,
   * `heavy`, `special`) share every piece of behaviour — timing, hitstun,
   * knockback, animation — and splitting them would mean writing all of it
   * twice. What differs is which keys exist.
   *
   * Only the *move keys* are in here; an enemy's `specialAt` rule and
   * `specialCooldownMs` live beside them on `EnemySpec`, because they describe
   * when the AI may spend the move rather than what the move does. Folding them
   * into this record would mean every read is a type assertion, because they are
   * not `MoveSpec`s.
   */
  moves: Readonly<Record<string, MoveSpec>>;
  /** Player: which swing a press inside the window would play. 0..2. */
  nextCombo: number;
  /** Player: ms left in the combo window. */
  comboWindow: number;
  /** Enemy: ms since the last swing ended — drives the reposition roll. */
  postSwing: number;
  /** Score this actor is worth. 0 for the player. */
  score: number;
  /**
   * Which enemy this is, for the drop roll on death. `null` for the player.
   *
   * Carried on the actor rather than looked up by position because there is no
   * other way back from an `ActorRT` to its spec — actor ids are a monotonic
   * counter, not `EnemyId`s.
   */
  enemyId: EnemyId | null;
  /**
   * Between-wave ambusher rather than a wave member.
   *
   * Spawned only during a `walking` phase, and that is the whole of what it
   * changes: an ambush must be cleared before the walk's wave can open, but its
   * kills count for nothing and it does not draw on the wave's roster.
   */
  isRoam: boolean;
  ai: AiState | null;
};

type Spark = {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  size: number;
};

/**
 * A floating label above a drop: what it was and what it did.
 *
 * Picked-ups are the one event in this game the player cannot infer from the
 * HUD alone — the bar jumps, but *why* it jumped and what was just spent is not
 * visible. These say it in the game's own voice rather than leaving the player
 * to work it out from a number changing.
 */
type FloatText = {
  text: string;
  x: number;
  z: number;
  life: number;
  maxLife: number;
  color: string;
};

export type HudSnapshot = {
  phase: Phase;
  banner: Banner;
  score: number;
  lives: number;
  hp: number;
  maxHp: number;
  /** 0–100. */
  magic: number;
  /**
   * 1-based wave the player is on.
   *
   * Counts past `waveCount` in endless, so it keeps climbing — that number is
   * the player's score of how deep they got.
   */
  wave: number;
  /** Waves in the finite run. 15. */
  waveCount: number;
  /** Wave name, prefixed with the loop number once endless. */
  waveName: string;
  /** True once the finite run is cleared and the loop has begun. */
  endless: boolean;
  enemiesLeft: number;
  /**
   * Live ambushers on the street. Separate from `enemiesLeft` because they are
   * not the wave: an ambush delays the wave without being part of it.
   */
  roamers: number;
  /** Populated only while a boss is alive. */
  boss: { name: string; hp: number; maxHp: number; color: string } | null;
  /** Set once the run is over. */
  result: "victory" | "defeat" | null;
  /**
   * True once wave 15 is cleared — the point the run is *complete*, whether or
   * not the player goes on into endless.
   *
   * This is what a reward pays on, and it is deliberately not `result`: a player
   * who clears wave 15 and dies on wave 19 has still completed the run, so
   * keying the payout off a terminal state would take the coin away for playing
   * well. Lives are this game's currency, not the ending.
   */
  reachedFinale: boolean;
  /**
   * Highest wave reached, for the game-over panel. Survives a loss so a defeat
   * can say how far the run got.
   */
  bestWave: number;
};

export type MatchState = {
  phase: Phase;
  phaseTimer: number;
  banner: Banner;
  /** Milliseconds the current banner has left. 0 means it is not timed. */
  bannerTimer: number;
  /** Wave being fought, or about to be fought. */
  waveIndex: number;
  player: ActorRT;
  enemies: ActorRT[];
  sparks: Spark[];
  /** Drops on the floor. Collected by walking onto their line. */
  pickups: Pickup[];
  floaters: FloatText[];
  /** Drives every pickup's bob from one clock rather than N timers. */
  worldMs: number;
  /**
   * Progress along the current walk, 0–1, and how many ambushes it has had.
   *
   * `walkFrom` is where the player stood when the walk began and `walkSpan` how
   * far it runs, so the fractions in `roamPoints` mean the same thing on a
   * third-of-a-screen opening walk as on a full one.
   */
  walkFrom: number;
  walkSpan: number;
  roamFired: number;
  /** Ambushers on the street right now. Waves never put anything here. */
  roaming: number;
  /** Counts up whenever anything on the HUD changes. */
  hudVersion: number;
  hitstop: number;
  shake: number;
  shakeMag: number;
  /** Magic flash, milliseconds left. */
  flash: number;
  flashMax: number;
  camX: number;
  lives: number;
  magic: number;
  score: number;
  /** `round(magic)` as last published — bumps `hudVersion` when it flips. */
  shownMagicPct: number;
  /**
   * Set once the run is over.
   *
   * `"victory"` is now unreachable from a wave clear — `finishWave` leads into
   * endless instead of an ending — so in practice this is `"defeat"` or `null`.
   * It stays in the type rather than being narrowed because a future "quit and
   * bank it" path wants somewhere to land, and because narrowing it would mean
   * editing the React overlay for no gain.
   */
  result: "victory" | "defeat" | null;
  /**
   * Set the instant wave 15 is cleared, and **not** cleared afterwards.
   *
   * Latched rather than derived, because a player who clears the finale and
   * then dies on wave 19 has still completed the run — and a run that paid out
   * only if the player stopped in time would be paying for caution.
   */
  reachedFinale: boolean;
  /** Highest 1-based wave reached, for the game-over panel. */
  bestWave: number;
  difficulty: SunflowerBrawlerDifficulty;
  playerInput: PlayerInput;
  nextId: number;
  /** Meter gained per point of damage the player deals. */
  magicPerDamage: number;
  /** Meter gained per enemy the player kills. */
  magicPerKill: number;
};

// ── Small helpers ────────────────────────────────────────────────────────────

const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

const sign = (value: number): -1 | 0 | 1 =>
  value > 0 ? 1 : value < 0 ? -1 : 0;

/** Alive and not downed — the only actors anything should target. */
const isLive = (a: ActorRT): boolean => a.action !== "ko";

const cycleLength = (anim: string): number => ANIM_FRAMES[anim] ?? 1;

const loopFrame = (anim: string, fps: number, elapsed: number): number =>
  Math.floor((elapsed / 1000) * fps) % Math.max(1, cycleLength(anim));

const clampFrame = (anim: string, fps: number, elapsed: number): number =>
  Math.min(cycleLength(anim) - 1, Math.floor((elapsed / 1000) * fps));

const drain = (input: PlayerInput, key: "attackBuf" | "magicBuf"): boolean => {
  if (input[key] <= 0) return false;
  input[key] = 0;
  return true;
};

/** The sheet frame to draw, derived from action + elapsed. */
const frameOf = (a: ActorRT): number => {
  switch (a.action) {
    case "attack": {
      if (!a.moveKind) return 0;
      const move = a.moves[a.moveKind];
      if (!move) return 0;
      const raw = move.from + Math.floor((a.moveElapsed / 1000) * move.fps);
      return clamp(raw, move.from, move.to);
    }
    case "hurt":
      return clampFrame("hurt", 16, a.animElapsed);
    case "ko":
      return clampFrame("death", 12, a.animElapsed);
    default:
      return loopFrame(a.anim, a.moving ? 15 : 10, a.animElapsed);
  }
};

/** Which cycle the actor is on, derived from its action. */
const syncAnim = (a: ActorRT): void => {
  const next =
    a.action === "attack" && a.moveKind
      ? (a.moves[a.moveKind]?.anim ?? "idle")
      : a.action === "hurt"
        ? "hurt"
        : a.action === "ko"
          ? "death"
          : a.moving
            ? "walking"
            : "idle";

  if (next !== a.anim) {
    a.anim = next;
    a.animElapsed = 0;
  }
};

// ── Facing ───────────────────────────────────────────────────────────────────

/** The nearest live enemy, measuring `x` and `z` together. */
const nearestEnemy = (match: MatchState, from: ActorRT): ActorRT | null => {
  let best: ActorRT | null = null;
  let bestDistance = Infinity;
  for (const enemy of match.enemies) {
    if (!isLive(enemy)) continue;
    const distance =
      Math.abs(enemy.x - from.x) + Math.abs(enemy.z - from.z) * 1.4;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = enemy;
    }
  }
  return best;
};

/** Turn to face the threat. Used when idle and whenever a swing starts. */
const faceNearest = (match: MatchState, a: ActorRT): void => {
  const foe = nearestEnemy(match, a);
  if (foe) a.dir = foe.x >= a.x ? 1 : -1;
};

// ── Construction ─────────────────────────────────────────────────────────────

const makePlayer = (fighterId: FighterId): ActorRT => {
  const spec = getFighter(fighterId);
  return {
    id: 1,
    side: "player",
    sheetKey: spec.npc,
    name: spec.name,
    color: spec.color,
    tier: "player",
    x: 168,
    z: Z_MAX * 0.5,
    dir: 1,
    hp: spec.maxHp,
    maxHp: spec.maxHp,
    action: "free",
    moving: false,
    anim: "idle",
    animElapsed: 0,
    moveKind: null,
    moveElapsed: 0,
    moveConnected: false,
    hurtTimer: 0,
    invulnMs: 0,
    koTimer: 0,
    knockV: 0,
    knockZ: 0,
    hitFlash: 0,
    spawnMs: 0,
    walkSpeed: spec.walkSpeed,
    scale: SPRITE_SCALE,
    rx: 17,
    rz: 14,
    moves: spec.moves,
    nextCombo: 0,
    comboWindow: 0,
    postSwing: 0,
    score: 0,
    enemyId: null,
    isRoam: false,
    ai: null,
  };
};

const makeEnemy = (
  match: MatchState,
  spec: EnemySpec,
  x: number,
  z: number,
  dir: 1 | -1,
  isRoam = false,
): ActorRT => {
  const maxHp = Math.max(
    1,
    Math.round(
      spec.maxHp *
        waveHpMultiplier(match.waveIndex, match.difficulty.hpMultiplier) *
        (isRoam ? ROAM_HP_SCALE : 1),
    ),
  );
  // Already walking in, so a spawn at the screen edge does not stand there for
  // a beat waiting for its first decision tick.
  const entering = sign(match.player.x - x);

  return {
    id: ++match.nextId,
    side: "enemy",
    sheetKey: spec.npc ?? spec.id,
    name: spec.name,
    color: spec.color,
    tier: spec.tier,
    x,
    z,
    dir,
    hp: maxHp,
    maxHp,
    action: "free",
    moving: false,
    anim: "idle",
    animElapsed: 0,
    moveKind: null,
    moveElapsed: 0,
    moveConnected: false,
    hurtTimer: 0,
    invulnMs: 0,
    koTimer: 0,
    knockV: 0,
    knockZ: 0,
    hitFlash: 0,
    spawnMs: SPAWN_MS,
    walkSpeed: spec.walkSpeed,
    scale: spec.scale,
    rx: spec.rx,
    rz: spec.rz,
    // Only the `MoveSpec` entries are copied across. `EnemyMoves` also carries
    // `specialAt` and `specialCooldownMs`, which are *rules about* the move
    // rather than moves; the AI reads those off the spec through `enemyId`.
    // Spreading them into this string-keyed record would break its type and
    // duplicate state the actor already points back to.
    moves: {
      jab: spec.moves.jab,
      heavy: spec.moves.heavy,
      ...(spec.moves.special ? { special: spec.moves.special } : {}),
    },
    nextCombo: 0,
    comboWindow: 0,
    postSwing: 0,
    score: spec.score,
    enemyId: spec.id,
    isRoam,
    ai: {
      timer: 90 + Math.random() * 200,
      dx: entering,
      dz: 0,
      // Staggered so a wave's specials do not all come off cooldown on the
      // same tick, which would look like a synchronised attack rather than a
      // crowd.
      specialCooldown: 400 + Math.random() * 900,
    },
  };
};

/** Open a run. `playerId` is chosen in the lobby. */
export const createMatch = ({
  playerId,
  difficulty,
  input,
}: {
  playerId: FighterId;
  difficulty: SunflowerBrawlerDifficulty;
  input: PlayerInput;
}): MatchState => {
  const spec = getFighter(playerId);

  return {
    phase: "intro",
    phaseTimer: INTRO_MS,
    banner: { title: "SUNFLOWER BRAWLER", subtitle: "FIVE WAVES · THREE LIVES" },
    bannerTimer: INTRO_MS,
    waveIndex: 0,
    player: makePlayer(playerId),
    // The opening walk runs from the player's start to the wave-1 gate, and is
    // too short to ambush (`roamPoints` returns none below a screen and a
    // fifth) — so this is just a value that will never be read, seeded sanely.
    walkFrom: 0,
    walkSpan: 1,
    roamFired: 0,
    roaming: 0,
    enemies: [],
    sparks: [],
    pickups: [],
    floaters: [],
    worldMs: 0,
    hudVersion: 1,
    hitstop: 0,
    shake: 0,
    shakeMag: 0,
    flash: 0,
    flashMax: 1,
    camX: 0,
    lives: MAX_LIVES,
    magic: 0,
    score: 0,
    shownMagicPct: 0,
    result: null,
    reachedFinale: false,
    bestWave: 1,
    difficulty,
    playerInput: input,
    nextId: 1,
    magicPerDamage: spec.magicPerDamage,
    magicPerKill: spec.magicPerKill,
  };
};

// ── Boxes ────────────────────────────────────────────────────────────────────

/**
 * Does a swing on `a`'s line reach `v`?
 *
 * The hitbox is a rectangle along `x` — from ten pixels behind the attacker to
 * `reach` in front — crossed with a *band* along `z` of `zReach`. There is no
 * vertical test at all: everybody stands on the same floor, so depth is the
 * only axis left to miss on.
 */
const swingConnects = (a: ActorRT, v: ActorRT, move: MoveSpec): boolean => {
  if (Math.abs(a.z - v.z) > moveZReach(move)) return false;

  const far = a.x + a.dir * move.reach;
  const near = a.x - a.dir * 10;
  const left = Math.min(far, near);
  const right = Math.max(far, near);

  return left < v.x + v.rx && right > v.x - v.rx;
};

// ── Actions ──────────────────────────────────────────────────────────────────

/** The only state a new action may start from. */
const canAct = (a: ActorRT): boolean => a.action === "free";

const startMove = (a: ActorRT, kind: string): void => {
  a.action = "attack";
  a.moveKind = kind;
  a.moveElapsed = 0;
  a.moveConnected = false;
  a.animElapsed = 0;
  // Cleared so that when the move ends, `syncAnim` settles on `idle` for the
  // one frame before the owner re-derives movement from its own input.
  a.moving = false;
  syncAnim(a);
};

/**
 * Play the next swing of the string.
 *
 * Inside the window this reads `nextCombo`; outside it the string has already
 * reset itself, so a press that arrives 650 ms late starts over rather than
 * jumping to the finisher.
 */
const startString = (match: MatchState): void => {
  const player = match.player;
  const stage = player.comboWindow > 0 ? player.nextCombo : 0;

  faceNearest(match, player);
  startMove(player, COMBO[stage] ?? "combo1");
  player.nextCombo = (stage + 1) % COMBO.length;
};

// ── Hits ─────────────────────────────────────────────────────────────────────

const applyHit = (
  match: MatchState,
  attacker: ActorRT,
  victim: ActorRT,
  move: MoveSpec,
  at: { x: number; y: number },
): void => {
  if (victim.action === "ko" || victim.invulnMs > 0) return;

  victim.hp = Math.max(0, victim.hp - move.damage);
  victim.action = "hurt";
  victim.animElapsed = 0;
  victim.moveKind = null;
  victim.moveConnected = false;
  victim.moving = false;
  victim.hurtTimer = move.hitstunMs;
  // The i-frames are the *real* anti-combo rule. Without them a crowd could
  // hold one actor in hitstun indefinitely; with them every hit is followed by
  // a window in which the victim is free but untouchable — long enough to step
  // off the line, short enough not to be a free turn.
  victim.invulnMs = victim.hurtTimer + HIT_INVULN_PAD;
  victim.postSwing = 0;
  victim.knockV = attacker.dir * move.knockback;

  // Thrown *away* from the attacker's own line, so a connected hit scatters
  // the crowd rather than sliding it sideways along one depth.
  const delta = victim.z - attacker.z;
  const zDir = delta === 0 ? (Math.random() < 0.5 ? -1 : 1) : sign(delta);
  victim.knockZ = zDir * move.knockZ;

  syncAnim(victim);

  const heavy = move.damage >= 14;
  match.hitstop = Math.max(match.hitstop, heavy ? HITSTOP_HEAVY : HITSTOP_LIGHT);
  match.shake = Math.max(match.shake, heavy ? 130 : 90);
  match.shakeMag = heavy ? SHAKE_HEAVY : SHAKE_LIGHT;
  attacker.hitFlash = 90;
  match.sparks.push({
    x: at.x,
    y: at.y,
    life: 260,
    maxLife: 260,
    size: heavy ? 34 : 24,
  });

  if (attacker.side === "player") {
    match.magic = clamp(
      match.magic + move.damage * match.magicPerDamage,
      0,
      MAGIC_MAX,
    );
  }

  match.hudVersion++;

  if (victim.hp <= 0) killActor(match, victim, attacker);
};

/**
 * Roll a drop for a kill the player made.
 *
 * Only ever called for a player kill — the drop is the player's reward, so a
 * wave that clears itself gets nothing.
 *
 * Position is the corpse's, clamped in off the plane's edges: a heavy killed
 * with its back against `z = 0` would otherwise leave a drop sitting where the
 * player cannot stand to collect it.
 */
const maybeDrop = (match: MatchState, victim: ActorRT): void => {
  if (!victim.enemyId) return;

  const spec = getEnemySpec(victim.enemyId);
  if (Math.random() >= spec.dropChance) return;

  const kind = rollPickup({
    hpPct: match.player.hp / match.player.maxHp,
    magicPct: match.magic / MAGIC_MAX,
    random: Math.random,
  });
  if (!kind) return;

  match.pickups.push({
    kind,
    x: victim.x,
    z: clamp(victim.z, 12, Z_MAX - 12),
    bobPhase: Math.random() * 1100,
  });
};

const killActor = (
  match: MatchState,
  victim: ActorRT,
  attacker: ActorRT,
): void => {
  victim.action = "ko";
  victim.hurtTimer = 0;
  victim.koTimer = DEATH_MS;
  victim.animElapsed = 0;
  victim.moveKind = null;
  victim.moving = false;
  victim.knockZ = 0;
  syncAnim(victim);

  if (victim.side === "enemy") {
    match.score += victim.score;
    if (attacker.side === "player") {
      match.magic = clamp(match.magic + match.magicPerKill, 0, MAGIC_MAX);
      maybeDrop(match, victim);
    }
    match.hudVersion++;
    return;
  }

  // ── The player dropped ────────────────────────────────────────────────────
  match.lives = Math.max(0, match.lives - 1);
  match.phase = "down";
  match.phaseTimer = DOWN_MS;
  match.bannerTimer = DOWN_MS;
  match.banner =
    match.lives > 0
      ? {
          title: "YOU DROPPED",
          subtitle: `${match.lives} ${match.lives === 1 ? "LIFE" : "LIVES"} LEFT`,
        }
      : { title: "GAME OVER", subtitle: `SCORE ${match.score}` };
  match.hudVersion++;
};

/**
 * Resolve a swing that is inside its active window.
 *
 * Called once per actor per frame, *after* timers have advanced. The move-end
 * guard in `advanceTimers` guarantees a move never finishes before
 * `impact + ACTIVE_MS`, so a finisher whose impact sits late in its cycle still
 * lands instead of being cut off by its own recovery.
 */
const stepAttack = (match: MatchState, attacker: ActorRT): void => {
  if (attacker.action !== "attack" || !attacker.moveKind) return;
  if (attacker.moveConnected) return;

  const move = attacker.moves[attacker.moveKind];
  if (!move) return;

  const impactAt = moveImpactMs(move);
  if (
    attacker.moveElapsed < impactAt ||
    attacker.moveElapsed > impactAt + ACTIVE_MS
  ) {
    return;
  }

  attacker.moveConnected = true;

  // Magic: the one thing in the game that ignores the depth axis. It resolves
  // against every living enemy on screen, which is the whole point of saving
  // the meter for the moment you are surrounded.
  if (move.screen) {
    for (const enemy of match.enemies) {
      if (!isLive(enemy)) continue;
      applyHit(match, attacker, enemy, move, {
        x: enemy.x,
        y: zToY(enemy.z) - BODY_H / 2,
      });
    }
    match.flash = 420;
    match.flashMax = 420;
    match.shake = Math.max(match.shake, 200);
    match.shakeMag = 12;
    return;
  }

  const targets = attacker.side === "player" ? match.enemies : [match.player];
  for (const victim of targets) {
    if (!isLive(victim)) continue;
    if (!swingConnects(attacker, victim, move)) continue;
    applyHit(match, attacker, victim, move, {
      x: victim.x,
      y: zToY(victim.z) - BODY_H / 2,
    });
  }
};

// ── Per-frame actor update ───────────────────────────────────────────────────

const advanceTimers = (a: ActorRT, dtMs: number): void => {
  a.animElapsed += dtMs;
  a.hitFlash = Math.max(0, a.hitFlash - dtMs);
  a.invulnMs = Math.max(0, a.invulnMs - dtMs);
  a.spawnMs = Math.max(0, a.spawnMs - dtMs);
  a.comboWindow = Math.max(0, a.comboWindow - dtMs);
  a.postSwing = Math.max(0, a.postSwing - dtMs);
  if (a.ai) a.ai.specialCooldown = Math.max(0, a.ai.specialCooldown - dtMs);

  // The window closing is what resets the string, and it has to be tested
  // before the move-end branch below, which may set a fresh one.
  if (a.comboWindow === 0) a.nextCombo = 0;

  if (a.action === "ko") {
    a.koTimer -= dtMs;
    return;
  }

  if (a.action === "attack" && a.moveKind) {
    const finished = a.moveKind;
    a.moveElapsed += dtMs;
    const move = a.moves[finished];
    if (move) {
      // Never end before the hit has had its chance to resolve.
      const earliest = Math.max(
        moveDurationMs(move),
        moveImpactMs(move) + ACTIVE_MS + 1,
      );
      if (a.moveElapsed < earliest) return;
    }

    a.action = "free";
    a.moveKind = null;
    a.moveElapsed = 0;
    if (a.side === "player" && COMBO.includes(finished as never)) {
      a.comboWindow = COMBO_WINDOW_MS;
    } else {
      a.postSwing = 420;
    }
    syncAnim(a);
    return;
  }

  if (a.action === "hurt") {
    a.hurtTimer -= dtMs;
    if (a.hurtTimer <= 0) {
      a.hurtTimer = 0;
      a.action = "free";
      syncAnim(a);
    }
  }
};

const clampActor = (a: ActorRT, match: MatchState): void => {
  a.z = clamp(a.z, 0, Z_MAX);

  if (a.side === "player") {
    // The camera *is* the wall: the screen edges are the player's bounds,
    // which is what turns a locked camera into an arena.
    a.x = clamp(a.x, match.camX + WALL_X, match.camX + STAGE_W - WALL_X);
    return;
  }

  a.x = clamp(a.x, match.camX - ARENA_PAD, match.camX + STAGE_W + ARENA_PAD);
};

/** Carry a lunging move forward through the frames that sell the lunge. */
const stepAdvance = (a: ActorRT, match: MatchState, dt: number): void => {
  if (a.action !== "attack" || !a.moveKind) return;
  const move = a.moves[a.moveKind];
  if (!move || move.advance <= 0) return;

  const total = moveDurationMs(move);
  if (a.moveElapsed < total * 0.3 || a.moveElapsed > total * 0.9) return;

  a.x += a.dir * move.advance * dt;
  clampActor(a, match);
};

const stepPhysics = (a: ActorRT, match: MatchState, dt: number): void => {
  // Knockback bleeds off exponentially: a shove that stops dead reads as a
  // teleport, and one that decays linearly reads as ice.
  if (a.knockV !== 0) {
    a.x += a.knockV * dt;
    a.knockV *= Math.exp(-6 * dt);
    if (Math.abs(a.knockV) < 4) a.knockV = 0;
  }

  if (a.knockZ !== 0) {
    a.z += a.knockZ * dt;
    a.knockZ *= Math.exp(-6 * dt);
    if (Math.abs(a.knockZ) < 4) a.knockZ = 0;
  }

  clampActor(a, match);
};

// ── Body collision ───────────────────────────────────────────────────────────

/**
 * Push two overlapping actors apart along whichever axis is *least* embedded.
 *
 * Depth makes this a 2-D problem rather than the 1-D shove the fighting game
 * needed: two actors can share an `x` perfectly well if they are on different
 * lines, so separating on `x` unconditionally would make the plane feel like a
 * wall you cannot walk around. If the `z` push would land either actor against
 * the edge of the plane it falls back to `x`, so nobody is ever trapped.
 */
const separatePair = (a: ActorRT, b: ActorRT): void => {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const sepX = a.rx + b.rx;
  const sepZ = a.rz + b.rz;
  const penX = sepX - Math.abs(dx);
  const penZ = sepZ - Math.abs(dz);
  if (penX <= 0 || penZ <= 0) return;

  if (penZ / sepZ < penX / sepX) {
    const dir = dz === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dz);
    const half = penZ / 2;
    const az = clamp(a.z - dir * half, 0, Z_MAX);
    const bz = clamp(b.z + dir * half, 0, Z_MAX);
    if (Math.abs(az - a.z) + Math.abs(bz - b.z) >= penZ * 0.9) {
      a.z = az;
      b.z = bz;
      return;
    }
    // Clamped against the edge of the plane — push along `x` instead.
  }

  const dir = dx === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dx);
  const half = penX / 2;
  a.x -= dir * half;
  b.x += dir * half;
};

const separateAll = (match: MatchState): void => {
  const player = match.player;

  for (const enemy of match.enemies) {
    if (!isLive(enemy)) continue;
    separatePair(player, enemy);
  }

  for (let i = 0; i < match.enemies.length; i++) {
    const a = match.enemies[i];
    if (!isLive(a)) continue;
    for (let j = i + 1; j < match.enemies.length; j++) {
      const b = match.enemies[j];
      if (!isLive(b)) continue;
      separatePair(a, b);
    }
  }

  clampActor(player, match);
  for (const enemy of match.enemies) clampActor(enemy, match);
};

// ── Player ───────────────────────────────────────────────────────────────────

const stepPlayer = (match: MatchState, dt: number): void => {
  const player = match.player;
  const input = match.playerInput;

  if (!canAct(player)) return;

  if (drain(input, "attackBuf")) {
    startString(match);
    return;
  }

  // Readiness is tested *before* the drain, so a press made on a nearly empty
  // meter stays armed for the length of the buffer instead of being swallowed
  // by an unaffordable cast.
  if (match.magic >= MAGIC_COST && drain(input, "magicBuf")) {
    match.magic -= MAGIC_COST;
    faceNearest(match, player);
    startMove(player, "magic");
    match.hudVersion++;
    return;
  }

  const dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  const dz = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  const length = Math.hypot(dx, dz);

  player.moving = length > 0;
  if (length > 0) {
    // Normalised, so holding a diagonal is not 1.41× the speed of a straight
    // line — otherwise the fastest way across the plane would always be the
    // one that never lets you see what you are walking into.
    player.x += (dx / length) * player.walkSpeed * dt;
    player.z += (dz / length) * player.walkSpeed * dt;
  }

  if (player.moving && dx !== 0) player.dir = dx > 0 ? 1 : -1;
  else faceNearest(match, player);

  clampActor(player, match);
  syncAnim(player);
};

// ── Enemies ──────────────────────────────────────────────────────────────────

/** How many enemies are mid-swing right now. */
const countSwinging = (match: MatchState): number => {
  let count = 0;
  for (const enemy of match.enemies) if (enemy.action === "attack") count++;
  return count;
};

/**
 * One enemy decision.
 *
 * The **tick**, not the choice list, is the difficulty lever. Everything here
 * is a roll against a parameter today's difficulty sets, so "hard" never means
 * the AI cheats at the physics: it re-rolls more often, commits more often, and
 * commits to the heavy instead of the jab more often.
 *
 * The branch order matters. Committing is tested first so an enemy already in
 * range never walks *past* you to reposition; repositioning is tested before
 * approaching so a wave that has just been hit gets a beat to breathe; and the
 * approach itself stops at `jab.reach` rather than walking into the separation
 * radius, so an enemy waiting for an opening holds its ground instead of
 * grinding against you frame after frame.
 */
const stepEnemyAi = (match: MatchState, enemy: ActorRT, dtMs: number): void => {
  const ai = enemy.ai;
  if (!ai) return;

  if (enemy.action !== "free") {
    ai.dx = 0;
    ai.dz = 0;
    return;
  }

  ai.timer -= dtMs;
  if (ai.timer > 0) return;

  const diff = match.difficulty;
  const player = match.player;

  ai.dx = 0;
  ai.dz = 0;

  const dx = player.x - enemy.x;
  const dz = player.z - enemy.z;
  const adx = Math.abs(dx);
  const adz = Math.abs(dz);
  const jab = enemy.moves.jab;
  if (!jab) return;
  const zReach = moveZReach(jab);

  // ── 1. The special, if this enemy has one and it is worth spending ───────
  //
  // Tested *before* the ordinary commit so a lunge or a sweep can be the answer
  // to a gap rather than something that only happens if the player walks into a
  // poke. The gate is the enemy's own `specialAt` rule rather than a distance:
  //
  // * `far`     — outside the jab's reach, so the special is how it closes.
  // * `close`   — inside, where a long reach or a big grab is the point.
  // * `inRange` — either, when the move is good from most of its band.
  //
  // Plus the swing budget, because a special that ignores `maxAttackers` is
  // exactly the one-button monster the cooldown exists to prevent.
  const special = enemy.moves.special;
  // The rule and the cooldown come off the *spec*, not the actor's move record:
  // `EnemyMoves` holds them beside the moves, and only the `MoveSpec` entries
  // were copied onto the actor. One lookup through `enemyId` rather than
  // threading two more fields onto every actor.
  const rule = enemy.enemyId
    ? getEnemySpec(enemy.enemyId).moves.specialAt
    : undefined;
  const cooldownMs = enemy.enemyId
    ? getEnemySpec(enemy.enemyId).moves.specialCooldownMs
    : undefined;

  if (special && isLive(player) && ai.specialCooldown <= 0) {
    const at = rule ?? "inRange";
    const inBand =
      at === "far"
        ? adx > jab.reach
        : at === "close"
          ? adx <= jab.reach
          : adx <= special.reach;
    const onLine = adz <= moveZReach(special) * 1.2;

    if (
      inBand &&
      onLine &&
      countSwinging(match) < diff.maxAttackers &&
      Math.random() < diff.aggression
    ) {
      startMove(enemy, "special");
      ai.specialCooldown = cooldownMs ?? 4000;
      ai.timer = diff.reactionMs * (0.7 + Math.random() * 0.6);
      return;
    }
  }

  // 2. In range, the swing budget allows it, and the aggression roll passed.
  if (isLive(player) && adx <= jab.reach && adz <= zReach) {
    if (
      countSwinging(match) < diff.maxAttackers &&
      Math.random() < diff.aggression
    ) {
      const heavy = enemy.moves.heavy;
      const pick = heavy && Math.random() < diff.heavyChance ? "heavy" : "jab";
      startMove(enemy, pick);
      ai.timer = diff.reactionMs * (0.7 + Math.random() * 0.6);
      return;
    }
  }

  // 3. Just finished a swing: sometimes give ground rather than press on.
  if (enemy.postSwing > 0 && Math.random() < diff.spacingChance) {
    ai.dx = dx >= 0 ? -1 : 1;
    ai.dz = adz > 6 ? (dz >= 0 ? -1 : 1) : 0;
    ai.timer = diff.reactionMs * (0.8 + Math.random() * 0.7);
    return;
  }

  // 4. Close the line first, then the distance — and hold once in reach, so
  //    the roll in branch 2 gets another chance instead of a shove.
  const inReach = adx <= jab.reach;
  if (adz > zReach * 0.55) {
    ai.dz = dz > 0 ? 1 : -1;
    ai.dx = inReach ? 0 : dx > 0 ? 1 : -1;
  } else {
    ai.dz = 0;
    ai.dx = inReach ? 0 : dx > 0 ? 1 : -1;
  }

  ai.timer = diff.reactionMs * (0.65 + Math.random() * 0.7);
};

const stepEnemy = (match: MatchState, enemy: ActorRT, dtMs: number): void => {
  stepEnemyAi(match, enemy, dtMs);

  const ai = enemy.ai;
  if (!ai || enemy.action !== "free") {
    enemy.moving = false;
    return;
  }

  const length = Math.hypot(ai.dx, ai.dz);
  if (length > 0) {
    // Wave escalation rides on top of the difficulty band, so a wave is harder
    // than the setting says it should be. See `waveSpeedMultiplier`.
    const speed =
      enemy.walkSpeed * waveSpeedMultiplier(match.waveIndex, match.difficulty.speed);
    const dt = dtMs / 1000;
    enemy.x += (ai.dx / length) * speed * dt;
    enemy.z += (ai.dz / length) * speed * dt;
    enemy.moving = true;
  } else {
    enemy.moving = false;
  }

  enemy.dir = match.player.x >= enemy.x ? 1 : -1;
  clampActor(enemy, match);
  syncAnim(enemy);
};

// ── Waves ────────────────────────────────────────────────────────────────────

/**
 * Drop the boss onto the stage with an entrance, rather than mid-banner.
 *
 * The boss has always spawned at the screen's centre depth and walked in from
 * the right like everything else. On a plane this deep that reads as it
 * *arriving*, which undersells it — the one thing in the game that should be
 * already standing there when the banner clears.
 */
const GORGA_ENTRY_X = 240;

/**
 * Step out an ambush mid-walk.
 *
 * ## Why this exists
 *
 * The walk between waves is the one stretch of a run with nothing to do. It was
 * a held direction across empty screen — the genre's own answer to it is a
 * couple of enemies stepping out of a doorway, which costs a few seconds and
 * makes the street feel occupied.
 *
 * ## Two, and never a heavy
 *
 * One or two, both grunts. A pair is enough that the depth plane matters — one
 * on your line and one on another is a real decision — and few enough that an
 * ambush stays an interruption rather than a second wave. The roster is
 * filtered to `tier === "grunt"` so an ambush can never open with a Dreadhorn:
 * a heavy mid-walk, while the player is mid-stride and off-guard, is the fastest
 * way to make the walk feel unfair rather than eventful.
 *
 * ## Spawn placement
 *
 * The first steps out **ahead**, on a line offset from the player's, so it is
 * something to walk into. A second, if there is one, comes from **behind** —
 * the player is then walking away from something, which is the one moment the
 * screen edges stop being safe.
 *
 * Both are placed relative to the player rather than the camera so they stay
 * meaningful as the view scrolls under them.
 */
const startRoam = (match: MatchState): void => {
  const pool = roamPool(match.waveIndex);
  if (pool.length === 0) return;

  const count = ROAM_MIN + Math.floor(Math.random() * (ROAM_MAX - ROAM_MIN + 1));
  const player = match.player;

  for (let i = 0; i < count; i++) {
    const spec = getEnemySpec(pool[(i + match.roamFired) % pool.length]);
    const behind = i > 0;

    const x = behind ? player.x - ROAM_BEHIND_X : player.x + ROAM_AHEAD_X;
    // Alternating side of the player's own line, so the two never stack up on
    // one `z` and collapse into a single threat.
    const zSide = i % 2 === 0 ? 0.72 : 0.28;
    const z = clamp(Z_MAX * zSide + (i === 0 ? -18 : 18), 14, Z_MAX - 14);

    match.enemies.push(
      makeEnemy(match, spec, x, z, behind ? 1 : -1, true),
    );
  }

  // Burned even when the pool was empty, so a grunt-less walk does not re-roll
  // the trigger on every single frame until the player crosses the point.
  match.roamFired++;
  match.roaming = count;
  match.banner = { title: "AMBUSH", subtitle: count === 1 ? "SOMETHING MOVES" : "THEY BOXED YOU IN" };
  match.bannerTimer = ROAM_BANNER_MS;
  match.hudVersion++;
};

/**
 * Grunt ids an ambush may draw from, for the wave it walks into.
 *
 * **Derived from `WAVES[waveIndex]`, not a hand-written table** — and that is
 * the fix for a bug this shipped with. `ROAM_POOL` used to be its own list,
 * which was free to name an NPC that appeared in no wave's roster: the wave-3
 * entry offered `banshee`, whose sheet (`boneyard betty`) belongs to wave 4.
 * Nothing preloaded it during the walk to wave 3, so an ambush could open on an
 * actor whose sheets were still in flight — and an actor with no sheet draws as
 * `drawSheetActor`'s coloured-box fallback. In a wave of undead that is a purple
 * square standing in the street.
 *
 * Deriving it removes the class of bug rather than the instance: an ambush now
 * can only ever be made of enemies the wave itself is made of, so its art is by
 * construction already requested by the wave preload. The `grunt` filter still
 * applies, so a Dreadhorn can never ambush.
 *
 * Returns `[]` for a wave with no grunts in it (wave 5 is the boss alone), and
 * `startRoam` treats an empty pool as "no ambush on this walk".
 */
const roamPool = (waveIndex: number): readonly EnemyId[] => {
  const wave = getWaveSpec(waveIndex);
  if (!wave) return [];
  return wave.spawns
    .map((spawn) => spawn.id)
    .filter((id) => getEnemySpec(id).tier === "grunt");
};

/**
 * Arm the walk's ambushes.
 *
 * Called on **every** transition into `walking`, not only from `finishWave`.
 * The opening walk arrives via `stepPhase`'s `intro` branch instead, and
 * without this it would inherit `createMatch`'s placeholder `walkSpan` of 1 —
 * at which point every `roamPoints` fraction is already behind the player and
 * wave 1 gets ambushed before the intro banner has finished clearing.
 *
 * `walkSpan` runs from where the player is *now* to the point at which the
 * camera settles, so `roamPoints`' fractions mean the same thing whether the
 * last fight ended at the left of the screen or the right.
 *
 * The floor at a third of a screen stops a near-zero span dividing into an
 * ambush the instant a walk begins, and — because it is applied *after*
 * measuring — it is what gives the short opening walk a **single** ambush
 * point instead of two.
 *
 * That matters because `roamPoints` keys its second point off span length. The
 * opening walk runs about 310 px, so the floor pins `walkSpan` to 326 and
 * `roamPoints` returns one point at 0.55; every later walk is 850–1100 px and
 * gets two. Measured on a full run, the first encounter therefore lands at
 * progress 0.56 of a 326 px walk — one pair, roughly a second and a half
 * before wave 1's gate — and the rest land at 0.55 of a full-length walk. So a
 * run opens with a taste of the mechanic and then settles into a rhythm, rather
 * than the first ambush being indistinguishable from a wave.
 */
const armWalk = (match: MatchState): void => {
  match.walkFrom = match.player.x;
  match.walkSpan = Math.max(
    STAGE_W * 0.34,
    zoneCamX(match.waveIndex) + WAVE_ENTRY_X - match.player.x,
  );
  match.roamFired = 0;
  match.roaming = 0;
};

const startWave = (match: MatchState): void => {
  // Resolved, not indexed — past wave 15 this is a replay from the endless
  // loop rather than an array read that would run off the end.
  const wave = getWaveSpec(match.waveIndex);
  if (!wave) return;

  // Locked here and released by `finishWave`: during a wave the camera does
  // not move at all, which is what makes the screen an arena.
  match.camX = zoneCamX(match.waveIndex);
  match.phase = "fighting";
  match.banner =
    match.waveIndex < WAVE_COUNT
      ? { title: wave.name, subtitle: wave.subtitle }
      : endlessBanner(match.waveIndex);
  match.bannerTimer = WAVE_INTRO_MS;
  match.hudVersion++;

  let index = 0;
  for (const spawn of wave.spawns) {
    const spec = getEnemySpec(spawn.id);
    for (let i = 0; i < spawn.count; i++) {
      if (spec.tier === "boss") {
        // On screen already, facing the player, at the middle of the plane.
        // No spawn fade either — it is already there when the banner clears.
        const boss = makeEnemy(
          match,
          spec,
          match.camX + STAGE_W - GORGA_ENTRY_X,
          Z_MAX * 0.5,
          -1,
        );
        boss.spawnMs = 0;
        match.enemies.push(boss);
        index++;
        continue;
      }

      // One in three enters from the left so a wave is never a single file
      // column walking in from one edge.
      const fromLeft = index % 3 === 0;
      const x = fromLeft ? match.camX - 60 : match.camX + STAGE_W + 60;
      // Spread across the whole plane rather than a narrow band: with 210 px of
      // depth, a spawn column hugging `z ≈ 12` would arrive as a single-file
      // queue and the wave would read as thinner than it is.
      const z = 16 + ((index * 73 + match.waveIndex * 41) % (Z_MAX - 32));
      match.enemies.push(makeEnemy(match, spec, x, z, fromLeft ? 1 : -1));
      index++;
    }
  }

  match.hudVersion++;
};

/**
 * The banner that opens an endless wave.
 *
 * Distinct from a numbered wave's because the number means nothing there: wave
 * 23 is the third pass through the undead block. What matters is the loop
 * number and how much tougher it is than the last, so that is what the banner
 * says.
 */
const endlessBanner = (waveIndex: number): Banner => {
  const loop = endlessLoop(waveIndex) + 1;
  const spec = getWaveSpec(waveIndex);
  return {
    title: `ENDLESS ${loop}`,
    subtitle: `${spec.name} · ${Math.round(endlessHpScale(waveIndex) * 100)}% STRONGER`,
  };
};

const finishWave = (match: MatchState): void => {
  match.enemies = [];

  // Clearing wave 15 does not end the run. From here the player goes into
  // endless, which replays **every** wave — all three bosses included — on a
  // compounding loop until lives run out — so `endRun("victory")` is never
  // reached from a wave clear again.
  //
  // The reward is granted on the finite run reaching wave 15's end, not on a
  // terminal `victory` state, which is why `result` is deliberately left null
  // here. See `reachedFinale`.
  match.waveIndex++;
  match.phase = "walking";
  match.banner = null;
  match.bannerTimer = 0;

  armWalk(match);

  // Drops are **not** swept here any more. They used to be, because `finishWave`
  // runs during `waveClear` while the last corpse is still fading, so a drop from
  // the final enemy ended up sitting in the next zone's street at an off-camera
  // `x` — invisible, uncollectable, and cluttering the array forever.
  //
  // That is now handled by the rule the player actually asked for: a drop leaves
  // when it is collected or when the camera has walked past it. The camera pans
  // right through the walk, so by the time the next wave locks the frame those
  // drops are outside `PICKUP_DESPAWN_PAD` and retire themselves — which is the
  // honest version of the sweep, because it retires them when they actually
  // leave rather than at an arbitrary moment, and it leaves alone any drop the
  // player is still close enough to walk back for.

  // Health **carries over**. It used to be refilled to full here, on the
  // argument that the wave banner is the genre's pacing device and fifteen waves
  // would otherwise compound every mistake into an unwinnable run. The owner's
  // call is the opposite, and it is the better one: a full bar between waves made
  // the bar meaningless, because the only thing that ever moved it was the wave
  // you had just finished. Carrying it makes the health pickups worth walking for
  // and makes a long run a resource you manage rather than a series of resets —
  // which is what fifteen waves and then endless actually asks for.
  //
  // Lives remain the safety net, and they still refill on respawn (`respawn`), so
  // the difference between a bad wave and an ending is still lives.

  // Latched here, on the clearing of wave 15, rather than derived from
  // `waveIndex`. Both would read true from the same moment, but the latch also
  // stays true if the player later dies, which is the whole point: clearing the
  // finale is what completes a run, and continuing into endless afterwards must
  // not take that away.
  if (match.waveIndex >= WAVE_COUNT && !match.reachedFinale) {
    match.reachedFinale = true;
  }

  // The one moment in a run where the player is told they have finished it.
  //
  // A banner rather than an overlay, because the run does not end — it goes on.
  // Stopping the game here to congratulate someone would be the single most
  // disruptive thing this engine could do, and endless exists precisely so that
  // clearing wave 15 is a milestone rather than a wall.
  if (match.waveIndex === WAVE_COUNT) {
    // A one-off bonus for beating the run rather than for surviving it. The
    // endless loop pays out through ordinary wave clears from here on, so this
    // is the only thing that rewards clearing the finale *as a thing* — and it
    // keeps that worth chasing after the coin has already been paid, which is
    // what makes endless worth playing at all once you have the reward.
    match.score += FINALE_BONUS_SCORE;
    match.banner = {
      title: "STREET CLEARED",
      subtitle: "GORGA IS DOWN — HOW FAR WILL YOU GO?",
    };
    match.bannerTimer = 2600;
  }

  match.hudVersion++;
};

const endRun = (match: MatchState, result: "victory" | "defeat"): void => {
  match.result = result;
  match.phase = result === "victory" ? "victory" : "gameOver";
  match.banner = null;
  match.bannerTimer = 0;
  match.phaseTimer = 0;
  // Recorded so the game-over panel can say how deep the run got. A defeat on
  // wave 3 and a defeat on endless loop 2 are very different runs and the panel
  // should not treat them alike.
  match.bestWave = Math.max(match.bestWave, match.waveIndex + 1);
  match.hudVersion++;
};

const respawn = (match: MatchState): void => {
  const player = match.player;

  player.hp = player.maxHp;
  player.action = "free";
  player.moveKind = null;
  player.moveElapsed = 0;
  player.moveConnected = false;
  player.hurtTimer = 0;
  player.koTimer = 0;
  player.knockV = 0;
  player.knockZ = 0;
  player.comboWindow = 0;
  player.nextCombo = 0;
  player.moving = false;
  player.anim = "idle";
  player.animElapsed = 0;
  player.invulnMs = RESPAWN_INVULN;
  player.x = clamp(
    player.x,
    match.camX + 200,
    match.camX + STAGE_W - 200,
  );
  player.z = Z_MAX * 0.5;

  // Shove the crowd back. Without it the player reappears inside a ring of
  // enemies with their i-frames already half spent, and the second life is
  // strictly worse than the first.
  for (const enemy of match.enemies) {
    if (!isLive(enemy)) continue;
    const dx = enemy.x - player.x;
    const dz = enemy.z - player.z;
    if (Math.abs(dx) > 420 || Math.abs(dz) > 150) continue;
    enemy.knockV =
      (dx === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dx)) *
      RESPAWN_SHOVE;
    enemy.knockZ =
      (dz === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dz)) * 360;
  }

  // Back to whatever was happening, rather than straight to `fighting`.
  //
  // Dying to an ambush means dying during a `walking` phase, and resuming as
  // `fighting` would announce a wave that does not exist — with the roamer
  // still on the street and the wave counter reading zero enemies left. The
  // ambush simply continues; `stepPhase`'s walking branch picks it back up.
  match.phase = match.roaming > 0 ? "walking" : "fighting";
  match.banner = null;
  match.bannerTimer = 0;
  match.hudVersion++;
};

const stepPhase = (match: MatchState, dtMs: number): void => {
  switch (match.phase) {
    case "intro": {
      match.phaseTimer -= dtMs;
      if (match.phaseTimer <= 0) {
        match.phase = "walking";
        match.banner = null;
        match.bannerTimer = 0;
        armWalk(match);
        match.hudVersion++;
      }
      return;
    }

    case "walking": {
      // ── Ambushes, then the wave ────────────────────────────────────────────
      //
      // The order matters. An ambush is spawned *before* the wave gate is
      // tested, so a player who triggers both in the same frame gets the
      // ambush and has to clear it — and the wave only opens once the street
      // is empty. That is the whole contract: an ambush delays the wave, it
      // never replaces it.
      if (match.roaming === 0) {
        const progress = clamp(
          (match.player.x - match.walkFrom) / match.walkSpan,
          0,
          1,
        );
        const points = roamPoints(match.walkSpan);
        if (match.roamFired < points.length && progress >= points[match.roamFired]) {
          startRoam(match);
        }
      } else if (!match.enemies.some((enemy) => isLive(enemy))) {
        // Cleared. The walk resumes and the wave gate below takes over.
        match.roaming = 0;
        match.hudVersion++;
      }

      if (match.roaming > 0) return;

      // **The camera gates the wave, not the player's position.**
      //
      // This used to fire when the player reached a gate 24 px shy of the
      // screen's right wall — but the camera stops advancing at
      // `zoneCamX(waveIndex)`, which is a third of a screen earlier. So every
      // wave opened with a forced walk across dead screen, with nothing on it
      // and nothing to do but hold right, which is the single dullest moment
      // in a run.
      //
      // The camera lerps towards its target rather than snapping, so "the
      // scroll has stopped" is a tolerance against the zone position, not an
      // equality test.
      const target = zoneCamX(match.waveIndex);
      const settled =
        Math.abs(match.camX - target) <= CAMERA_SETTLED_EPSILON;

      // Zone 0 is the exception, and it is not a special case so much as the
      // same rule: its camera range is `[0, 0]`, so the camera is *always*
      // settled and would open wave 1 before the player had touched a key. The
      // "has walked into the street" half of the rule is therefore written
      // explicitly, and for every later zone it is already implied — reaching a
      // zone's camera position means standing half a screen past it.
      //
      // The upper bound matters too: the player is *able* to walk past the
      // camera's stopping point (they are clamped to the screen, not to the
      // zone), so without it a player who held right through the settle would
      // open the wave a screen late, off the end of the street.
      const entered =
        match.player.x >= target + WAVE_ENTRY_X &&
        match.player.x <= target + STAGE_W + WALL_X;

      if (settled && entered) startWave(match);
      return;
    }

    case "fighting": {
      if (match.enemies.length > 0 && !match.enemies.some(isLive)) {
        match.phase = "waveClear";
        match.phaseTimer = WAVE_CLEAR_MS;
        match.bannerTimer = WAVE_CLEAR_MS;
        match.score += WAVE_CLEAR_SCORE + match.waveIndex * 100;
        match.banner = {
          title: "WAVE CLEARED",
          subtitle: `SCORE ${match.score}`,
        };
        match.hudVersion++;
      }
      return;
    }

    case "waveClear": {
      match.phaseTimer -= dtMs;
      if (match.phaseTimer <= 0) finishWave(match);
      return;
    }

    case "down": {
      match.phaseTimer -= dtMs;
      if (match.phaseTimer <= 0) {
        // Lives are the run's real currency, so this is the only ending there
        // is: fifteen waves or one endless stretch, either way it ends here.
        if (match.lives <= 0) endRun(match, "defeat");
        else respawn(match);
      }
      return;
    }

    default:
      return;
  }
};

const stepCamera = (match: MatchState, dt: number): void => {
  const index = match.waveIndex;

  // Everything except the walk between waves is locked to its own screen.
  if (match.phase !== "walking") {
    match.camX = zoneCamX(index);
    return;
  }

  const lo = index === 0 ? 0 : zoneCamX(index - 1);
  const hi = zoneCamX(index);
  const target = clamp(match.player.x - STAGE_W / 2, lo, hi);
  match.camX += (target - match.camX) * Math.min(1, dt * CAMERA_LERP);
};

// ── The frame ────────────────────────────────────────────────────────────────

/**
 * Collect drops, and retire the ones left behind.
 *
 * There is no ageing step: a drop lives until the player takes it or walks past
 * it. See `PICKUP_DESPAWN_PAD` in `pickups.ts` for why a countdown was the wrong
 * model — the short version is that a timer kills a drop during exactly the
 * pause a good player takes, and then dies quietly enough to look like a bug.
 *
 * Collection is a **rectangle in `(x, z)`**, not a radius — the same shape an
 * attack's hitbox takes, deliberately. A pickup you have to be at the exact
 * centre of to grab is fiddly in a game where you are usually being shoved
 * around; a rectangle whose depth arm matches the depth arm of your own reach
 * means "step onto its line and you have it", which is the interaction the
 * whole depth plane is built to support.
 */
const stepPickups = (match: MatchState): void => {
  if (match.pickups.length === 0) return;

  const player = match.player;
  const collectible = isLive(player);
  const collected: Pickup[] = [];

  for (const pickup of match.pickups) {
    if (
      !collectible ||
      Math.abs(player.x - pickup.x) > PICKUP_REACH_X ||
      Math.abs(player.z - pickup.z) > PICKUP_REACH_Z
    ) {
      continue;
    }

    // Marked for collection by removal below, rather than by zeroing a lifetime:
    // there is no lifetime left to zero.
    collected.push(pickup);

    if (pickup.kind === "health") {
      // Capped, and a wasted drop is reported as such rather than silently
      // vanishing — otherwise collecting one at full health looks like a bug.
      const before = player.hp;
      player.hp = Math.min(player.maxHp, player.hp + HEALTH_PICKUP_AMOUNT);
      const gained = Math.round(player.hp - before);
      pushFloater(
        match,
        gained > 0 ? `+${gained} HP` : "HP FULL",
        pickup.x,
        pickup.z,
        gained > 0 ? "#4ade80" : "#94a3b8",
      );
    } else {
      const before = match.magic;
      match.magic = Math.min(MAGIC_MAX, match.magic + MAGIC_PICKUP_AMOUNT);
      const gained = Math.round(match.magic - before);
      pushFloater(
        match,
        gained > 0 ? `+${gained} MAGIC` : "METER FULL",
        pickup.x,
        pickup.z,
        gained > 0 ? "#c084fc" : "#94a3b8",
      );
    }

    match.score += PICKUP_SCORE;
    match.hudVersion++;
  }

  // Two exits, both the player's doing: collected, or walked past. A drop that is
  // merely *near* is kept, which is what makes the off-frame pad in
  // `pickups.ts` worth having.
  match.pickups = match.pickups.filter(
    (pickup) =>
      !collected.includes(pickup) &&
      !pickupIsBehind(pickup, match.camX, STAGE_W),
  );
};

const pushFloater = (
  match: MatchState,
  text: string,
  x: number,
  z: number,
  color: string,
): void => {
  const life = 1000;
  match.floaters.push({ text, x, z, life, maxLife: life, color });

  // Hard ceiling, same reasoning as the sparks: a long wave with a generous
  // drop rate should never accumulate labels faster than they fade.
  if (match.floaters.length > 12) {
    match.floaters.splice(0, match.floaters.length - 12);
  }
};

const stepFloaters = (match: MatchState, dtMs: number): void => {
  if (match.floaters.length === 0) return;
  for (const floater of match.floaters) floater.life -= dtMs;
  if (match.floaters.some((floater) => floater.life <= 0)) {
    match.floaters = match.floaters.filter((floater) => floater.life > 0);
  }
};

const stepSparks = (match: MatchState, dtMs: number): void => {
  for (const spark of match.sparks) spark.life -= dtMs;
  if (match.sparks.some((spark) => spark.life <= 0)) {
    match.sparks = match.sparks.filter((spark) => spark.life > 0);
  }
  // Hard ceiling: a very busy wave plus a spam-cast can otherwise accumulate
  // faster than they expire on a slow frame.
  if (match.sparks.length > 48) {
    match.sparks.splice(0, match.sparks.length - 48);
  }
};

const stepActorTimers = (match: MatchState, dtMs: number): void => {
  const dt = dtMs / 1000;

  advanceTimers(match.player, dtMs);
  stepAdvance(match.player, match, dt);
  stepPhysics(match.player, match, dt);

  for (const enemy of match.enemies) {
    advanceTimers(enemy, dtMs);
    stepAdvance(enemy, match, dt);
    stepPhysics(enemy, match, dt);
  }
};

/**
 * Advance one frame.
 *
 * The ordering is the whole design:
 *
 * 1. **Cosmetics** (shake, flash, sparks) decay first and unconditionally, so
 *    a hit's punctuation never stalls behind the freeze it caused.
 * 2. **Input buffers** age next — they are player intent, not world state, and
 *    a press made just before a hitstop must not be eaten by it.
 * 3. **Hitstop** then freezes everything else for a frame or two. This is the
 *    only early return, and it sits *above* the phase machine so a death's
 *    banner and a wave's countdown cannot tick while the impact is still
 *    landing.
 * 4. **Phases**, then **player**, then **AI**, then **timers**, then **hits**.
 *    Hits resolve last so a swing started this frame cannot also connect this
 *    frame, and so every position it reads has already been clamped.
 */
export const stepMatch = (match: MatchState, dtMs: number): void => {
  const clamped = Math.min(Math.max(dtMs, 0), 100);
  const dt = clamped / 1000;

  match.worldMs += clamped;

  match.shake = Math.max(0, match.shake - clamped);
  match.flash = Math.max(0, match.flash - clamped);
  stepSparks(match, clamped);
  stepFloaters(match, clamped);

  const input = match.playerInput;
  input.attackBuf = Math.max(0, input.attackBuf - clamped);
  input.magicBuf = Math.max(0, input.magicBuf - clamped);

  if (match.hitstop > 0) {
    match.hitstop -= clamped;
    return;
  }

  if (match.bannerTimer > 0) {
    match.bannerTimer -= clamped;
    if (match.bannerTimer <= 0) {
      match.bannerTimer = 0;
      if (!match.result && match.banner) {
        match.banner = null;
        match.hudVersion++;
      }
    }
  }

  stepPhase(match, clamped);

  // An ambush is a real fight that happens to be happening during a walk, so
  // "is anything on the street hostile right now" is the condition for running
  // the AI and resolving hits — not `phase === "fighting"` on its own. Without
  // this an ambush would be two statues the player walks past.
  const fighting = match.phase === "fighting";
  const hostile = fighting || match.roaming > 0;
  const accepting =
    hostile ||
    match.phase === "intro" ||
    match.phase === "walking" ||
    match.phase === "waveClear";

  if (accepting) stepPlayer(match, dt);
  if (hostile) for (const enemy of match.enemies) stepEnemy(match, enemy, clamped);

  stepActorTimers(match, clamped);

  if (hostile) {
    stepAttack(match, match.player);
    for (const enemy of match.enemies) stepAttack(match, enemy);
    separateAll(match);
  }

  // Drops collect in every phase that moves the player, not just `fighting`:
  // walking over one during the walk to the next wave is exactly the kind of
  // thing a player should be rewarded for doing by accident.
  //
  // They retire here too, against the camera as it stood at the *top* of this
  // frame — `stepCamera` runs below. That one-frame lag is the right way round:
  // culling on the camera the player has not yet been shown would retire a drop
  // while it is still on screen, which is the one thing the rule forbids.
  if (match.phase !== "gameOver" && match.phase !== "victory") {
    stepPickups(match);
  }

  stepCamera(match, dt);

  // Pruned last: `stepPhase` reads `enemies.length > 0` to tell a wave that
  // has not started from one whose last corpse has just faded.
  // Pruned last: `stepPhase` reads `enemies.length > 0` to tell a wave that
  // has not started from one whose last corpse has just faded, and the walk
  // reads it to ask whether an ambush is still on the street.
  //
  // A roamer is never removed for being unreachable — it is removed only by
  // dying. There is deliberately no leash: a champion outwalks a scout, so a
  // leash would let "hold right forever" trivialise an ambush *and* stall the
  // run behind it. Instead the wave cannot open while `roaming > 0`, so an
  // outrun roamer is a problem the player solves by turning round, which is
  // the interaction the street is supposed to provoke.
  if (
    match.enemies.some((enemy) => enemy.action === "ko" && enemy.koTimer <= 0)
  ) {
    match.enemies = match.enemies.filter(
      (enemy) => !(enemy.action === "ko" && enemy.koTimer <= 0),
    );
  }

  const pct = Math.round(match.magic);
  if (pct !== match.shownMagicPct) {
    match.shownMagicPct = pct;
    match.hudVersion++;
  }
};

// ── HUD ──────────────────────────────────────────────────────────────────────

export const readHud = (match: MatchState): HudSnapshot => {
  let left = 0;
  let roamers = 0;
  let boss: HudSnapshot["boss"] = null;

  for (const enemy of match.enemies) {
    if (enemy.action === "ko") continue;
    // Ambushers are counted separately. Folding them into "3 LEFT" on the wave
    // counter would claim a wave still has three enemies when it has none and
    // the street has two — two different numbers answering the same question.
    if (enemy.isRoam) {
      roamers++;
      continue;
    }
    left++;
    if (enemy.tier === "boss") {
      boss = {
        name: enemy.name,
        hp: enemy.hp,
        maxHp: enemy.maxHp,
        color: enemy.color,
      };
    }
  }

  // Resolved through the endless mapping, so the HUD names the wave the player
  // is actually fighting rather than reading off an array that has run out.
  const spec = getWaveSpec(match.waveIndex);
  const endless = match.waveIndex >= WAVE_COUNT;

  return {
    phase: match.phase,
    banner: match.banner,
    score: match.score,
    lives: match.lives,
    hp: match.player.hp,
    maxHp: match.player.maxHp,
    magic: match.magic,
    wave: match.waveIndex + 1,
    waveCount: WAVE_COUNT,
    waveName: endless
      ? `ENDLESS ${endlessLoop(match.waveIndex) + 1} — ${spec.name}`
      : spec.name,
    endless,
    enemiesLeft: left,
    roamers,
    boss,
    result: match.result,
    reachedFinale: match.reachedFinale,
    bestWave: match.bestWave,
  };
};

// ── Drawing ──────────────────────────────────────────────────────────────────

const drawShadow = (ctx: CanvasRenderingContext2D, a: ActorRT): void => {
  ctx.fillStyle = "rgba(10, 18, 14, 0.42)";
  ctx.beginPath();
  ctx.ellipse(a.x, zToY(a.z) + 3, a.rx + 7, 6, 0, 0, Math.PI * 2);
  ctx.fill();
};

/**
 * A drop on the floor: its shadow, its art, and the line it sits on.
 *
 * Drawn from the same `PICKUP_ART` map the engine resolves `PICKUP_ART[kind]`
 * through, and falls back to a coloured diamond if an image has not arrived —
 * a drop you cannot see is a drop that looks like the game is broken.
 */
const drawPickup = (
  ctx: CanvasRenderingContext2D,
  pickup: Pickup,
  worldMs: number,
  images: Readonly<Record<string, HTMLImageElement | undefined>>,
): void => {
  const feet = zToY(pickup.z);
  const image = images[PICKUP_ART[pickup.kind]];
  const ready = image && image.complete && image.naturalWidth > 0 ? image : null;

  // Its own shadow, so a drop reads as resting on the floor rather than
  // floating in front of it — the bob above it is then legible as a bob.
  ctx.save();
  ctx.fillStyle = "rgba(10, 18, 14, 0.35)";
  ctx.beginPath();
  ctx.ellipse(pickup.x, feet + 2, 11, 4, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const lift = pickupBobY(pickup, worldMs);
  const half = PICKUP_SIZE / 2;

  ctx.save();
  if (ready) {
    ctx.drawImage(ready, pickup.x - half, feet - PICKUP_SIZE + lift, PICKUP_SIZE, PICKUP_SIZE);
  } else {
    // Diamond placeholder: unmistakable as "an item", and colour-coded to the
    // resource it restores so the fallback is still playable.
    ctx.fillStyle = pickup.kind === "health" ? "#f472b6" : "#c084fc";
    ctx.beginPath();
    ctx.moveTo(pickup.x, feet - PICKUP_SIZE + lift);
    ctx.lineTo(pickup.x + half, feet - half + lift);
    ctx.lineTo(pickup.x, feet + lift);
    ctx.lineTo(pickup.x - half, feet - half + lift);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
};

/**
 * Floating pickup labels, drawn last so nothing can overlap them.
 *
 * Rise and fade on a curve rather than a line: the label spends most of its
 * life readable and the last third dissolving, which is what makes it feel like
 * an event rather than an overlay.
 */
const drawFloaters = (
  ctx: CanvasRenderingContext2D,
  match: MatchState,
): void => {
  for (const floater of match.floaters) {
    const t = 1 - floater.life / floater.maxLife;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - t * t);
    // Scaled for a 960-wide stage: a label authored at the old 640 would be
    // illegible once the stage grew, which is the same mistake as leaving the
    // sprite scale behind when the viewport doubled.
    ctx.font = "bold 17px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.strokeText(floater.text, floater.x, zToY(floater.z) - 68 - t * 34);
    ctx.fillStyle = floater.color;
    ctx.fillText(floater.text, floater.x, zToY(floater.z) - 68 - t * 34);
    ctx.restore();
  }
};

/**
 * The sheet to draw, or `undefined` if none is usable.
 *
 * ## Why a cycle falls back instead of falling through
 *
 * The obvious reading of "the image is missing" is to draw the coloured
 * placeholder body, and that is what this did. It turns out that is a terrible
 * failure mode for a *specific* cycle going missing: the character keeps its
 * art, its size, its facing and its position, and only the body turns into a
 * flat rectangle — so the bug reads as "these NPCs flash a coloured square
 * mid-attack", which is a genuinely baffling symptom to diagnose from a
 * screenshot. Seven NPCs did exactly this for a while, and the Wizard did it on
 * every jab.
 *
 * So a missing cycle now degrades to **another cycle of the same character**,
 * preferring the nearest thing that is already loaded:
 *
 *   attack cycle → the character's own `walking` → `idle`
 *
 * The result is a character that lunges with its walking pose instead of its
 * swing. That reads as a slightly stiff animation, which is a cosmetic nit
 * somebody might notice for a frame — where a coloured rectangle is a bug report.
 *
 * The placeholder is now reserved for its actual job: a character with **no**
 * usable sheet at all, which is the CDN being slow and is genuinely transient.
 */
const sheetFor = (
  sheet: Sheets | undefined,
  anim: string,
): HTMLImageElement | undefined => {
  if (!sheet) return undefined;
  const usable = (image: HTMLImageElement | undefined) =>
    image && image.complete && image.naturalWidth > 0 ? image : undefined;

  const direct = usable(sheet[anim]);
  if (direct) return direct;

  // Only an *action* cycle is worth substituting for. Falling back for `idle` or
  // `walking` would hide a genuinely absent sheet behind a duplicate of itself.
  if (anim !== "idle" && anim !== "walking") {
    for (const fallback of ["walking", "idle"]) {
      const image = usable(sheet[fallback]);
      if (image) return image;
    }
  }
  return undefined;
};

const drawSheetActor = (
  ctx: CanvasRenderingContext2D,
  a: ActorRT,
  sheet: Sheets | undefined,
  feet: number,
): void => {
  const image = sheetFor(sheet, a.anim);
  const frame = frameOf(a);
  const S = a.scale;

  let alpha = 1;
  if (a.spawnMs > 0) alpha *= 0.35 + 0.65 * (1 - a.spawnMs / SPAWN_MS);
  if (a.invulnMs > 900 && Math.floor(a.animElapsed / 90) % 2 === 0) alpha *= 0.4;

  ctx.save();
  ctx.globalAlpha = alpha;
  if (a.dir === -1) {
    ctx.translate(a.x, 0);
    ctx.scale(-1, 1);
    ctx.translate(-a.x, 0);
  }

  if (image) {
    // The frame index belongs to the cycle the actor *asked* for. When `image` is
    // a substitute the widths still agree (every sheet is 96x64 cells), so the
    // number is in range for any cycle — but a fallback past the substitute's own
    // length would read past its end, so it is clamped to what actually loaded.
    const available = Math.max(
      1,
      Math.floor(image.naturalWidth / FRAME_W),
    );
    const drawFrame = Math.min(frame, available - 1);
    ctx.drawImage(
      image,
      drawFrame * FRAME_W,
      0,
      FRAME_W,
      FRAME_H,
      a.x - SPRITE_CX * S,
      feet - SPRITE_FEET * S,
      FRAME_W * S,
      FRAME_H * S,
    );
  } else {
    // No usable sheet for this character at all — a CDN still in flight. A named,
    // coloured body keeps the wave playable; a missing sprite would leave holes.
    ctx.fillStyle = a.color;
    ctx.fillRect(a.x - a.rx, feet - BODY_H, a.rx * 2, BODY_H);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(
      a.dir === 1 ? a.x + a.rx - 6 : a.x - a.rx,
      feet - BODY_H + 8,
      6,
      6,
    );
  }
  ctx.restore();

  if (a.hitFlash > 0) {
    ctx.save();
    ctx.globalAlpha = Math.min(1, a.hitFlash / 90) * 0.7;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(a.x - a.rx, feet - BODY_H, a.rx * 2, BODY_H);
    ctx.restore();
  }
};

const drawSparks = (
  ctx: CanvasRenderingContext2D,
  match: MatchState,
  image: HTMLImageElement | undefined,
): void => {
  for (const spark of match.sparks) {
    const t = 1 - spark.life / spark.maxLife;
    const size = spark.size * (0.55 + 0.75 * t);
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - t) * 0.9;
    if (image && image.complete && image.naturalWidth > 0) {
      ctx.drawImage(image, spark.x - size / 2, spark.y - size / 2, size, size);
    } else {
      ctx.fillStyle = "#fff4c2";
      ctx.fillRect(spark.x - size / 4, spark.y - size / 4, size / 2, size / 2);
    }
    ctx.restore();
  }
};

/**
 * Draw a frame.
 *
 * The stage is blitted through a camera offset first, then everything in the
 * world is drawn in **world** coordinates inside a translated context, sorted
 * by `z`. Sorting is what gives the depth plane its only piece of realism: an
 * actor nearer the camera is drawn last and therefore over whatever it
 * overlaps, with its shadow taken along in the same pass so a shadow can never
 * land on top of the sprite it belongs to.
 */
export const renderMatch = (
  ctx: CanvasRenderingContext2D,
  match: MatchState,
  sheets: Readonly<Record<string, Sheets | undefined>>,
  images: Readonly<Record<string, HTMLImageElement | undefined>>,
  stage: HTMLCanvasElement | null,
): void => {
  ctx.save();
  ctx.clearRect(0, 0, STAGE_W, STAGE_H);

  if (match.shake > 0) {
    const mag = match.shakeMag * Math.min(1, match.shake / 130);
    ctx.translate(
      (Math.random() - 0.5) * 2 * mag,
      (Math.random() - 0.5) * 2 * mag,
    );
  }

  // Image smoothing off, or the 16px tiles come back as bilinear mush the
  // moment the browser scales the canvas up to fill its slot.
  ctx.imageSmoothingEnabled = false;

  const camX = Math.round(match.camX);
  // The world X is unbounded (endless runs keep climbing past `LEVEL_W`) while
  // the composed street is not, so the *blit* wraps. Everything drawn in world
  // space below translates by the real `camX`, so actors stay put across the
  // wrap — only the backdrop is recycled, and it is periodic, so the seam is
  // invisible.
  const stageX = stageOffset(camX);

  if (stage) {
    // Two blits, because the wrap point can fall inside the viewport.
    if (stageX + STAGE_W <= LEVEL_W) {
      ctx.drawImage(stage, stageX, 0, STAGE_W, STAGE_H, 0, 0, STAGE_W, STAGE_H);
    } else {
      const first = LEVEL_W - stageX;
      ctx.drawImage(stage, stageX, 0, first, STAGE_H, 0, 0, first, STAGE_H);
      ctx.drawImage(stage, 0, 0, STAGE_W - first, STAGE_H, first, 0, STAGE_W - first, STAGE_H);
    }
  } else {
    const sky = ctx.createLinearGradient(0, 0, 0, BACKDROP_BOTTOM);
    sky.addColorStop(0, "rgb(18, 16, 44)");
    sky.addColorStop(1, "rgb(52, 44, 74)");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, STAGE_W, BACKDROP_BOTTOM);
    ctx.fillStyle = "rgb(74, 138, 64)";
    ctx.fillRect(0, BACKDROP_BOTTOM, STAGE_W, STAGE_H - BACKDROP_BOTTOM);
  }

  ctx.save();
  ctx.translate(-camX, 0);

  // Actors and drops share one sort by `z`, rather than the actors being drawn
  // and then the drops laid over them. A drop in the far band has to be able
  // to pass *behind* a fighter that is nearer the camera, or the depth plane
  // stops being a depth plane the moment anything is lying on the floor.
  const drawables: { z: number; actor?: ActorRT; pickup?: Pickup }[] = [
    ...match.pickups.map((pickup) => ({ z: pickup.z, pickup })),
    ...[match.player, ...match.enemies].map((actor) => ({ z: actor.z, actor })),
  ];
  drawables.sort((a, b) => a.z - b.z);

  for (const item of drawables) {
    if (item.actor) {
      drawShadow(ctx, item.actor);
      drawSheetActor(ctx, item.actor, sheets[item.actor.sheetKey], zToY(item.actor.z));
    } else if (item.pickup) {
      drawPickup(ctx, item.pickup, match.worldMs, images);
    }
  }

  drawSparks(ctx, match, images[SPARK_KEY]);
  drawFloaters(ctx, match);

  ctx.restore();

  if (match.flash > 0) {
    const t = match.flashMax > 0 ? match.flash / match.flashMax : 0;
    ctx.fillStyle = `rgba(176, 128, 255, ${(0.45 * t).toFixed(3)})`;
    ctx.fillRect(-24, -24, STAGE_W + 48, STAGE_H + 48);
  }

  ctx.restore();
};
