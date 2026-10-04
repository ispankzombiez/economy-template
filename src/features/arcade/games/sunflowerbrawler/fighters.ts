import { NPC_WEARABLES } from "lib/npcs";
import { tokenUriBuilder, type BumpkinParts } from "lib/utils/tokenUriBuilder";
import { getAnimationApiBase } from "lib/portal/url";
import { DEPTH_TOUCH } from "./stage";

/**
 * The roster, the moves, and the spritesheets behind them.
 *
 * ## Why these four
 *
 * `NPC_WEARABLES` already dresses one champion per faction — Barlow (Bumpkin),
 * Graxle (Goblin), Nyx (Nightshade), Reginald (Sunflorian). Each one wears the
 * faction's Crown, Armor, Sword, Shield, Medallion and Quiver, so all four read
 * as the same species of fighter wearing different colours, which is exactly
 * what a roster wants: the silhouettes stay legible and the difference between
 * them is decided by numbers rather than by who is bigger on screen.
 *
 * ## Why the moves are frame data rather than art
 *
 * Every fighter animates out of the same CDN cycles — the animation API has
 * one vocabulary regardless of outfit, so `attack` *is* Barlow's sword swing
 * and Graxle's axe swing depending only on whose sheet it was requested for.
 * What makes the four feel different therefore cannot live in the art; it
 * lives in **when** in a cycle the hit lands, how much it costs, and how far
 * the victim is thrown.
 *
 * Each move records the sheet frame its hit connects on (`impact`) and the
 * playback rate (`fps`) of the cycle. Together those give the two numbers a
 * player actually feels: startup (how long before it connects) and total (how
 * long until you can act again). Nothing is hand-entered in milliseconds, so
 * retuning a move means changing a frame number and the timings follow.
 *
 * ## Two buttons, and the second one is a resource
 *
 * The cabinet has **one** attack button and **one** magic button — the fighting
 * game's four-button ranged/smash system is gone with the genre. `Space` swings
 * through a fixed three-hit string; `X` spends the magic meter on a hit that
 * resolves against **every** enemy on screen regardless of `z`. That is the
 * only thing in the game that ignores the depth axis, which is what makes it
 * worth saving for: it is the answer to being surrounded, and being surrounded
 * is the normal state of a beat 'em up.
 */

/** One frame of a bumpkin spritesheet. */
export const FRAME_W = 96;
export const FRAME_H = 64;

/**
 * Frame counts per CDN cycle, measured across all four roster tokens.
 *
 * These are stable — the animation API ships the same counts for every outfit
 * — so a move can name its frames without fetching the sheet first. Anything
 * missing here falls back to 1 frame rather than throwing, because a wrong
 * frame number draws a still fighter and a thrown one draws no game at all.
 */
export const ANIM_FRAMES: Readonly<Record<string, number>> = {
  idle: 9,
  walking: 8,
  run: 8,
  jump: 9,
  hurt: 8,
  death: 13,
  attack: 10,
  axe: 10,
  mining: 10,
  hammering: 23,
  casting: 15,
  roll: 10,
};

/**
 * The three swings of the single attack string, in order, plus the magic.
 *
 * There is no light/heavy pair any more: `combo1 → combo2 → combo3` runs on
 * one button and wraps. The string exists so that pressing the same button is
 * not the same input three times — the third swing is slower, reaches further
 * and throws much harder, so a player learns to *finish* the string rather than
 * restart it, and the enemy's approach timing changes accordingly.
 *
 * `magic` is separate: it is not part of the string, it costs meter, and it is
 * the only move whose hitbox ignores depth.
 */
export type MoveKind = "combo1" | "combo2" | "combo3" | "magic";

/** The three swings, in the order the string plays them. */
export const COMBO: readonly MoveKind[] = ["combo1", "combo2", "combo3"];

