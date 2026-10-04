import type { MoveSpec } from "./fighters";

/**
 * The opposition: what spawns, in what order, what it can do, and how the run
 * escalates.
 *
 * ## Shape of a run
 *
 * **Fifteen waves**, in three blocks of five, with a boss closing each block:
 *
 * | Block | Waves | Theme | Boss |
 * |---|---|---|---|
 * | 1 | 1–5 | **Goblins** — fast, frail, they come to you | `GUNTER` (5) |
 * | 2 | 6–10 | **The undead** — slow, tanky, they walk straight in | `GILDA` (10) |
 * | 3 | 11–15 | **Elites** — the best of both, mixed | `GORGA` (15) |
 *
 * The blocks are built to ask opposite questions. Goblins close distance and
 * poke, so the answer is to hold a line and make them come to you. The undead
 * absorb the string, so the answer is the depth axis — step off their line, let
 * them pass, hit them from the line they are not on. Elites have no single
 * answer, which is the point: by wave 11 the player should be reading the crowd
 * rather than the block.
 *
 * ## Difficulty comes from the wave, not only the setting
 *
 * `hpMultiplier` and friends in `session.ts` set the *difficulty band*. What
 * makes wave 14 harder than wave 4 is `waveHpScale` and `waveSpeedScale` below,
 * which are applied per wave on top. Every wave adds ~6 % health and ~1.2 %
 * speed, so wave 15 is nearly twice the toughness of wave 1 with the same
 * numbers on both. That is the cheapest honest escalation there is: the roster
 * stays legible and the *stat sheet* grows, rather than a wave 14 that is
 * unreadable because it is wave 4 with six more enemies on screen.
 *
 * ## Endless
 *
 * Clearing wave 15 does not end the run — see `waveIndexToSpec`. The player goes
 * into **endless**, which replays the last ten waves on a rising loop with the
 * escalation compounding, and keeps going until lives run out.
 *
 * ## Enemies are distinguished by *behaviour*, not by colour
 *
 * Every entry here is a different **shape of threat**, and the shape is carried
 * by the move table rather than by the sprite:
 *
 * * A **jab** every enemy has — cheap, safe, the thing it does between real
 *   moves.
 * * A **heavy** — slow, long, high `zReach`, the one that punishes standing still.
 * * An optional **`special`** — the move that makes an enemy *that* enemy. Some
 *   lunge to close, some scatter you off your line, some reach further than
 *   anything else on the street.
 *
 * `specialAt` says when the special is worth using (too far, too close, or
 * simply in range), so a lunge is spent closing a gap rather than poking at your
 * face, and a sweep is spent from outside your reach. `specialCooldownMs` stops
 * any of them becoming a one-button monster.
 *
 * ## The bosses are ordinary actors with ordinary sheets
 *
 * The boss used to be `big_goblin.png`, a 108×35 strip of four 27×35 frames at
 * 6 fps — an idle cycle and nothing else, so every state had to be *faked* by
 * leaning the sprite and swapping frames as poses. It read as a boss in a still
 * screenshot and as a slideshow in motion.
 *
 * All three bosses are `NPC_WEARABLES` entries now, so the animation CDN serves
 * them the same full cycle vocabulary at the same 96×64 frame size. There is no
 * longer a boss-only draw path, no `isBoss` flag and no second art file; a boss
 * is an `ActorRT` drawn by `drawSheetActor` exactly like a grunt, and
 * `tier: "boss"` alone is what makes it bigger and puts a bar on the HUD.
 *
 * **A caveat worth stating plainly.** In the main game's data `gunter`, `gilda`
 * and `gorga` share a body, shirt and tool — Infernal Goblin, Fossil Armor,
 * Infernal Pitchfork — and differ in hair, with Gunter having no horns. They are
 * three closely-related infernal figures rather than three unrelated ones,
 * which is a defensible thing for a faction's three wardens to be, and it is
 * what the main game ships. They are separated in play by scale, colour and
 * move set rather than by silhouette. If they ever want to be visually distinct,
 * that is an edit to `NPC_WEARABLES` in the main game, not something this file
 * should paper over.
 */

// ── Enemy ids ────────────────────────────────────────────────────────────────

