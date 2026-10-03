import arcadeTilesheet from "../../assets/nightshade-arcade-tilesheet.png";

/**
 * The level: a five-screen street with a **depth plane** under it.
 *
 * ## Two axes, not one
 *
 * This cabinet is a side-scrolling beat 'em up, not a fighter, so an actor
 * occupies `(x, z)` rather than a single line. `x` runs along the street (and
 * the camera scrolls with it); `z` runs *into* the picture, and `zToY` is the
 * only place the two are related: screen Y is `Z_TOP_Y + z`, linearly, with no
 * perspective foreshortening. A flat ramp is deliberate — a projection would
 * make the far end of the plane squashed and the collision maths would stop
 * agreeing with what the player can see.
 *
 * `z` is what the whole game is fought over. An attack is resolved with
 * `|a.z − b.z| ≤ zReach`, so stepping *up* or *down* with the d-pad is the
 * dodge, and matching the enemy's line is the precondition for hitting back.
 * That is the replacement for the jump-that-was-the-only-block the fighting
 * game had: the escape is now a reposition along a plane you can see, not a
 * timing window you have to guess.
 *
 * ## The level is five screens, one per wave
 *
 * `LEVEL_W = 5 × STAGE_W`, and each screen owns one wave (see `enemies.ts`).
 * The camera locks to `zoneCamX(waveIndex)` for the length of a wave and
 * releases afterwards, which is the whole gating mechanism: the player walks
 * right until the camera stops, the wave spawns, and the next screen only
 * opens when the last enemy is down.
 *
 * ## Composed once, blitted every frame
 *
 * `nightshade-arcade-tilesheet.png` is committed with the repo (it is the same
 * sheet Goblin Invaders blits its arena from), but it ships no pre-built
 * street and the `.tsx` tileset the Tiled maps reference is not in the repo
 * either — so there is no map to render. The level is laid out by hand out of
 * pixel regions of that sheet: a stall row for the backdrop, grass for the
 * floor, a dirt road cutting across the middle of the walk band as a depth
 * cue, and tree clumps framing it.
 *
 * Composing 3200×360 is a few thousand blits, which is nothing next to a frame
 * budget but would re-decode the tilesheet every frame if done per frame.
 * `loadStage` resolves to a canvas that is then just `drawImage`d through a
 * camera offset, and the module-level cache means a rematch costs nothing.
 */

/** Viewport size. The canvas and the camera window are both this. */
export const STAGE_W = 640;
export const STAGE_H = 360;

/** World width. One screen per wave — see `WAVES` in `enemies.ts`. */
export const LEVEL_W = 3200;

/** Bottom of the backdrop. Above it is sky; below it is walkable ground. */
export const GROUND_TOP = 204;

/**
 * How far the depth plane runs, in stage pixels — and therefore in `z` units,
 * because `zToY` is 1:1.
 *
 * 134 px against a 360 px stage is a little over two body-heights (a fighter's
 * collision box is 66 tall), which is the right order: deep enough that two
 * actors on different lines read as genuinely separated, shallow enough that
 * the whole band stays on screen without the camera ever needing to tilt.
 */
export const Z_MAX = 134;

/** Screen Y of an actor's feet when `z = 0` — the far edge of the plane. */
export const Z_TOP_Y = 210;

/** Feet Y for a `z`. The one projection this game makes. */
export const zToY = (z: number): number => Z_TOP_Y + z;

/** Inverse of `zToY`, clamped to the walkable band. */
export const yToZ = (y: number): number =>
  Math.max(0, Math.min(Z_MAX, y - Z_TOP_Y));

/**
 * How far apart in `z` two actors may be and still interact.
 *
 * Attacks use their own `zReach` (see `fighters.ts`); this is the softer
 * number used for body collision — a shoulder-barge, not a sword.
 */
export const DEPTH_TOUCH = 22;

/** How far an actor may be pushed into either screen edge of the camera. */
export const WALL_X = 44;

