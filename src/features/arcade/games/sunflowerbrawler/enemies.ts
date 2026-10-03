import bigGoblinSheet from "../../assets/big_goblin.png";
import type { MoveSpec } from "./fighters";

/**
 * The opposition: what spawns, in what order, and what it can do.
 *
 * ## Faction-themed waves
 *
 * The five waves are not five counts of the same enemy. They run in two
 * blocks — a **goblin** block (waves 1–2) and an **undead** block (waves 3–4)
 * — and the two blocks are built to ask opposite questions:
 *
 * * **Goblins** are fast and frail. They close distance and poke, so the
 *   answer is to hold a line and make them come to you, and the threat is
 *   being run down rather than out-tanked.
 * * **The undead** are slow and tanky. They walk straight in and absorb the
 *   string, so the answer is the depth axis — step off their line, let them
 *   pass, hit them from the line they are not on.
 *
 * Every wave also carries one **heavy**: 48–80 HP against a grunt's 22–38, a
 * slower and much longer-reaching swing, and roughly double the knockback. The
 * heavy is what stops a wave from being a circle-strafe — it holds the middle
 * while the grunts work the edges.
 *
 * Wave 5 is `BIG GOBLIN`, and it is a different kind of thing entirely.
 *
 * ## The boss is a sprite, not a sheet
 *
 * `big_goblin.png` comes from Sunflower Land's own `RetreatScene` — a 108×35
 * strip of four 27×35 frames played at 6 fps. It has an idle cycle and nothing
 * else: no walk, no attack, no death. So the boss's states are driven
 * procedurally in `engine.ts` from the same `action` field every other actor
 * has, and this file only supplies the geometry. That is a deliberate trade —
 * a bespoke boss sheet does not exist in any asset this repository can reach,
 * and a four-frame idle scaled to 4.4× reads as a boss far better than a
 * bumpkin in a large hat would.
 */

// ── Boss geometry ────────────────────────────────────────────────────────────

/** Source frame size of `big_goblin.png`. Four frames, laid out horizontally. */
export const BOSS_FRAME_W = 27;
export const BOSS_FRAME_H = 35;

/** Frames in the strip. */
export const BOSS_FRAMES = 4;

/** Sheet pixel → stage pixel. 35 source px becomes ~154 stage px tall. */
export const BOSS_SCALE = 4.4;

/** Sheet URL for the boss strip. */
export const bigGoblinSrc = bigGoblinSheet;

// ── Enemy specs ──────────────────────────────────────────────────────────────

export type EnemyId =
  | "goblinScout"
  | "goblinSneak"
  | "goblinBrute"
  | "skeleton"
  | "zombie"
  | "banshee"
  | "dreadhorn"
  | "bigGoblin";

/**
 * Two swings and nothing else.
 *
 * `jab` is what the AI throws when it is merely in range; `heavy` is what it
 * throws on a `heavyChance` roll — slower, longer, and the reason an enemy
 * winding up has to be respected. The boss uses the same pair, which is what
 * lets one AI run all eight enemies.
 */
export type EnemyMoves = { jab: MoveSpec; heavy: MoveSpec };

export type EnemySpec = {
  id: EnemyId;
  /** `NPC_WEARABLES` key, or `null` for the boss (which has no CDN sheet). */
  npc: string | null;
  /** Name shown over the boss's health bar. */
  name: string;
  tier: "grunt" | "heavy" | "boss";
  /** Accent colour for the health bar and score line. */
  color: string;
  maxHp: number;
  /** Stage pixels/second. */
  walkSpeed: number;
  /** Score awarded when this enemy dies. */
  score: number;
  /**
   * Sprite draw scale. Grunts play at the roster's own `SPRITE_SCALE`; the
   * heavies run a little over so the silhouette matches the stat block, and
   * the boss ignores this entirely in favour of `BOSS_SCALE`.
   */
  scale: number;
  /** Collision radius along `x`, stage pixels. */
  rx: number;
  /** Collision radius along `z`, stage pixels. */
  rz: number;
  moves: EnemyMoves;
};