export type EnemyId =
  // goblin block
  | "goblinScout"
  | "goblinSneak"
  | "goblinBrute"
  | "goldtooth"
  | "grimtooth"
  // undead block
  | "skeleton"
  | "zombie"
  | "banshee"
  | "dreadhorn"
  | "phantomFace"
  // elite block
  | "eldric"
  | "blacksmith"
  | "wizard"
  | "chunLong"
  // bosses
  | "gunter"
  | "gilda"
  | "gorga";

/**
 * When an enemy's `special` is worth spending.
 *
 * `far` and `close` are measured against the `jab` reach, so the rule is stated
 * relative to the enemy's own size rather than as a magic distance.
 */
export type SpecialAt = "far" | "close" | "inRange";

export type EnemyMoves = {
  jab: MoveSpec;
  heavy: MoveSpec;
  /** The move that makes this enemy this enemy. Absent for plain grunts. */
  special?: MoveSpec;
  /** Where in its range band `special` should be spent. */
  specialAt?: SpecialAt;
  /**
   * Milliseconds between specials. Without it an enemy with a strong special is
   * a one-button monster — the AI re-rolls every `reactionMs`, which at Expert
   * is 150 ms.
   */
  specialCooldownMs?: number;
};

export type EnemySpec = {
  id: EnemyId;
  /** `NPC_WEARABLES` key. Every enemy, the bosses included, has one. */
  npc: string;
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
   * Sprite draw scale. Grunts play at the roster's own `SPRITE_SCALE`; heavies
   * run a little over so the silhouette matches the stat block; bosses run well
   * over so they own the screen.
   */
  scale: number;
  /** Collision radius along `x`, stage pixels. */
  rx: number;
  /** Collision radius along `z`, stage pixels. */
  rz: number;
  moves: EnemyMoves;
  /**
   * Probability this enemy drops a pickup when it dies.
   *
   * Weighted by tier rather than uniform, so the *choice* is interesting: a
   * grunt is a coin-flip and the reward is small, a heavy is close to certain
   * and the reward is a full bar. See `pickups.ts`.
   */
  dropChance: number;
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
    dropChance: 0.28,
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
      // A second, cheaper lunge for when it is still too far to be worth the
      // heavy — so a sneak that has lost you keeps coming rather than giving up.
      special: move("axe", 9, 38, 4, 8, 58, 260, 180, 90, 210, 24),
      specialAt: "far",
      specialCooldownMs: 2600,
    },
    dropChance: 0.34,
  },
  {
    id: "goldtooth",
    npc: "goldtooth",
    name: "GOLD TOOTH",
    tier: "grunt",
    color: "#e0b23c",
    maxHp: 28,
    walkSpeed: 158,
    score: 130,
    scale: 3.6,
    rx: 17,
    rz: 14,
    moves: {
      jab: move("attack", 9, 32, 5, 6, 60, 230, 130, 40, 50, 25),
      heavy: move("axe", 9, 24, 5, 11, 70, 330, 240, 110, 130, 29),
      // The long pickpocket swipe: reach 96 with a *narrow* z band, so the
      // answer is to step off the line and not to back away. The one enemy on
      // the street that can hit you from further than it looks like it should.
      special: move("attack", 9, 22, 7, 10, 96, 300, 260, 60, 40, 20),
      specialAt: "far",
      specialCooldownMs: 3200,
    },
    dropChance: 0.44,
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
    dropChance: 0.62,
  },
  {
    id: "grimtooth",
    npc: "grimtooth",
    name: "GRIMTOOTH",
    tier: "heavy",
    color: "#8e6f4a",
    maxHp: 62,
    walkSpeed: 116,
    score: 280,
    scale: 3.9,
    rx: 21,
    rz: 16,
    moves: {
      jab: move("axe", 9, 26, 5, 12, 76, 300, 320, 100, 70, 31),
      heavy: move("attack", 9, 18, 6, 19, 90, 470, 480, 240, 190, 40),
      // The overhead: a slow `z`-splitting slam. `zReach` 62 on a 210-deep
      // plane is nearly a third of it, and the answer is to be somewhere else
      // along `x` rather than to hope the step lands.
      special: move("hammering", 22, 40, 14, 22, 78, 540, 520, 400, 60, 62),
      specialAt: "inRange",
      specialCooldownMs: 5200,
    },
    dropChance: 0.66,
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
    dropChance: 0.3,
  },
  {
    id: "phantomFace",
    npc: "phantom face",
    name: "PHANTOM FACE",
    tier: "grunt",
    color: "#b9c7d9",
    maxHp: 32,
    walkSpeed: 134,
    score: 160,
    scale: 3.5,
    rx: 17,
    rz: 14,
    moves: {
      jab: move("attack", 9, 30, 5, 8, 62, 250, 150, 90, 60, 26),
      heavy: move("axe", 9, 22, 5, 13, 72, 380, 300, 170, 90, 30),
      // The fade-through: a wide, *flat* sweep that is answered by depth and
      // nothing else. It will not chase you down the plane, so once you are off
      // its line it just keeps swinging at empty air — which is exactly what
      // makes it feel like a ghost rather than a fast goblin.
      special: move("axe", 9, 26, 6, 12, 92, 340, 300, 420, 60, 78),
      specialAt: "inRange",
      specialCooldownMs: 3800,
    },
    dropChance: 0.32,
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
      // The grab: enormous `z` throw, so a zombie that connects physically
      // moves you off your line before you can react to the damage. It is the
      // only grunt-tier move on the street that wins the positional argument.
      special: move("attack", 9, 20, 7, 17, 68, 500, 420, 620, 40, 56),
      specialAt: "close",
      specialCooldownMs: 6000,
    },
    dropChance: 0.6,
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
    dropChance: 0.32,
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
      special: move("hammering", 22, 34, 15, 26, 88, 620, 700, 460, 120, 70),
      specialAt: "inRange",
      specialCooldownMs: 6400,
    },
    dropChance: 0.72,
  },

  // ── Elite block: the best of both, and no single answer ─────────────────
  {
    id: "eldric",
    npc: "eldric",
    name: "ELDRIC",
    tier: "heavy",
    color: "#6f8fd8",
    maxHp: 92,
    walkSpeed: 104,
    score: 380,
    scale: 4.1,
    rx: 23,
    rz: 17,
    moves: {
      jab: move("attack", 9, 26, 5, 14, 80, 320, 300, 90, 60, 32),
      heavy: move("axe", 9, 19, 6, 22, 96, 520, 560, 240, 160, 44),
      // The lunge-through: a knight that closes 300 px/s and hits like a heavy.
      // Eldric is the enemy that makes standing your ground a decision rather
      // than a default — you have to actually hold the line or it arrives.
      special: move("mining", 9, 30, 5, 20, 86, 480, 620, 300, 300, 40),
      specialAt: "far",
      specialCooldownMs: 4400,
    },
    dropChance: 0.7,
  },
  {
    id: "blacksmith",
    npc: "blacksmith",
    name: "BLACKSMITH",
    tier: "heavy",
    color: "#c25b3a",
    maxHp: 104,
    walkSpeed: 82,
    score: 420,
    scale: 4.2,
    rx: 24,
    rz: 18,
    moves: {
      jab: move("axe", 9, 24, 5, 15, 84, 340, 380, 120, 50, 34),
      heavy: move("hammering", 22, 40, 16, 27, 104, 600, 700, 340, 140, 48),
      // The one-shot. `hammering` at 40 fps is the slowest windup on the
      // street and by far the loudest — a blacksmith that starts one is giving
      // you a full second to leave, and the question is whether you believe it.
      special: move("hammering", 22, 30, 18, 34, 116, 700, 860, 520, 180, 58),
      specialAt: "close",
      specialCooldownMs: 7200,
    },
    dropChance: 0.74,
  },
  {
    id: "wizard",
    npc: "wizard",
    name: "WIZARD",
    tier: "grunt",
    color: "#a97fe0",
    maxHp: 44,
    walkSpeed: 96,
    score: 340,
    scale: 3.7,
    rx: 18,
    rz: 15,
    moves: {
      // A caster plays differently without any new machinery: the jab is the
      // longest cheap move on the street and the special is longer still, so a
      // wizard wants you at range and is worst when you close. Inverting the
      // usual relationship is the whole character.
      jab: move("casting", 14, 30, 7, 9, 92, 300, 200, 80, 0, 24),
      heavy: move("casting", 14, 20, 8, 17, 112, 460, 340, 160, 0, 30),
      special: move("casting", 14, 16, 9, 21, 138, 520, 300, 260, 0, 36),
      specialAt: "far",
      specialCooldownMs: 3600,
    },
    dropChance: 0.5,
  },
  {
    id: "chunLong",
    npc: "Chun Long",
    name: "CHUN LONG",
    tier: "heavy",
    color: "#e8d24a",
    maxHp: 78,
    walkSpeed: 132,
    score: 360,
    scale: 3.9,
    rx: 22,
    rz: 16,
    moves: {
      // Fast, tight, and hits for very little — a duelist who wins by volume
      // of attacks rather than by any one of them landing hard.
      jab: move("axe", 9, 40, 4, 10, 70, 220, 160, 60, 60, 28),
      heavy: move("attack", 9, 26, 5, 18, 92, 400, 420, 200, 150, 38),
      special: move("axe", 9, 34, 4, 16, 100, 340, 380, 260, 260, 34),
      specialAt: "inRange",
      specialCooldownMs: 3000,
    },
    dropChance: 0.68,
  },

  // ── Bosses ───────────────────────────────────────────────────────────────
  {
    id: "gunter",
    npc: "gunter",
    name: "GUNTER",
    tier: "boss",
    color: "#d8912f",
    // 200 base, ~250 after `waveHpScale` at wave 5. Boss health is the one
    // number that is very easy to get wrong by a factor of two: a full string
    // does ~40 damage, so 250 HP is about six clean strings. Measured against a
    // bot that lands maybe a fifth of its strings, that is a ~35-second fight —
    // long enough to be a boss, short enough that a mistake costs a life rather
    // than the run. The 520 that Gorga had at wave 15 measured out at nearly a
    // hundred seconds with a competent player, which is a wall, not a fight.
    maxHp: 200,
    walkSpeed: 108,
    score: 2000,
    scale: 5.2,
    rx: 30,
    rz: 22,
    moves: {
      // SWIPE — a line attack. Wide in `x`, narrow enough in `z` that stepping
      // off the boss's line still works, which is the reward for reading it.
      jab: move("axe", 9, 28, 5, 14, 100, 400, 420, 200, 80, 40),
      // SLAM — an area attack. `zReach` 70 covers a third of the plane, so the
      // depth axis will *not* save you; the 400 ms windup is the tell and the
      // answer is purely to be somewhere else along `x`.
      heavy: move("attack", 9, 16, 6, 24, 128, 600, 640, 340, 150, 70),
      // CHARGE — Gunter's identity, and the reason the first boss is a
      // positioning test rather than a damage race. He closes 380 px/s and
      // arrives already swinging, so a player who holds a line has to actually
      // commit to the trade instead of assuming the screen is his.
      special: move("axe", 9, 22, 6, 22, 110, 520, 780, 340, 380, 52),
      specialAt: "far",
      specialCooldownMs: 5200,
    },
    dropChance: 1,
  },
  {
    id: "gilda",
    npc: "gilda",
    name: "GILDA",
    tier: "boss",
    color: "#b8489a",
    // 260 base, ~400 at wave 10. Stepped up from Gunter but only by a third:
    // the *move set* is what escalates (DISSOLVE takes the ground away rather
    // than your health), and health on top of that just makes the same fight
    // longer, which is the wrong way to make a mid-run boss harder.
    maxHp: 260,
    walkSpeed: 100,
    score: 3000,
    scale: 5.6,
    rx: 32,
    rz: 23,
    moves: {
      jab: move("attack", 9, 30, 5, 15, 104, 400, 400, 220, 70, 42),
      heavy: move("axe", 9, 17, 6, 26, 130, 580, 640, 360, 170, 72),
      // DISSOLVE — the mid-run boss is the one that takes the *ground* away
      // rather than your health. `zReach` 96 covers nearly half the plane and
      // the `z` scatter is 520, so connecting with this moves you somewhere you
      // did not choose and leaves you a full beat to be hit again by whoever is
      // now behind you. It is the first move in the game that loses you the
      // positional argument outright.
      special: move("casting", 14, 18, 8, 22, 128, 560, 480, 520, 60, 96),
      specialAt: "inRange",
      specialCooldownMs: 5600,
    },
    dropChance: 1,
  },
  {
    id: "gorga",
    npc: "gorga",
    name: "GORGA",
    tier: "boss",
    color: "#e0463c",
    // 340 base, ~625 at wave 15 — the biggest of the three, and the run's
    // `reachedFinale` gate. Roughly eight clean strings, which measured out at
    // 40–50 seconds against a competent player: long enough that QUAKE's
    // half-second telegraph has to be respected, short enough that clearing it
    // feels like an achievement rather than an endurance test.
    maxHp: 340,
    walkSpeed: 96,
    score: 5000,
    scale: 6.0,
    rx: 34,
    rz: 25,
    moves: {
      jab: move("axe", 9, 30, 5, 16, 108, 400, 440, 220, 80, 42),
      heavy: move("attack", 9, 16, 6, 28, 136, 600, 700, 380, 180, 74),
      // QUAKE — the finale, and the widest move in the game. `zReach` 118 is
      // over half the plane, `advance` 200 means it also closes while it winds
      // up, and at 15 fps the whole thing is a 600 ms telegraph. There is no
      // single answer: step off the line and you are behind it, and stay on the
      // line and you take 30. Every other move in the game has a correct
      // response; this one has a trade-off, which is what makes it a finale
      // rather than a bigger version of wave 10's boss.
      special: move("hammering", 22, 15, 10, 30, 132, 700, 820, 560, 200, 118),
      specialAt: "inRange",
      specialCooldownMs: 6400,
    },
    dropChance: 1,
  },
];

