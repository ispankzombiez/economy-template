import React, { useEffect, useRef, useState } from "react";
import type { Equipped } from "features/game/types/bumpkin";
import { tokenUriBuilder } from "lib/utils/tokenUriBuilder";
import { getAnimationApiBase } from "lib/portal/url";

/** One frame of a bumpkin spritesheet. */
const FRAME_W = 96;
const FRAME_H = 64;

/**
 * Frame rate, matching `BumpkinContainer` — the arcade floor's character — so
 * the in-game portraits move at the same speed as the character you walk around
 * as.
 */
const FRAME_RATE = 10;

/** Widest character aspect the portrait box is sized for, to be safe. */
const MAX_ASPECT = 1.75;

/**
 * A box to centre a portrait of this height in.
 *
 * The character's true width is measured at runtime (see below), so callers
 * cannot compute it themselves. This hands back a box guaranteed to be at least
 * as wide as the character will be, with the canvas centred inside it.
 */
export function bumpkinPortraitBox(height: number): {
  width: number;
  height: number;
} {
  return { width: Math.round(height * MAX_ASPECT), height };
}

/**
 * The character's bounding box, in frame-local coordinates, across every frame
 * of the sheet.
 *
 * **Measured per player, at load, from the sheet they actually loaded.**
 *
 * Two things make this necessary rather than a hardcoded constant:
 *
 *  1. A 96x64 frame is mostly padding - the character sits in a small box in the
 *     middle, with the rest reserved so any hat, tool or wings has room. That
 *     padding is why the bumpkin used to look so small: letterboxing the whole
 *     frame into the requested box drew the character at a fraction of it.
 *  2. The character box is not the same for every outfit, and not the same for
 *     every animation - the `dig` and `drilling` cycles reach much further out
 *     with the tool. A box tight enough to look big is a box that slices the hat
 *     off somebody.
 *
 * So each frame is measured on its own and the results unioned. Measuring the
 * sheet as one image instead is the trap: every 96px cell holds a character at
 * the same offset, so a whole-sheet scan reports a box as wide as the sheet.
 *
 * The horizontal box is then **re-centred on the character's own middle** rather
 * than taken as the raw union. A walk cycle sways, so its frames are not
 * symmetric about a common centre and the union sits slightly off to one side,
 * which shows up as a portrait that is not centred in its box. Centring on the
 * mean of the per-frame middles - then growing the box symmetrically until it
 * covers every frame - keeps the character centred *and* still never clips.
 */
