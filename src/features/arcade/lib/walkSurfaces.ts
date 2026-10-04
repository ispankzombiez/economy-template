import type { Footsteps } from "example-assets/sound-effects/soundEffects";

/**
 * Footsteps follow the ground, not the room.
 *
 * Both arcade floors draw their floor as a stack of named Tiled layers — a
 * stone `floors` base, `carpet*` runners over it, and (upstairs) `Grass` and
 * `dirt` outside — so what the player is standing on is readable from which
 * layer covers their feet. That keeps the decision in data rather than in a
 * per-scene constant, so a floor can mix carpet and stone without being split
 * into one scene per surface.
 */

/** What the player's feet are on. */
export type WalkSurface = "grass" | "carpet" | "stone" | "wood";

/**
 * Tiled layer name -> the surface that layer is made of.
 *
 * Only layers that actually cover the floor appear here. Anything missing is
 * treated as "not ground" and looked straight through, which is what we want
 * for `walls`, `machines`, `tables`, `fence`, `goldcoins` and `water` — those
 * sit above the floor in the draw order, so they would otherwise mask whatever
 * the player is really standing on.
 *
 * The two floors share this table because they share layer names (`floors`,
 * `carpet and stairs`, `walls`). A floor that introduces a new ground layer
 * needs a row here, or it will fall back to the scene's default step.
 *
 * Note `carpet and stairs` is mapped wholesale to carpet. The stair treads in
 * that layer are stone, but separating them would need a per-tile-index table
 * inside the layer rather than one row per layer.
 */
export const SURFACE_BY_LAYER: Record<string, WalkSurface> = {
  Grass: "grass",
  dirt: "grass",
  floors: "stone",
  "carpet 2": "carpet",
  "carpet 3": "carpet",
  "carpet and stairs": "carpet",
};

/**
 * Surface -> the footstep loop that plays on it.
 *
 * The available loops are `dirt_footstep`, `wood_footstep` and `sand_footstep`
 * (see `SOUNDS.footsteps`) — there is no stone or carpet recording, so:
 *
 * - `grass` and `carpet` share `dirt_footstep`, the soft "Soil" loop. It is
 *   the closest thing to grass, and a hard footstep under a carpet reads wrong.
 * - `stone` falls back to `wood_footstep` per the fallback agreed for it. It is
 *   the "House" loop, so indoors it is not a bad stand-in.
 *
 * To give stone its own voice, add a `stone_footstep` entry to
 * `SOUNDS.footsteps` (soundEffects.ts), load it in the Preloader next to the
 * other two, widen the `Footsteps` union, and point `stone` at it here. Nothing
 * else needs to change.
 */
export const FOOTSTEP_BY_SURFACE: Record<WalkSurface, Footsteps> = {
  grass: "dirt_footstep",
  carpet: "dirt_footstep",
  stone: "wood_footstep",
  wood: "wood_footstep",
};