export type MoveSpec = {
  /** CDN cycle this move plays. */
  anim: string;
  /** Inclusive frame range of that cycle. */
  from: number;
  to: number;
  /** Playback rate for this move only. */
  fps: number;
  /** Absolute frame of `anim` the hit connects on. */
  impact: number;
  damage: number;
  /** Milliseconds the victim spends unable to act. */
  hitstunMs: number;
  /**
   * Stage pixels from the fighter's centre to the far edge of the hitbox.
   *
   * The hitbox runs from **10 px behind** the attacker to `reach` in front
   * (see `swingConnects`), so its total length is `reach + 10`.
   *
   * Champions are given a deliberate **reach advantage** over the common
   * street: a champion's opening hit lands 74–82 px out against a grunt's
   * 60–66 and a heavy's 68–84. Two reasons, and the second is the one that
   * matters:
   *
   * * A whiffed swing in a brawler is the single most frustrating thing that can
   *   happen, and it is disproportionately a *spacing* problem — the player is
   *   usually a few pixels short while reading a crowd, not a few frames early.
   *   Widening the front buys back the margin that reading costs. All twelve
   *   combos were widened by the same **+12 px**, which keeps their relative
   *   ordering (and therefore each champion's identity) intact.
   * * It is what makes the answer to a crowd "get closer", not "get closer and
   *   also hope". Without the advantage, the safe play against a heavy is to
   *   stay outside its reach — which is also outside the player's, so the answer
   *   becomes "do not engage", and a beat 'em up where the correct answer is
   *   often not to fight is not a beat 'em up.
   *
   * The advantage is **not** total, and where it stops is the design. A
   * champion outranges every goblin, skeleton and mid-tier heavy, but loses it
   * to the three specialists whose whole identity is reach: the Wizard (jab 92,
   * special 138), the Blacksmith (heavy 104) and all three bosses (jab
   * 100–108, specials 110–132). So the answer to a wave-2 goblin is to walk in and
   * hit it, and the answer to the Wizard is not — which is what makes an enemy
   * roster readable rather than a stat sheet.
   *
   * The trade-off is still deliberate and worth stating: a player who holds
   * their range wins most exchanges against the common street. That is the
   * intended feel — champions are meant to feel like the strongest thing on it
   * (they also walk 228–250 px/s against a grunt's 142). What it costs is that a
   * single common enemy can no longer catch a player who keeps their distance,
   * so the pressure has to come from being hit from *two* sides at once, which is
   * exactly what the depth plane and `maxAttackers` are for.
   */
  reach: number;
  /** Stage pixels/second the victim is shoved along `x`. */
  knockback: number;
  /** Stage pixels/second the victim is shoved along `z` — the scatter. */
  knockZ: number;
  /** Stage pixels/second the attacker carries forward while swinging. */
  advance: number;
  /**
   * How far apart in `z` the hit still lands, defaulting to `DEPTH_TOUCH`.
   *
   * A swing is a horizontal band through the plane, so this is the width of
   * that band. The finishers run wider than the pokes, which is what makes the
   * third hit of a string harder to step out of than the first.
   */
  zReach?: number;
  /**
   * Set on magic. When true the move resolves against every living enemy on
   * screen and `reach` is not read at all.
   */
  screen?: boolean;
};

export const moveDurationMs = (move: MoveSpec): number =>
  ((move.to - move.from + 1) / move.fps) * 1000;

export const moveImpactMs = (move: MoveSpec): number =>
  ((move.impact - move.from) / move.fps) * 1000;

/** `z` band a move covers. */
export const moveZReach = (move: MoveSpec): number => move.zReach ?? DEPTH_TOUCH;

export type FighterId = "barlow" | "graxle" | "nyx" | "reginald";

export type FighterSpec = {
  id: FighterId;
  /** Key into `NPC_WEARABLES`, which is where the sheet's token comes from. */
  npc: string;
  /** Name shown on the health bar. */
  name: string;
  /** Faction line under the name. */
  faction: string;
  /** Accent colour for the health bar and lives pips. */
  color: string;
  maxHp: number;
  /** Stage pixels/second. */
  walkSpeed: number;
  /** Magic meter gained per point of damage dealt. */
  magicPerDamage: number;
  /** Magic meter gained per enemy killed. */
  magicPerKill: number;
  moves: Record<MoveKind, MoveSpec>;
};

/**
 * A shared shape for the string, re-typed per fighter.
 *
 * Only `anim`, `fps`, `impact`, `damage`, `reach`, `knockback`, `knockZ` and
 * `advance` move between champions; the frame *ranges* are the cycle's own
 * length, so a fighter cannot accidentally play past the end of a sheet.
 */
