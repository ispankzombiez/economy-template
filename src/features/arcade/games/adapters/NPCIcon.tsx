import React, { useEffect, useRef, useState } from "react";
import type { Equipped } from "features/game/types/bumpkin";
import { tokenUriBuilder } from "lib/utils/tokenUriBuilder";
import { getAnimationApiBase } from "lib/portal/url";

/** One frame of the bumpkin idle/walk spritesheet. */
const FRAME_W = 96;
const FRAME_H = 64;

/**
 * Stand-in for `features/island/bumpkin/components/NPC` (absent from this
 * template), used for the player portrait in Frogger, Goblin Invaders and
 * Pac-Man.
 *
 * The original rendered the bumpkin from the animation CDN — same URL this
 * builds from `tokenUriBuilder(parts)` — and the sheet's first frame (the
 * still pose) is drawn onto a canvas so only one frame shows instead of the
 * whole strip.
 */
export const NPCIcon: React.FC<{
  parts: Equipped;
  width: number;
  className?: string;
}> = ({ parts, width, className }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );

  const tokenParts = tokenUriBuilder(parts);
  const src = `${getAnimationApiBase()}/animate/0_v1_${tokenParts}/idle_walking_dig_drilling`;

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

    image.onload = () => {
      canvas.width = width;
      canvas.height = width;
      ctx.clearRect(0, 0, width, width);
      ctx.imageSmoothingEnabled = false;

      // Letterbox the 96x64 frame into the square box so the bumpkin is never
      // cropped horizontally.
      const scale = Math.min(width / FRAME_W, width / FRAME_H);
      const drawWidth = FRAME_W * scale;
      const drawHeight = FRAME_H * scale;

      ctx.drawImage(
        image,
        0,
        0,
        FRAME_W,
        FRAME_H,
        (width - drawWidth) / 2,
        (width - drawHeight) / 2,
        drawWidth,
        drawHeight,
      );
      setStatus("ready");
    };

    image.onerror = () => setStatus("error");
    image.src = src;

    return () => {
      image.onload = null;
      image.onerror = null;
    };
  }, [src, tokenParts, width]);

  if (status === "error") {
    return <div className={className} style={{ width, height: width }} />;
  }

  return (
    <canvas
      ref={canvasRef}
      aria-label="bumpkin"
      className={className}
      style={{
        width,
        height: width,
        imageRendering: "pixelated",
        display: "block",
      }}
    />
  );
};