export const getEnemySpec = (id: EnemyId): EnemySpec => {
  const found = ENEMY_SPECS.find((enemy) => enemy.id === id);
  // The wave table is a literal array of exactly these ids, so this cannot miss.
  if (!found) return ENEMY_SPECS[0];
  return found;
};

/**
 * Every enemy NPC the cabinet will ever ask the CDN for.
 *
 * Unguarded `map` — `npc` is a required string on every spec, so there is no
 * boss-shaped hole in it.
 */
export const ENEMY_NPCS: readonly string[] = ENEMY_SPECS.map((enemy) => enemy.npc);

/**
 * Cycles every enemy needs regardless of its moves: the four the state machine
 * can always ask for.
 */
const ENEMY_BASE_ANIMS = ["idle", "walking", "hurt", "death"] as const;

/**
 * The sheets one NPC actually needs, derived from **its own moves**.
 *
 * ## Why this is derived rather than a flat list
 *
 * It was a flat list, `ENEMY_ANIMS = [idle, walking, hurt, death, attack, axe]`,
 * written when enemies had two moves each and none of them cast. Then the
 * specials landed and moves started naming cycles that were not on the list —
 * `hammering`, `casting`, `mining` — and nothing noticed, because an unloaded
 * cycle does not throw: `renderMatch` finds no image for it and draws its
 * **coloured placeholder body** instead. The symptom was seven NPCs turning into
 * a coloured rectangle for the length of every attack and then snapping back to
 * their art the moment the swing ended. The Wizard was the worst of it, since its
 * *jab* is a cast, so it flashed a box on every basic attack.
 *
 * Deriving the set from the moves themselves makes that class of bug
 * unwriteable: a move cannot name a cycle its own NPC will not be asked to load.
 *
 * It is also cheaper than the blunt fix. Adding all three cycles to every NPC
 * would be 17 × 3 = 51 sheets that most characters never touch — a goblin
 * fetching a spellcasting cycle — whereas this asks each NPC only for what it
 * uses. Grunts load six; the Wizard loads seven.
 */