const string = (
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
  zReach?: number,
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

/** Magic: cast out of the `casting` cycle, resolves against the whole screen. */
const spell = (damage: number, knockback: number, knockZ: number): MoveSpec => ({
  anim: "casting",
  from: 0,
  to: 14,
  fps: 30,
  impact: 7,
  damage,
  hitstunMs: 520,
  reach: 0,
  knockback,
  knockZ,
  advance: 0,
  screen: true,
});

/**
 * The four faction champions, in roster order.
 *
 * Health is deliberately uneven (90–120) and speed runs 228–250, so picking a
 * champion is a real choice rather than a colour swap. The string differs in
 * the way a beat 'em up roster usually differs: Graxle is the fastest to
 * startup and the lightest hitter, Reginald is the slowest and the heaviest,
 * and the finisher's knockback is where most of the gap lives.
 */
/**
 * Champions move faster than everything else on the street.
 *
 * The roster's speeds (228–250) are up from 144–170 when the stage grew to
 * 960×540, and deliberately so. Enemies were **not** scaled with them: a grunt
 * still walks 142–172 px/s and a heavy 76–108, exactly as before. Every
 * champion is now the fastest thing on the plane by a wide margin, which is the
 * one thing that makes an outnumbered fight feel like a fight rather than a
 * queue.
 *
 * It also makes the depth plane worth using on its own. Repositioning costs no
 * health and no meter — only time — so a player who is losing can always buy
 * space by walking it, and the answer to a crowd is movement rather than
 * mashing. That is the whole design intent of the genre, and it only works if
 * the player's feet are quicker than the enemy's.
 *
 * The spread is kept narrow (228–250, a 10 % band) so the roster still differs
 * by feel: Graxle is the fastest thing in the game, Reginald the slowest of the
 * champions and still faster than any grunt.
 */
export const FIGHTERS: readonly FighterSpec[] = [
  {
    id: "barlow",
    npc: "barlow",
    name: "BARLOW",
    faction: "Bumpkin",
    color: "#f2c14e",
    maxHp: 110,
    walkSpeed: 232,
    magicPerDamage: 0.13,
    magicPerKill: 4,
    moves: {
      // Two quick sword taps and a hammer. The taps are deliberately
      // unremarkable — Barlow's identity is that his finisher is a hammer
      // blow, so the string reads as a wind-up into something.
      combo1: string("attack", 9, 26, 5, 11, 78, 260, 150, 40, 40, 28),
      combo2: string("attack", 9, 30, 5, 12, 82, 270, 190, 60, 60, 30),
      combo3: string("hammering", 22, 54, 19, 23, 90, 500, 480, 340, 90, 40),
      magic: spell(34, 520, 440),
    },
  },
  {
    id: "graxle",
    npc: "graxle",
    name: "GRAXLE",
    faction: "Goblin",
    color: "#7fd45a",
    maxHp: 120,
    walkSpeed: 250,
    magicPerDamage: 0.13,
    magicPerKill: 4,
    moves: {
      // Fastest string in the roster. The finisher is a mining lunge rather
      // than a heavy swing: it carries Graxle 340 px/s forward, so the third
      // hit is also how the goblin closes the distance it needs.
      combo1: string("axe", 9, 32, 5, 10, 76, 250, 140, 40, 50, 28),
      combo2: string("axe", 9, 34, 5, 11, 80, 260, 180, 60, 70, 30),
      combo3: string("mining", 9, 33, 5, 19, 88, 460, 440, 300, 340, 38),
      magic: spell(30, 540, 460),
    },
  },
  {
    id: "nyx",
    npc: "nyx",
    name: "NYX",
    faction: "Nightshade",
    color: "#b48bf0",
    maxHp: 90,
    walkSpeed: 244,
    magicPerDamage: 0.14,
    magicPerKill: 5,
    moves: {
      // Least health, fastest finisher. Nyx's third hit resolves in 250 ms —
      // quicker than Barlow's *first* — and throws the furthest in `z`, so the
      // play is to land three and let the scatter buy the next approach.
      combo1: string("attack", 9, 31, 5, 10, 74, 240, 130, 50, 40, 27),
      combo2: string("attack", 9, 33, 5, 11, 78, 250, 170, 70, 60, 29),
      combo3: string("mining", 9, 40, 5, 18, 86, 440, 460, 520, 180, 38),
      magic: spell(36, 500, 480),
    },
  },
  {
    id: "reginald",
    npc: "reginald",
    name: "REGINALD",
    faction: "Sunflorian",
    color: "#ff9b54",
    maxHp: 100,
    walkSpeed: 228,
    magicPerDamage: 0.13,
    magicPerKill: 4,
    moves: {
      // Slowest string and the hardest finisher. The two taps are already
      // slower than anyone else's whole second hit, so Reginald has to commit
      // to the string to get value out of it — which is the trade for 26
      // damage and a knockback that puts a heavy clean off its line.
      combo1: string("attack", 9, 24, 5, 12, 82, 280, 170, 40, 30, 29),
      combo2: string("axe", 9, 26, 5, 14, 86, 300, 220, 70, 50, 32),
      combo3: string("hammering", 22, 52, 19, 26, 94, 540, 560, 360, 70, 42),
      magic: spell(42, 560, 420),
    },
  },
];

export const getFighter = (id: FighterId): FighterSpec => {
  const found = FIGHTERS.find((fighter) => fighter.id === id);
  // The roster is a literal array of exactly these ids, so this cannot miss.
  if (!found) return FIGHTERS[0];
  return found;
};

/**
 * Cycles every sheet the cabinet can ask a *player* for.
 *
 * Kept as a fixed list rather than derived from the roster so loading a
 * champion costs one predictable batch of requests: the four attack cycles
 * plus the four states every actor shares.
 */
export const FIGHTER_ANIMS: readonly string[] = [
  "idle",
  "walking",
  "hurt",
  "death",
  "attack",
  "axe",
  "mining",
  "hammering",
  "casting",
];

/**
 * Cycles every sheet an *enemy* can ask for, across the whole roster.
 *
 * **Do not preload from this.** It is the union, so using it per NPC fetches
 * `casting` and `hammering` for a goblin that will never cast, and — worse — it
 * is a *second* list to keep in step with the moves, which is exactly how seven
 * NPCs ended up drawing a coloured box through every attack. Use
 * `enemyAnimsFor(npc)` in `enemies.ts`, which derives each character's set from
 * its own moves. Kept for the docs and for asserting nothing asks for a cycle
 * that does not exist.
 */
export const ENEMY_ANIMS: readonly string[] = [
  "idle",
  "walking",
  "hurt",
  "death",
  "attack",
  "axe",
  "mining",
  "hammering",
  "casting",
];

export type Sheets = Readonly<Record<string, HTMLImageElement>>;

/** Animation API base for the roster's spritesheets. */
const animateBase = (): string => `${getAnimationApiBase()}/animate`;

/**
 * The `0_v1_{parts}` token a character's sheets are published under.
 *
 * `NPC_WEARABLES` is keyed by the fixed NPC roster, but the engine asks for
 * sheets by a runtime `string`, so the lookup goes through an indexable view
 * and falls back to Barlow. An unknown name degrades to a default body rather
 * than a 404, the same way `loadImage` does.
 */
export const npcToken = (npc: string): string =>
  tokenUriBuilder(
    (NPC_WEARABLES as Readonly<Record<string, BumpkinParts>>)[npc] ??
      NPC_WEARABLES.barlow,
  );

export const npcSheetUrl = (npc: string, anim: string): string =>
  `${animateBase()}/0_v1_${npcToken(npc)}/${anim}`;

/**
 * Fetch one image, CORS-on so `getImageData` stays legal.
 *
 * Both CDNs answer `Access-Control-Allow-Origin: *`, and `crossOrigin` has to
 * be set **before** `src` — a canvas that drew an un-CORSed image is tainted
 * for good, and this game reads pixels (the level is measured once when it is
 * composed).
 */
export const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    // A missing sprite resolves to the element anyway: an image that never
    // loaded draws nothing, which degrades to an invisible actor rather than
    // a lobby that cannot start.
    image.onerror = () => resolve(image);
    image.src = src;
  });

/**
 * Load a set of cycles for one character.
 *
 * Resolves when all of them have settled — either loaded or failed — so a wave
 * never opens on a half-populated enemy.
 */
export const loadSheets = async (
  npc: string,
  anims: readonly string[] = FIGHTER_ANIMS,
): Promise<Sheets> => {
  const images = await Promise.all(
    anims.map(
      async (anim) =>
        [anim, await loadImage(npcSheetUrl(npc, anim))] as const,
    ),
  );

  return Object.fromEntries(images);
};