const move = (
  anim: string,
  to: number,
  fps: number,
  impact: number,
  damage: number,
  reach: number,
  hitstunMs: number,
  knockback: number,
  knockZ: number,
  advance: number,
  zReach: number,
): MoveSpec => ({
  anim,
  from: 0,
  to,
  fps,
  impact,
  damage,
  hitstunMs,
  reach,
  knockback,
  knockZ,
  advance,
  zReach,
});

const ENEMY_SPECS: readonly EnemySpec[] = [
  // ── Goblin block: fast, frail, they come to you ──────────────────────────
  {
    id: "goblinScout",
    npc: "gordo",
    name: "GOBLIN SCOUT",
    tier: "grunt",
    color: "#8fd66a",
    maxHp: 26,
    walkSpeed: 142,
    score: 100,
    scale: 3.6,
    rx: 17,
    rz: 14,
    moves: {
      jab: move("axe", 9, 30, 5, 7, 62, 240, 150, 40, 40, 26),
      heavy: move("attack", 9, 22, 6, 13, 72, 380, 300, 120, 170, 30),
    },
  },
  {
    id: "goblinSneak",
    npc: "grabnab",
    name: "GOBLIN SNEAK",
    tier: "grunt",
    color: "#7ec8e3",
    maxHp: 22,
    walkSpeed: 172,
    score: 110,
    scale: 3.6,
    rx: 17,
    rz: 14,
    moves: {
      jab: move("attack", 9, 34, 5, 6, 60, 230, 130, 40, 60, 25),
      // The heavy *is* the dash. It is the one grunt move that closes
      // distance rather than holding it, which is what makes a pair of sneaks
      // feel like being rushed instead of being poked.
      heavy: move("axe", 9, 24, 5, 12, 66, 340, 260, 140, 320, 28),
    },
  },
  {
    id: "goblinBrute",
    npc: "grubnuk",
    name: "GOBLIN BRUTE",
    tier: "heavy",
    color: "#c9a24b",
    maxHp: 48,
    walkSpeed: 108,
    score: 240,
    scale: 3.8,
    rx: 21,
    rz: 16,
    moves: {
      jab: move("axe", 9, 24, 5, 11, 74, 300, 300, 90, 60, 30),
      heavy: move("attack", 9, 17, 6, 18, 86, 460, 460, 220, 210, 36),
    },
  },

  // ── Undead block: slow, tanky, they walk straight in ─────────────────────
  {
    id: "skeleton",
    npc: "pirate skeleton",
    name: "SKELETON",
    tier: "grunt",
    color: "#e8e2c4",
    maxHp: 38,
    walkSpeed: 90,
    score: 150,
    scale: 3.6,
    rx: 18,
    rz: 14,
    moves: {
      jab: move("attack", 9, 24, 5, 9, 66, 300, 240, 70, 40, 27),
      heavy: move("axe", 9, 18, 6, 16, 80, 440, 420, 200, 130, 34),
    },
  },
  {
    id: "zombie",
    npc: "farmer flesh",
    name: "ZOMBIE",
    tier: "heavy",
    color: "#9fbf7a",
    maxHp: 64,
    walkSpeed: 76,
    score: 300,
    scale: 3.8,
    rx: 21,
    rz: 16,
    moves: {
      jab: move("axe", 9, 20, 5, 12, 76, 340, 340, 100, 50, 32),
      heavy: move("attack", 9, 15, 7, 21, 90, 520, 520, 260, 150, 40),
    },
  },
  {
    id: "banshee",
    npc: "boneyard betty",
    name: "BANSHEE",
    tier: "grunt",
    color: "#d9a6e8",
    maxHp: 34,
    walkSpeed: 126,
    score: 170,
    scale: 3.6,
    rx: 17,
    rz: 14,
    moves: {
      jab: move("attack", 9, 30, 5, 8, 62, 260, 160, 60, 60, 26),
      // The scatter move: 300 px/s forward and 300 px/s *down the plane*, so
      // a banshee that connects shoves the player off the line it was holding.
      heavy: move("axe", 9, 22, 5, 15, 76, 400, 480, 300, 300, 32),
    },
  },
  {
    id: "dreadhorn",
    npc: "dreadhorn",
    name: "DREADHORN",
    tier: "heavy",
    color: "#e07a5f",
    maxHp: 80,
    walkSpeed: 86,
    score: 400,
    scale: 4.0,
    rx: 23,
    rz: 17,
    moves: {
      jab: move("axe", 9, 22, 5, 13, 82, 340, 360, 110, 60, 32),
      heavy: move("attack", 9, 15, 7, 24, 98, 560, 620, 320, 230, 46),
    },
  },

  // ── The boss ─────────────────────────────────────────────────────────────
  {
    id: "bigGoblin",
    npc: null,
    name: "BIG GOBLIN",
    tier: "boss",
    color: "#5fd35a",
    maxHp: 300,
    walkSpeed: 98,
    score: 2000,
    scale: BOSS_SCALE,
    rx: 40,
    rz: 30,
    moves: {
      // SWIPE — a line attack. Wide in `x`, narrow enough in `z` that stepping
      // off the boss's line still works, which is the reward for reading it.
      jab: move("attack", 9, 26, 5, 14, 100, 420, 420, 200, 90, 34),
      // SLAM — an area attack. `zReach` 70 against a 134-deep plane means the
      // depth axis will *not* save you; the 400 ms windup is the tell and the
      // answer is purely to be somewhere else along `x`. Two attacks, two
      // different dodges, one button.
      heavy: move("attack", 9, 15, 6, 26, 130, 620, 660, 340, 170, 70),
    },
  },
];