export function enemyAnimsFor(npc: string): readonly string[] {
  const anims = new Set<string>(ENEMY_BASE_ANIMS);
  for (const spec of ENEMY_SPECS) {
    if (spec.npc !== npc) continue;
    for (const mv of Object.values(spec.moves)) {
      if (mv && typeof mv === "object" && "anim" in mv && mv.anim) {
        anims.add(mv.anim);
      }
    }
  }
  return [...anims];
}

/**
 * Every `(npc, anim)` pair the cabinet will ever ask the CDN for.
 *
 * Read by the dev assertion in `SunflowerBrawlerGame` and by the docs' preload
 * table — the point being that it is computed from the same source the loader
 * uses, so it cannot describe a different set than the one actually fetched.
 */
export const ENEMY_SHEET_PLAN: readonly { npc: string; anims: readonly string[] }[] =
  ENEMY_NPCS.map((npc) => ({ npc, anims: enemyAnimsFor(npc) }));

/**
 * The distinct NPCs an enemy can wear, bosses included.
 *
 * The cabinet preloads *per wave* rather than this list, so a wave never pays
 * for characters it is not about — but this is what the lobby's "every enemy
 * the game can field" count and the docs read from.
 */
export const DISTINCT_ENEMY_NPCS: number = new Set(ENEMY_NPCS).size;

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
 * Fifteen waves, three blocks, a boss closing each.
 *
 * Read the spawn lists as a *curve* rather than as fifteen separate fights:
 * each block opens small, introduces one new enemy, and closes on its heaviest
 * mix before the boss. That is what makes block 2 feel harder than block 1
 * without any individual wave in it being harder than the wave 4 it mirrors.
 */