/** Camera X for a wave. Wave `n` owns screen `n`. */
export const zoneCamX = (zone: number): number => zone * STAGE_W;

/** [x, y, width, height] in tilesheet pixels. */
type Rect = readonly [number, number, number, number];

/**
 * One market stall per faction colour, bottom-aligned to the ground.
 *
 * These bounds are **measured off the sheet**, not eyeballed. Each row of the
 * sheet holds exactly one self-contained building per colour, and every one of
 * them occupies `x 288..463` (176 wide) × 112 tall, pitched 128 apart starting
 * at `y 144`. Slicing a different window does not crop the art, it *splices*
 * it: the original `x = 320` chopped the side rack off the left edge, left a
 * hole of sky in the middle of every join, and stitched 24 px of the
 * neighbouring tower on to the right — which is what read as pieces being in
 * the wrong place.
 */
const STALLS: readonly Rect[] = [
  [288, 272, 176, 112], // green
  [288, 400, 176, 112], // orange
  [288, 528, 176, 112], // red
  [288, 656, 176, 112], // purple
];

/** Stall width, used to pitch the row across the whole level. */
const STALL_W = 176;

/**
 * Where the stall row starts.
 *
 * −32 rather than 0 so the row is offset from the screen edge and a scroll
 * does not restart on a building seam; four screens later the pattern has
 * drifted through all four colours twice.
 */
const STALL_X0 = -32;

/**
 * The treeline that frames the market row.
 *
 * This is the grove cluster's own bounding box, so every edge is art rather
 * than a crop line — the previous rect (`848,32,64,114`) began inside a gap
 * between two clusters and ended half way through a third.
 */
const TREE: Rect = [851, 16, 122, 130];

/** Top of the treeline. Its trunks sit behind the stall row and never show. */
const TREE_Y = 44;

/** Pitch of the grove clumps along the street. */
const TREE_PITCH = 440;

const GRASS_PLAIN: Rect = [16, 48, 16, 16];
const GRASS_DETAIL: Rect = [16, 32, 16, 16];
const DIRT: Rect = [320, 128, 16, 16];

/**
 * Grid rows of the floor drawn as dirt rather than grass.
 *
 * The floor is tiled from `GROUND_TOP` in 16 px rows, so these are literally
 * rows of that loop: `252..300` cuts a road across the **middle** of the walk
 * band (z 42..90) and `348` is the apron along the very bottom. The road is
 * the depth cue the plane otherwise lacks — moving up or down crosses a visible
 * edge, so a player can tell which line they are on without reading the gap
 * between two sprites.
 */
const DIRT_ROWS: ReadonlySet<number> = new Set([252, 268, 284, 348]);

/** The shadow the stalls, trees and actors all sit against. */
const GROUND_SHADOW = "rgb(30, 70, 36)";

/**
 * A handful of fixed stars, so the sky has texture without a random seed that
 * would reshuffle every time the cache is rebuilt.
 *
 * Deterministic on purpose: `[a, b]` are coefficients of a cheap hash over the
 * index, giving x in `0..STAGE_W` and y in `0..GROUND_TOP`.
 */
const STARS: readonly (readonly [number, number])[] = Array.from(
  { length: 46 },
  (_, index) => {
    const a = (Math.imul(index + 1, 1103515245) >>> 8) % 1000;
    const b = (Math.imul(index + 1, 12345) >>> 6) % 1000;
    return [(a / 1000) * STAGE_W, (b / 1000) * (GROUND_TOP - 24)] as const;
  },
);

let cached: Promise<HTMLCanvasElement | null> | null = null;

const blit = (
  ctx: CanvasRenderingContext2D,
  sheet: HTMLImageElement,
  rect: Rect,
  dx: number,
  dy: number,
): void => {
  ctx.drawImage(sheet, rect[0], rect[1], rect[2], rect[3], dx, dy, rect[2], rect[3]);
};

/**
 * Compose the whole street.
 *
 * @param sheet the tilesheet, already decoded.
 */
