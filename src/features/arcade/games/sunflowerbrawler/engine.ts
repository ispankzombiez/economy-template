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
  BOSS_FRAMES,
  BOSS_FRAME_H,
  BOSS_FRAME_W,
  getEnemySpec,
  WAVES,
  WAVE_CLEAR_SCORE,
  type EnemySpec,
} from "./enemies";
import {
  GROUND_TOP,
  STAGE_H,
  STAGE_W,
  WALL_X,
  Z_MAX,
  zoneCamX,
  zToY,
} from "./stage";
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
 * is 134 px deep against a 66 px body — about two body-heights, wide enough
 * that two lines read as genuinely different places and shallow enough that the
 * whole band stays on screen without the camera ever tilting.
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
const BODY_H = 66;

/** Source pixels the sprite is anchored on: cell centre-x, feet-y. */
const SPRITE_CX = 48;
const SPRITE_FEET = 39;

/** Sheet pixel → stage pixel. 18 source px of body becomes ~65 stage px. */
const SPRITE_SCALE = 3.6;

/**
 * Milliseconds a swing stays able to connect after its impact frame.
 *
 * Wide enough that a victim who moved along `z` in the same frame still gets
 * hit — the line has to be a line, not a point — short enough that stepping
 * *early* beats stepping late.
 */
const ACTIVE_MS = 110;

/** How far past either screen edge an enemy may stand before entering. */
const ARENA_PAD = 100;

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
  moves: Readonly<Record<string, MoveSpec>>;
  /** Player: which swing a press inside the window would play. 0..2. */
  nextCombo: number;
  /** Player: ms left in the combo window. */
  comboWindow: number;
  /** Enemy: ms since the last swing ended — drives the reposition roll. */
  postSwing: number;
  /** Score this actor is worth. 0 for the player. */
  score: number;
  /** Set only on the boss, which draws from a four-frame strip. */
  isBoss: boolean;
  ai: AiState | null;
};

type Spark = {
  x: number;
  y: number;
  life: number;
  maxLife: number;
  size: number;
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
  /** 1-based wave the player is on. */
  wave: number;
  waveCount: number;
  waveName: string;
  enemiesLeft: number;
  /** Populated only while the boss is alive. */
  boss: { name: string; hp: number; maxHp: number; color: string } | null;
  /** Set once the run is over. */
  result: "victory" | "defeat" | null;
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
  result: "victory" | "defeat" | null;
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
    isBoss: false,
    ai: null,
  };
};