function measureCharacterBox(
  image: HTMLImageElement,
): { x: number; y: number; w: number; h: number } | undefined {
  const frameCount = Math.floor(image.naturalWidth / FRAME_W);
  if (frameCount <= 0 || image.naturalHeight <= 0) return undefined;

  const offscreen = document.createElement("canvas");
  offscreen.width = FRAME_W;
  offscreen.height = FRAME_H;
  const ctx = offscreen.getContext("2d", { willReadFrequently: true });
  if (!ctx) return undefined;

  let minX = FRAME_W;
  let minY = FRAME_H;
  let maxX = -1;
  let maxY = -1;
  let centreSum = 0;
  let measured = 0;

  for (let frame = 0; frame < frameCount; frame++) {
    ctx.clearRect(0, 0, FRAME_W, FRAME_H);
    // Draw this one frame into a frame-sized canvas so the measurement is in
    // frame-local coordinates rather than sheet coordinates.
    ctx.drawImage(
      image,
      frame * FRAME_W,
      0,
      FRAME_W,
      FRAME_H,
      0,
      0,
      FRAME_W,
      FRAME_H,
    );

    let data: Uint8ClampedArray;
    try {
      data = ctx.getImageData(0, 0, FRAME_W, FRAME_H).data;
    } catch {
      return undefined;
    }

    let frameMinX = FRAME_W;
    let frameMaxX = -1;
    for (let y = 0; y < FRAME_H; y++) {
      for (let x = 0; x < FRAME_W; x++) {
        if (data[(y * FRAME_W + x) * 4 + 3] > 8) {
          if (x < frameMinX) frameMinX = x;
          if (x > frameMaxX) frameMaxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (frameMaxX < 0) continue;

    measured++;
    centreSum += (frameMinX + frameMaxX) / 2;
    if (frameMinX < minX) minX = frameMinX;
    if (frameMaxX > maxX) maxX = frameMaxX;
  }

  if (maxX < 0 || measured === 0) return undefined;

  const centre = centreSum / measured;
  // Grow a symmetric box about that centre until it covers every frame.
  const half = Math.max(centre - minX, maxX - centre);
  const x = Math.round(centre - half);
  const w = Math.round(half * 2) || 1;

  return { x, y: minY, w, h: maxY - minY + 1 };
}

/**
 * Stand-in for `features/island/bumpkin/components/NPC` (absent from this
 * template), used for the player portrait in Frogger, Goblin Invaders and
 * Bumpkin-Man.
 *
 * Loads the bumpkin from the animation CDN — the same per-action sheets
 * `BumpkinContainer` builds from `tokenUriBuilder(parts)`, so `idle` really is
 * the ambient loop and `walking` really is the walk cycle — and plays the whole
 * sheet at 10fps, so the portrait animates like the character on the arcade
 * floor instead of sitting there as one static frame.
 */
export const NPCIcon: React.FC<{
  parts: Equipped;
  /**
   * The character's visible height in pixels.
   *
   * The canvas comes out exactly this tall with the character filling it; its
   * width is measured from the sheet, so centre it in a box from
   * {@link bumpkinPortraitBox}.
   */
  height: number;
  /**
   * Which cycle to play. `idle` is the ambient loop, `walking` the walk cycle.
   * Defaults to `walking`, which is what these three movement games want.
   */
  animation?: "idle" | "walking";
  /**
   * Which way the character faces.
   *
   * The sheets only contain one facing, so turning is a horizontal flip - which
   * is exactly what `BumpkinContainer.faceLeft()` does on the arcade floor
   * (`setScale(-1, 1)`). Applied as a CSS transform so the canvas backing store
   * is untouched and the measured crop stays valid.
   */
  facing?: "left" | "right";
  className?: string;
}> = ({
  parts,
  height,
  animation = "walking",
  facing = "right",
  className,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  const tokenParts = tokenUriBuilder(parts);
  // Per-action sheet, not the combined strip: the strip concatenates
  // idle(9) + walking(8) + dig(13) + drilling(9), so playing a frame range out
  // of it means guessing where one animation stops and the next starts.
  const src = `${getAnimationApiBase()}/animate/0_v1_${tokenParts}/${animation}`;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tokenParts) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setStatus("error");
      return;
    }

    setStatus("loading");

    const image = new Image();
    image.crossOrigin = "anonymous";

    let raf = 0;

    image.onload = () => {
      const box = measureCharacterBox(image);
      // No measurable box (or a canvas tainted by a CORS change): fall back to
      // the whole frame, which is small but never wrong-looking.
      const crop = box ?? { x: 0, y: 0, w: FRAME_W, h: FRAME_H };

      const frameCount = Math.floor(image.naturalWidth / FRAME_W) || 1;
      const scale = height / crop.h;
      canvas.width = Math.max(1, Math.round(crop.w * scale));
      canvas.height = height;
      ctx.imageSmoothingEnabled = false;
      setStatus("ready");

      const startedAt = performance.now();
      const tick = (now: number) => {
        const index =
          Math.floor(((now - startedAt) / 1000) * FRAME_RATE) % frameCount;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(
          image,
          index * FRAME_W + crop.x,
          crop.y,
          crop.w,
          crop.h,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    image.onerror = () => setStatus("error");
    image.src = src;

    return () => {
      cancelAnimationFrame(raf);
      image.onload = null;
      image.onerror = null;
    };
  }, [src, tokenParts, height]);

  if (status === "error") {
    return <div className={className} style={{ width: "100%", height }} />;
  }

  return (
    <div
      className={className}
      style={{
        width: "100%",
        height,
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <canvas
        ref={canvasRef}
        aria-label="bumpkin"
        style={{
          imageRendering: "pixelated",
          display: "block",
          transform: facing === "left" ? "scaleX(-1)" : undefined,
        }}
      />
    </div>
  );
};
