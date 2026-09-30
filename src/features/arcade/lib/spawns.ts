import type { Coordinates } from "../types";

export const getNightshadeArcadeSpawn = (): Coordinates => {
  const randomXOffset = Math.random() * 49; // 263 - 214 = 49
  const randomYOffset = Math.random() * 20; // 470 - 450 = 20

  return {
    x: 214 + randomXOffset,
    y: 450 + randomYOffset,
  };
};

/**
 * Just to the left of the south-east staircase, turned to face left — back
 * into the room, away from the steps. The body spans x 327–337 against the
 * stair warp trigger (x 344–376, y 208–240), so arriving cannot send the
 * player straight back upstairs. Mirrors the `nightshade-arcade-basement`
 * entry in the world `SPAWNS`.
 */
export const getNightshadeBasementSpawn = (): Coordinates => ({
  x: 332,
  y: 224,
  facing: "left",
});