const makeEnemy = (
  match: MatchState,
  spec: EnemySpec,
  x: number,
  z: number,
  dir: 1 | -1,
): ActorRT => {
  const maxHp = Math.max(
    1,
    Math.round(spec.maxHp * match.difficulty.hpMultiplier),
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
    moves: spec.moves,
    nextCombo: 0,
    comboWindow: 0,
    postSwing: 0,
    score: spec.score,
    isBoss: spec.npc === null,
    ai: { timer: 90 + Math.random() * 200, dx: entering, dz: 0 },
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
    enemies: [],
    sparks: [],
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

  // 1. In range, the swing budget allows it, and the aggression roll passed.
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

  // 2. Just finished a swing: sometimes give ground rather than press on.
  if (enemy.postSwing > 0 && Math.random() < diff.spacingChance) {
    ai.dx = dx >= 0 ? -1 : 1;
    ai.dz = adz > 6 ? (dz >= 0 ? -1 : 1) : 0;
    ai.timer = diff.reactionMs * (0.8 + Math.random() * 0.7);
    return;
  }

  // 3. Close the line first, then the distance — and hold once in reach, so
  //    the roll in branch 1 gets another chance instead of a shove.
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
    const speed = enemy.walkSpeed * match.difficulty.speed;
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

const startWave = (match: MatchState): void => {
  const wave = WAVES[match.waveIndex];
  if (!wave) return;

  // Locked here and released by `finishWave`: during a wave the camera does
  // not move at all, which is what makes the screen an arena.
  match.camX = zoneCamX(match.waveIndex);
  match.phase = "fighting";
  match.banner = { title: wave.name, subtitle: wave.subtitle };
  match.bannerTimer = WAVE_INTRO_MS;
  match.hudVersion++;

  let index = 0;
  for (const spawn of wave.spawns) {
    const spec = getEnemySpec(spawn.id);
    for (let i = 0; i < spawn.count; i++) {
      // One in three enters from the left so a wave is never a single file
      // column walking in from one edge.
      const fromLeft = index % 3 === 0;
      const x = fromLeft ? match.camX - 60 : match.camX + STAGE_W + 60;
      const span = Math.max(1, Z_MAX - 24);
      const z =
        spec.tier === "boss"
          ? Z_MAX * 0.5
          : 12 + ((index * 47 + match.waveIndex * 31) % span);
      match.enemies.push(makeEnemy(match, spec, x, z, fromLeft ? 1 : -1));
      index++;
    }
  }

  match.hudVersion++;
};

const finishWave = (match: MatchState): void => {
  match.enemies = [];

  if (match.waveIndex + 1 >= WAVES.length) {
    endRun(match, "victory");
    return;
  }

  match.waveIndex++;
  match.phase = "walking";
  match.banner = null;
  match.bannerTimer = 0;
  match.hudVersion++;
};

const endRun = (match: MatchState, result: "victory" | "defeat"): void => {
  match.result = result;
  match.phase = result === "victory" ? "victory" : "gameOver";
  match.banner = null;
  match.bannerTimer = 0;
  match.phaseTimer = 0;
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
    match.camX + 140,
    match.camX + STAGE_W - 140,
  );
  player.z = Z_MAX * 0.5;

  // Shove the crowd back. Without it the player reappears inside a ring of
  // enemies with their i-frames already half spent, and the second life is
  // strictly worse than the first.
  for (const enemy of match.enemies) {
    if (!isLive(enemy)) continue;
    const dx = enemy.x - player.x;
    const dz = enemy.z - player.z;
    if (Math.abs(dx) > 300 || Math.abs(dz) > 110) continue;
    enemy.knockV =
      (dx === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dx)) *
      RESPAWN_SHOVE;
    enemy.knockZ =
      (dz === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(dz)) * 360;
  }

  match.phase = "fighting";
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
        match.hudVersion++;
      }
      return;
    }

    case "walking": {
      // The gate is 24 px shy of the screen's right wall. The camera stops
      // advancing at `zoneCamX(waveIndex)` long before that, so walking into
      // the stopped camera *is* what starts the wave.
      const gate = zoneCamX(match.waveIndex) + STAGE_W - WALL_X - 24;
      if (match.player.x >= gate) startWave(match);
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

  match.shake = Math.max(0, match.shake - clamped);
  match.flash = Math.max(0, match.flash - clamped);
  stepSparks(match, clamped);

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

  const fighting = match.phase === "fighting";
  const accepting =
    fighting ||
    match.phase === "intro" ||
    match.phase === "walking" ||
    match.phase === "waveClear";

  if (accepting) stepPlayer(match, dt);
  if (fighting) for (const enemy of match.enemies) stepEnemy(match, enemy, clamped);

  stepActorTimers(match, clamped);

  if (fighting) {
    stepAttack(match, match.player);
    for (const enemy of match.enemies) stepAttack(match, enemy);
    separateAll(match);
  }

  stepCamera(match, dt);

  // Pruned last: `stepPhase` reads `enemies.length > 0` to tell a wave that
  // has not started from one whose last corpse has just faded.
  if (
    match.enemies.some(
      (enemy) => enemy.action === "ko" && enemy.koTimer <= 0,
    )
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
  let boss: HudSnapshot["boss"] = null;

  for (const enemy of match.enemies) {
    if (enemy.action === "ko") continue;
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

  const index = Math.min(match.waveIndex, WAVES.length - 1);
  const wave = WAVES[index];

  return {
    phase: match.phase,
    banner: match.banner,
    score: match.score,
    lives: match.lives,
    hp: match.player.hp,
    maxHp: match.player.maxHp,
    magic: match.magic,
    wave: Math.min(match.waveIndex + 1, WAVES.length),
    waveCount: WAVES.length,
    waveName: wave ? wave.name : "",
    enemiesLeft: left,
    boss,
    result: match.result,
  };
};

// ── Drawing ──────────────────────────────────────────────────────────────────

const drawShadow = (ctx: CanvasRenderingContext2D, a: ActorRT): void => {
  ctx.fillStyle = "rgba(10, 18, 14, 0.42)";
  ctx.beginPath();
  ctx.ellipse(a.x, zToY(a.z) + 3, a.rx + 5, 4.5, 0, 0, Math.PI * 2);
  ctx.fill();
};

/**
 * Which of the boss's four frames to show.
 *
 * The strip is a blink cycle, so none of its frames *are* an attack — instead
 * the frames are used as poses the state machine picks between: wound back,
 * struck through, recovering, and flat on its back. The motion that sells it
 * comes from `drawBoss`, which leans the whole sprite through the swing.
 */
const bossFrameOf = (a: ActorRT): number => {
  if (a.action === "ko") return BOSS_FRAMES - 1;
  if (a.action === "hurt") return 0;
  if (a.action === "attack" && a.moveKind) {
    const move = a.moves[a.moveKind];
    if (move) {
      const t = Math.min(1, a.moveElapsed / moveDurationMs(move));
      if (t < 0.4) return 1;
      if (t < 0.7) return 2;
      return 3;
    }
  }
  return Math.floor(a.animElapsed / 165) % BOSS_FRAMES;
};

const drawBoss = (
  ctx: CanvasRenderingContext2D,
  a: ActorRT,
  feet: number,
  image: HTMLImageElement | null,
): void => {
  const S = a.scale;

  if (!image || !image.complete || image.naturalWidth === 0) {
    ctx.fillStyle = a.color;
    ctx.fillRect(a.x - a.rx, feet - 154, a.rx * 2, 154);
    return;
  }

  const frame = bossFrameOf(a);

  ctx.save();
  ctx.translate(a.x, feet);

  // The lean: wound back through the first 40 % of the move, driven through
  // the middle, settling over the recovery. Continuous on purpose — a jump in
  // the offset reads as a stutter at 60 fps.
  if (a.action === "attack" && a.moveKind) {
    const move = a.moves[a.moveKind];
    if (move) {
      const t = Math.min(1, a.moveElapsed / moveDurationMs(move));
      let lean = 0;
      if (t < 0.4) lean = -14 * (t / 0.4);
      else if (t < 0.7) lean = -14 + 36 * ((t - 0.4) / 0.3);
      else lean = 22 * (1 - (t - 0.7) / 0.3);
      ctx.translate(a.dir * lean, 0);
    }
  }

  let alpha = 1;

  if (a.action === "ko") {
    const t = clamp(1 - a.koTimer / DEATH_MS, 0, 1);
    ctx.rotate(t * 1.35);
    if (t > 0.55) alpha = Math.max(0, 1 - (t - 0.55) / 0.45);
  }

  if (a.spawnMs > 0) {
    alpha *= 0.3 + 0.7 * (1 - a.spawnMs / SPAWN_MS);
    const pop = 0.55 + 0.45 * (1 - a.spawnMs / SPAWN_MS);
    ctx.scale(pop, pop);
  }

  if (a.invulnMs > 900 && Math.floor(a.animElapsed / 90) % 2 === 0) {
    alpha *= 0.4;
  }

  ctx.globalAlpha = alpha;
  if (a.dir === -1) ctx.scale(-1, 1);

  ctx.drawImage(
    image,
    frame * BOSS_FRAME_W,
    0,
    BOSS_FRAME_W,
    BOSS_FRAME_H,
    (-BOSS_FRAME_W * S) / 2,
    -BOSS_FRAME_H * S,
    BOSS_FRAME_W * S,
    BOSS_FRAME_H * S,
  );
  ctx.restore();

  if (a.hitFlash > 0) {
    const height = BOSS_FRAME_H * S;
    ctx.save();
    ctx.globalAlpha = Math.min(1, a.hitFlash / 90) * 0.7;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(a.x - a.rx, feet - height, a.rx * 2, height);
    ctx.restore();
  }
};

const drawSheetActor = (
  ctx: CanvasRenderingContext2D,
  a: ActorRT,
  sheet: Sheets | undefined,
  feet: number,
): void => {
  const image = sheet?.[a.anim];
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

  if (image && image.complete && image.naturalWidth > 0) {
    ctx.drawImage(
      image,
      frame * FRAME_W,
      0,
      FRAME_W,
      FRAME_H,
      a.x - SPRITE_CX * S,
      feet - SPRITE_FEET * S,
      FRAME_W * S,
      FRAME_H * S,
    );
  } else {
    // The sheet has not arrived (or never will). A named, coloured body keeps
    // the wave playable; a missing sprite would leave holes in the crowd.
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
  bossImage: HTMLImageElement | null,
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

  if (stage) {
    ctx.drawImage(stage, camX, 0, STAGE_W, STAGE_H, 0, 0, STAGE_W, STAGE_H);
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

  const actors: ActorRT[] = [match.player, ...match.enemies];
  actors.sort((a, b) => a.z - b.z);

  for (const actor of actors) {
    drawShadow(ctx, actor);
    const feet = zToY(actor.z);
    if (actor.isBoss) drawBoss(ctx, actor, feet, bossImage);
    else drawSheetActor(ctx, actor, sheets[actor.sheetKey], feet);
  }

  drawSparks(ctx, match, images[SPARK_KEY]);

  ctx.restore();

  if (match.flash > 0) {
    const t = match.flashMax > 0 ? match.flash / match.flashMax : 0;
    ctx.fillStyle = `rgba(176, 128, 255, ${(0.45 * t).toFixed(3)})`;
    ctx.fillRect(-24, -24, STAGE_W + 48, STAGE_H + 48);
  }

  ctx.restore();
};