export const WAVES: readonly WaveSpec[] = [
  // ── Block 1 — goblins ───────────────────────────────────────────────────
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
    name: "PICKPOCKETS",
    subtitle: "GOLD TOOTH IS WORKING THE CROWD",
    spawns: [
      { id: "goldtooth", count: 2 },
      { id: "goblinSneak", count: 2 },
      { id: "goblinBrute", count: 1 },
    ],
  },
  {
    name: "GOLD RUSH",
    subtitle: "GRIMTOOTH WANTS IT ALL",
    spawns: [
      { id: "goldtooth", count: 3 },
      { id: "grimtooth", count: 1 },
      { id: "goblinScout", count: 2 },
    ],
  },
  {
    name: "GUNTER",
    subtitle: "HE HAS BEEN WAITING FOR THIS",
    spawns: [{ id: "gunter", count: 1 }],
  },

  // ── Block 2 — the undead ────────────────────────────────────────────────
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
    name: "DEAD CREW",
    subtitle: "SOMETHING IS FOLLOWING YOU",
    spawns: [
      { id: "phantomFace", count: 2 },
      { id: "skeleton", count: 2 },
      { id: "zombie", count: 1 },
    ],
  },
  {
    name: "THE FOUNDRY",
    subtitle: "SOMEONE IS ARMING THEM",
    spawns: [
      { id: "skeleton", count: 2 },
      { id: "zombie", count: 1 },
      { id: "dreadhorn", count: 1 },
    ],
  },
  {
    name: "GILDA",
    subtitle: "SHE WILL NOT LET YOU LEAVE",
    spawns: [{ id: "gilda", count: 1 }],
  },

  // ── Block 3 — elites ────────────────────────────────────────────────────
  {
    name: "ELDRIC'S GUARD",
    subtitle: "THE KNIGHT KEEPS THE LINE",
    spawns: [
      { id: "eldric", count: 2 },
      { id: "skeleton", count: 2 },
      { id: "dreadhorn", count: 1 },
    ],
  },
  {
    name: "THE WIZARD",
    subtitle: "HE IS NOT FIGHTING YOU FAIR",
    spawns: [
      { id: "wizard", count: 1 },
      { id: "banshee", count: 2 },
      { id: "zombie", count: 1 },
    ],
  },
  {
    name: "THE CHAMPION",
    subtitle: "CHUN LONG WANTS THE STREET",
    spawns: [
      { id: "chunLong", count: 1 },
      { id: "eldric", count: 2 },
      { id: "dreadhorn", count: 1 },
    ],
  },
  {
    name: "THE FORGE",
    subtitle: "BRING THE HAMMER",
    spawns: [
      { id: "blacksmith", count: 1 },
      { id: "chunLong", count: 2 },
      { id: "eldric", count: 1 },
      { id: "zombie", count: 1 },
    ],
  },
  {
    name: "GORGA",
    subtitle: "SOMETHING OLD IS AWAKE",
    spawns: [
      { id: "gorga", count: 1 },
      { id: "grimtooth", count: 1 },
    ],
  },
];