export const composeStage = (
  sheet: HTMLImageElement,
): HTMLCanvasElement | null => {
  if (sheet.naturalWidth === 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = LEVEL_W;
  canvas.height = STAGE_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Image smoothing off, or the 16px tiles come back as bilinear mush the
  // moment the browser scales the canvas up to fill its slot.
  ctx.imageSmoothingEnabled = false;

  // ── Sky: a dusk gradient, the one thing on the street the sheet has no tile
  // for. Everything an actor can stand on or collide with is pixels. ─────────
  //
  // The ramp turns *down* again at the roofline. The stall art is a Tiled
  // tileset: individual roof and wall cells are transparent, and a gradient
  // that kept brightening toward the ground made every one of them a patch of
  // open sky punched straight through the building — brighter than the sky
  // above it, which is what made the row read as unassembled. Taking the same
  // hue *darker* instead turns those cells into shadowed interior, so the
  // houses read solid. The turn is spread from the roofline to the ground and
  // keeps the sky's colour temperature, so there is no horizon to give it away.
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_TOP);
  sky.addColorStop(0, "rgb(18, 16, 44)");
  sky.addColorStop(0.5, "rgb(44, 33, 78)");
  sky.addColorStop(0.575, "rgb(40, 30, 70)");
  sky.addColorStop(0.72, "rgb(24, 18, 46)");
  sky.addColorStop(1, "rgb(16, 12, 30)");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, LEVEL_W, GROUND_TOP);

  // Stars, drawn over the gradient but under everything else. Fixed points, so
  // the sky does not crawl when the camera pans.
  ctx.fillStyle = "rgba(226, 224, 255, 0.55)";
  for (const [sx, sy] of STARS) ctx.fillRect(Math.round(sx), Math.round(sy), 1, 1);

  // ── Framing: the treeline, behind everything man-made. Drawn first so the
  // stall row can hide the trunks and leave only canopy over the roofline. ──
  for (let x = -60; x < LEVEL_W; x += TREE_PITCH) {
    blit(ctx, sheet, TREE, x, TREE_Y);
  }

  // ── Backdrop: the stall row, bottom-aligned to the ground, repeated the
  // whole length of the street so no screen ever opens on empty sky. ─────────
  const stallCount = Math.ceil((LEVEL_W - STALL_X0) / STALL_W) + 1;
  for (let index = 0; index < stallCount; index++) {
    const rect = STALLS[index % STALLS.length];
    blit(ctx, sheet, rect, STALL_X0 + index * STALL_W, GROUND_TOP - rect[3]);
  }

  // ── Floor: grass, seeded so the flowers do not land in a visible grid, with
  // the dirt road and apron swapped in on their own rows. ────────────────────
  for (let gy = GROUND_TOP; gy < STAGE_H; gy += 16) {
    const dirt = DIRT_ROWS.has(gy);
    for (let gx = 0; gx < LEVEL_W; gx += 16) {
      if (dirt) {
        blit(ctx, sheet, DIRT, gx, gy);
        continue;
      }
      const seed = gx / 16 + gy / 16;
      blit(ctx, sheet, seed % 7 === 3 ? GRASS_DETAIL : GRASS_PLAIN, gx, gy);
    }
  }

  // Drawn last so it cuts the stall feet into one clean line — two separate
  // sprite edges otherwise read as two different floors.
  ctx.fillStyle = GROUND_SHADOW;
  ctx.fillRect(0, GROUND_TOP - 4, LEVEL_W, 4);

  return canvas;
};

/**
 * The level, composed once per session.
 *
 * Resolves with `null` if the tilesheet never arrives; the caller falls back
 * to a flat fill rather than blocking a cabinet on an image.
 */
export const loadStage = (): Promise<HTMLCanvasElement | null> => {
  if (cached) return cached;

  cached = new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(composeStage(image));
    image.onerror = () => resolve(null);
    image.src = arcadeTilesheet;
  });

  return cached;
};
