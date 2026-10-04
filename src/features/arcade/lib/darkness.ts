import Phaser from "phaser";

/** Radius, in world px, that is lit at full brightness. A floor tile is 16px. */
const LIT_RADIUS = 32;
/**
 * Radius, in world px, at which the light has faded into full darkness.
 *
 * The gap between the two is the gradient's whole ramp, and it doubles as the
 * anti-banding budget: the ramp is painted one alpha step per world pixel and
 * the room is magnified 3-4x on screen, so a narrow ramp bands into visible
 * rings. A wide one spends fewer alpha levels on each pixel and reads as a
 * smooth pool instead.
 */
const FADE_RADIUS = 72;

/**
 * Colour of the unlit room. Near black rather than black, to keep a trace of
 * the purple this floor was already lit with. The lit half of the light is
 * that same colour at zero alpha — it is transparency, not a colour, that
 * makes the room visible again.
 */
const DARKNESS_LIT = "rgba(5, 3, 11, 0)";
const DARKNESS_DARK = "rgba(5, 3, 11, 1)";

/**
 * Above every tile and sprite in the room (sprites sort on their own `y`, so
 * under ~1000) and below the touch joystick, which `ArcadeTiledScene` parks at
 * a billion so it stays on top of everything including this.
 */
const DARKNESS_DEPTH = 900_000;

/** A pool of light that can be carried around the room. */
export type Lantern = {
  /** Keeps the light on whatever is holding it. Call once per frame. */
  follow: (x: number, y: number) => void;
};

/**
 * Puts the room in the dark and hands back the light to carry around in it.
 *
 * It is one quad. The darkness is deliberately *not* a rectangle with a hole
 * punched in it: by the time anything could cut a hole, the dark has already
 * been mixed into the frame along with the room under it, and cutting into that
 * only fades the dark rather than bringing the room back. So the light belongs
 * to the covering itself — a single square of near-black with a soft-edged
 * circle of transparency at its middle, centred on the player. Alpha does the
 * rest (transparent where the room should be seen, opaque everywhere else),
 * which needs no blend mode and behaves the same in WebGL and in Canvas.
 *
 * It is sized in world px, so the light is the same handful of tiles across at
 * any camera zoom, and moving it is a single `setPosition` per frame.
 *
 * `start` is where the light begins. It is placed before the first `update`
 * runs, so the room never flashes with a pool of light at the world origin.
 */
export const createLantern = (
  scene: Phaser.Scene,
  start?: { x: number; y: number },
): Lantern => {
  const key = falloff(scene);

  const darkness = scene.add.image(start?.x ?? 0, start?.y ?? 0, key);
  darkness.setDepth(DARKNESS_DEPTH);

  return {
    follow: (x, y) => darkness.setPosition(x, y),
  };
};

/**
 * Draws the darkness, with its hole, and returns the texture key.
 *
 * The square is twice the viewport wide because it is centred on the player
 * rather than on the camera, and the player can be at either edge of what the
 * camera shows: the far side of the viewport is a whole view away, and the
 * light needs its own radius on top of that to fade out. Nothing past the
 * gradient is anything but opaque, so all of that extra width is only ever off
 * screen.
 *
 * Painted once and then left alone — textures belong to the game rather than
 * the scene, so coming back down the stairs finds this already here.
 */
const falloff = (scene: Phaser.Scene) => {
  const camera = scene.cameras.main;
  const viewWidth = camera.width / camera.zoom;
  const viewHeight = camera.height / camera.zoom;
  const width = Math.ceil(viewWidth * 2 + FADE_RADIUS * 2);
  const height = Math.ceil(viewHeight * 2 + FADE_RADIUS * 2);
  const key = `arcade-lantern-${width}x${height}`;

  if (scene.textures.exists(key)) return key;

  const texture = scene.textures.createCanvas(key, width, height);
  if (!texture) return key;

  const context = texture.getContext();
  const gradient = context.createRadialGradient(
    width / 2,
    height / 2,
    0,
    width / 2,
    height / 2,
    FADE_RADIUS,
  );

  // Stops as a fraction of the light's radius: see-through through the lit
  // radius, then the ramp out to full dark.
  gradient.addColorStop(0, DARKNESS_LIT);
  gradient.addColorStop(LIT_RADIUS / FADE_RADIUS, DARKNESS_LIT);
  gradient.addColorStop(1, DARKNESS_DARK);

  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  texture.refresh();
  // The game runs with `pixelArt: true`, which would otherwise leave the rim
  // of the light a staircase of blocks instead of a curve.
  texture.setFilter(Phaser.Textures.FilterMode.LINEAR);

  return key;
};