export const getEnemySpec = (id: EnemyId): EnemySpec => {
  const found = ENEMY_SPECS.find((enemy) => enemy.id === id);
  // The wave table is a literal array of exactly these ids, so this cannot miss.
  if (!found) return ENEMY_SPECS[0];
  return found;
};

/** Every enemy NPC the cabinet will ever ask the CDN for. */
export const ENEMY_NPCS: readonly string[] = ENEMY_SPECS
  .map((enemy) => enemy.npc)
  .filter((npc): npc is string => npc !== null);

// ── Waves ────────────────────────────────────────────────────────────────────

export type SpawnSpec = { id: EnemyId; count: number };

export type WaveSpec = {
  /** Banner title when the wave starts. */
  name: string;
  /** Banner line under the title. */
  subtitle: string;
  spawns: readonly SpawnSpec[];
};

/**
 * The five waves, one per screen of the level.
 *
 * Wave indices line up with `zoneCamX` in `stage.ts`: wave `n` fights on
 * screen `n`, so the level needs exactly `WAVES.length` screens.
 */
export const WAVES: readonly WaveSpec[] = [
  {
    name: "GOBLIN PATROL",
    subtitle: "SCOUTS ON THE STREET",
    spawns: [
      { id: "goblinScout", count: 2 },
      { id: "goblinBrute", count: 1 },
    ],
  },
  {
    name: "GOBLIN RAIDERS",
    subtitle: "THEY BROUGHT A BRUTE",
    spawns: [
      { id: "goblinSneak", count: 2 },
      { id: "goblinScout", count: 1 },
      { id: "goblinBrute", count: 1 },
    ],
  },
  {
    name: "THE BONEYARD",
    subtitle: "THE DEAD DO NOT REST",
    spawns: [
      { id: "skeleton", count: 3 },
      { id: "zombie", count: 1 },
    ],
  },
  {
    name: "GRAVE LEGION",
    subtitle: "DREADHORN ADVANCES",
    spawns: [
      { id: "skeleton", count: 2 },
      { id: "banshee", count: 1 },
      { id: "dreadhorn", count: 1 },
    ],
  },
  {
    name: "BIG GOBLIN",
    subtitle: "THE WARCHIEF HIMSELF",
    spawns: [{ id: "bigGoblin", count: 1 }],
  },
];

export const WAVE_COUNT = WAVES.length;

/** Score for clearing a wave, on top of the kills in it. */
export const WAVE_CLEAR_SCORE = 400;
