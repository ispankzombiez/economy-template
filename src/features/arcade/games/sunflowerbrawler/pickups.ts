import roastVeggies from "../../assets/food_roast_veggies.png";
import ravenCoin from "../../assets/RavenCoin.webp";

/**
 * Pickups: the things an enemy leaves behind when it dies.
 *
 * ## Why a beat 'em up needs these
 *
 * A beat 'em up is a resource game wearing a costume. The health bar is the
 * real difficulty curve — a wave is not "can you kill four goblins" but "can
 * you kill four goblins with the health you walked in with". Without anything
 * to recover, a run is decided by the first mistake and the rest of it is
 * walking to the end.
 *
 * So pickups exist to make a bad wave survivable rather than to reward a good
 * one. They are the reason the player can afford to take a hit they should not
 * have taken.
 *
 * ## Two types, and the choice between them is the point
 *
 * `health` and `magic` are not two flavours of the same thing — they are the
 * two things a player is short of, and which one you are short of depends on
 * how the fight is going:
 *
 * * **Health** is the panic button, and it is drawn as **food** — a plate of
 *   roast vegetables, copied out of the main game's own `assets/food` folder.
 *   That is the genre's shorthand and it reads instantly at 38 px: a plate of
 *   food means "eat this to get better", where a heart or a flower means
 *   "abstract resource". Food and a coin are also the two things a player
 *   already recognises from the main game, so the pickup needs no explanation.
 * * **Magic** compounds, and it is drawn as a **Raven Coin** — the same sprite
 *   the cabinet already uses for its reward. The meter is built from damage
 *   dealt and kills, so a cast is funded by playing well; banking a coin lets
 *   you enter the next wave with the spell already charged.
 *
 * Which one drops is decided by what the player actually needs at the moment of
 * the drop (see `rollPickup`), so the pickup is a small reward for reading the
 * fight rather than a lottery.
 *
 * ## They live on the plane
 *
 * A pickup is positioned in `(x, z)` like any actor, bobs on its own `z`, and
 * is picked up within `PICKUP_REACH_X` × `PICKUP_REACH_Z`. That last part is
 * the important one: **stepping onto a pickup's line is how you collect it.**
 * It keeps the depth axis paying off outside of combat too, and it means a
 * health drop under your feet is not something you get for free while
 * retreating along `x`.
 *
 * ## Why the art is copied in rather than fetched
 *
 * The main game's `food/` folder is **not** published on the arcade's asset CDN
 * — `food/roast_veggies.png` and its siblings all 404 there, while
 * `icons/`, `decorations/` and `npcs/` resolve fine. Only the main game's own
 * build serves them. So `roast_veggies.png` is committed here (448 bytes,
 * following the committed-arcade-art precedent `RavenCoin.webp` already sets),
 * and the Raven Coin is referenced from the file this cabinet was already
 * importing for its own reward UI.
 */

export type PickupKind = "health" | "magic";

export type Pickup = {
  kind: PickupKind;
  x: number;
  z: number;
  /** Frozen at spawn so the bob is per-pickup rather than in lockstep. */
  bobPhase: number;
};

/** Source image per kind. */
export const PICKUP_ART: Readonly<Record<PickupKind, string>> = {
  health: roastVeggies,
  magic: ravenCoin,
};

/**
 * A drop does not expire. There is no lifetime, no timer and no fade.
 *
 * It used to: 14 s, then 32 s with the last four blinking. Both were wrong, and
 * for the same reason — **a clock has no idea what the player is doing.** The
 * interesting part of a fight is not the first kill, it is the moment you have
 * spent the meter, taken a hit and backed off to reposition. A drop on a timer
 * dies during exactly that pause, and it dies *quietly enough* that the player
 * reads it as the game forgetting to spawn it rather than as a decision.
 *
 * Worse, a timer punishes the player for playing well. Backing off to let a wave
 * thin out is the correct read of a crowd, and it is precisely what a countdown
 * punishes.
 *
 * ## So what removes a drop
 *
 * Only two things, and both are the player's own doing:
 *
 *  1. **Collecting it.**
 *  2. **Walking far enough past it that it leaves the frame** — see
 *     {@link PICKUP_DESPAWN_PAD}. The street scrolls one way and the player
 *     always walks forward, so "out of frame" is overwhelmingly *behind* them:
 *     a drop is dropped once the player has genuinely moved on from it.
 *
 * Nothing else. No wave clear, no timer, no distance-to-nearest-enemy. A drop
 * the player can see is a drop the player can go and get, however long ago the
 * goblin that dropped it stopped breathing.
 */