export const WAVE_COUNT = WAVES.length;

/** Score for clearing a wave, on top of the kills in it. */
export const WAVE_CLEAR_SCORE = 400;

/** Score for clearing the final boss, awarded once, on top of the wave clear. */
export const FINALE_BONUS_SCORE = 2500;

/**
 * Which wave *spec* a wave index plays.
 *
 * Identity for the finite run. Past wave 15 it wraps through **all fifteen
 * waves**, so endless replays the whole run — every wave and all three bosses —
 * with the escalation compounding on each pass. Replaying from wave 6 instead
 * was tried and is worse: it drops Gorga entirely, because Gorga *is* wave 15,
 * so the run's final boss never appears again and the loop loses the punctuation
 * that makes a boss wave feel different from an ordinary one.
 *
 * Starting at wave 1 rather than skipping the goblins is deliberate too. A
 * player who has reached endless has long since learned what a goblin is, and
 * the early waves are the shortest — so the loop stays fast through its first
 * lap and gets slower only as `endlessHpScale` compounds.
 */
export const waveIndexToSpec = (waveIndex: number): number => {
  if (waveIndex < WAVE_COUNT) return waveIndex;
  return (waveIndex - WAVE_COUNT) % WAVE_COUNT;
};

/** Which endless loop (0-based) a wave index belongs to. */
export const endlessLoop = (waveIndex: number): number =>
  waveIndex < WAVE_COUNT ? 0 : Math.floor((waveIndex - WAVE_COUNT) / WAVE_COUNT);