export const PICKUP_DESPAWN_PAD = 170;

/**
 * Has this drop been left behind?
 *
 * Measured against the **camera**, not the player, because "out of frame" is a
 * statement about what is on screen. The pad is wider than the arena margin
 * enemies may stand in (`ARENA_PAD` is 150), which is the important part: an
 * enemy can be killed while still off-screen at the moment of dying, and a drop
 * that vanished the instant it was born would be a kill that paid nothing for
 * reasons the player never sees. 170 keeps a drop alive while it is anywhere an
 * enemy could plausibly be, and retires it once the camera has genuinely left it
 * behind.
 */
export function pickupIsBehind(
  pickup: Pickup,
  camX: number,
  viewWidth: number,
): boolean {
  return (
    pickup.x < camX - PICKUP_DESPAWN_PAD ||
    pickup.x > camX + viewWidth + PICKUP_DESPAWN_PAD
  );
}

/**
 * `x` distance within which the player collects a drop.
 *
 * 52. A drop now lasts as long as the player wants it to, so the generosity
 * belongs in the *reach* rather than in the lifetime: a player who sees one and
 * walks over to it should not whiff on the last few pixels.
 */
export const PICKUP_REACH_X = 52;

/**
 * `z` distance within which the player collects a drop.
 *
 * 30 against a 26-wide reach for an attack — so a drop is very slightly more
 * forgiving to collect than a swing is to land with. Deliberate: the swing is a
 * commitment you have to aim, the pickup is a thing you walk over.
 */
export const PICKUP_REACH_Z = 30;

/** Peak height of the bob, stage pixels. */
const BOB_AMOUNT = 7;

/** Milliseconds per full bob cycle. */
const BOB_PERIOD = 1100;

/**
 * Health restored.
 *
 * 30 against a 90–120 health pool is a quarter to a third of a bar: enough to
 * turn a mistake into a setback rather than the end of a run, small enough that
 * it is not a substitute for not getting hit.
 */
export const HEALTH_PICKUP_AMOUNT = 30;

/**
 * Magic restored.
 *
 * A third of the meter, and deliberately *not* a full cast: a pickup should
 * top you up, not hand you a free screen-wide hit.
 */
export const MAGIC_PICKUP_AMOUNT = 34;

/** Score awarded for collecting anything at all. */
export const PICKUP_SCORE = 50;

/**
 * Which drop a kill produces.
 *
 * Weighted by need rather than uniformly random, and the need is read at the
 * moment of the drop:
 *
 * * Hurt and nearly out of meter → health. Nearly dead is the only state where
 *   health is unambiguously the right answer.
 * * Healthy with an empty meter → magic, because the spell is the tool that
 *   turns a bad position into a good one.
 * * Full on both → a coin flip, so a wave that was fought well still pays out
 *   something even though neither resource was short.
 *
 * Returns `null` for a kill that drops nothing, which is the common case: see
 * `dropChance` on each enemy in `enemies.ts`.
 */
export const rollPickup = ({
  hpPct,
  magicPct,
  random,
}: {
  /** Player health as a fraction of maximum, 0–1. */
  hpPct: number;
  /** Player magic as a fraction of the meter ceiling, 0–1. */
  magicPct: number;
  random: () => number;
}): PickupKind | null => {
  if (hpPct < 0.4) return "health";
  if (magicPct < 0.34) return "magic";
  return random() < 0.5 ? "health" : "magic";
};

/** Vertical offset of a pickup's art, so it hovers over its shadow. */
export const pickupBobY = (pickup: Pickup, elapsedMs: number): number =>
  -(
    Math.sin(((elapsedMs + pickup.bobPhase) / BOB_PERIOD) * Math.PI * 2) * BOB_AMOUNT +
    BOB_AMOUNT
  );

/**
 * Draw size of a pickup's art, stage pixels.
 *
 * A third of a fighter's height. Small enough not to be an obstacle you walk
 * around, big enough to be picked out of a crowd of seven — which is the whole
 * job, since a drop the player cannot see is a drop that looks like the game
 * forgot to spawn it.
 *
 * Worth noting the main game's food sprites are *tiny* — the roast vegetables
 * are 12×11 — so this is a ~3.5× upscale of the source. It stays crisp only
 * because `renderMatch` sets `imageSmoothingEnabled = false` for the frame;
 * smoothed, a 12 px sprite blown up to 38 reads as a smudge rather than a
 * plate of food.
 */
export const PICKUP_SIZE = 38;