/** The wave a wave index plays, resolved. */
export const getWaveSpec = (waveIndex: number): WaveSpec =>
  WAVES[waveIndexToSpec(waveIndex)];

// ── Escalation ───────────────────────────────────────────────────────────────

/**
 * Health multiplier for a wave index, applied on top of the difficulty band.
 *
 * +6 % per wave, so wave 15 is 1.84× wave 1. Linear rather than exponential on
 * purpose: an exponential ramp turns wave 14 into a wall of health that reads
 * as a bug, while a linear one keeps every individual fight winnable and lets
 * the *combination* of more enemies and worse specials do the late work.
 */
export const waveHpScale = (waveIndex: number): number =>
  1 + Math.min(waveIndex, WAVE_COUNT - 1) * 0.06;

/**
 * Speed multiplier for a wave index.
 *
 * +1.2 % per wave and then capped, because enemy speed is the one stat where
 * more is actively worse: past about 15 % above a grunt's base the AI stops
 * being something you read and starts being something that happens to you. The
 * cap holds the hardest wave's grunts near that line.
 */
export const waveSpeedScale = (waveIndex: number): number =>
  1 + Math.min(waveIndex, WAVE_COUNT - 1) * 0.012;

/**
 * Escalation for one endless loop.
 *
 * Every loop adds 35 % health and 6 % speed, compounding with `waveHpScale`, so
 * loop 2 of the replayed waves is meaningfully above the same wave on the first
 * pass and loop 4 is a genuine slog. Health compounds faster than speed for the
 * reason above: an endless run should get *harder to finish*, not *harder to
 * stand in*.
 */
export const endlessHpScale = (waveIndex: number): number =>
  Math.pow(1.35, endlessLoop(waveIndex));

export const endlessSpeedScale = (waveIndex: number): number =>
  1 + endlessLoop(waveIndex) * 0.06;

/**
 * Total health multiplier for a wave: difficulty band × wave × endless loop.
 *
 * The three are separate on purpose. The band is "which difficulty did you
 * pick", the wave is "how far in are you", and the loop is "how many times have
 * you been round" — three different questions a designer asks, so three
 * different numbers rather than one souped constant.
 */
export const waveHpMultiplier = (
  waveIndex: number,
  bandHpMultiplier: number,
): number => bandHpMultiplier * waveHpScale(waveIndex) * endlessHpScale(waveIndex);

/** Total speed multiplier for a wave, to the same shape as `waveHpMultiplier`. */
export const waveSpeedMultiplier = (
  waveIndex: number,
  bandSpeed: number,
): number => bandSpeed * waveSpeedScale(waveIndex) * endlessSpeedScale(waveIndex);