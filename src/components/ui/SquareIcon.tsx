import React from "react";
import classNames from "classnames";
import { PIXEL_SCALE } from "lib/constants";

interface Props {
  icon: string;
  /** Inner box size in "game pixels"; rendered at `PIXEL_SCALE * width`. */
  width: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Square icon frame used by the arcade card games.
 *
 * The artwork is whatever URL the caller passes (crop icons come from the
 * image CDN), so the image is scaled on load to fit the inner box: small art
 * is upscaled by `PIXEL_SCALE`, oversized art is shrunk so it never overflows.
 *
 * Ported verbatim from the original arcade (`source-portal`
 * `src/components/ui/SquareIcon.tsx`) with only the `PIXEL_SCALE` import
 * re-pointed at this template's `lib/constants`.
 */
const getImage = (icon: string, iconWidth: number) => (
  <img
    src={icon}
    className="relative"
    alt="item"
    style={{ opacity: "0" }}
    onLoad={(e) => {
      const width = e.currentTarget?.naturalWidth;
      const height = e.currentTarget?.naturalHeight;
      if (!width || !height) return;

      const maxDimension = Math.max(width, height);
      let scale = 1;

      // Upscale art that is small enough to sit inside the frame at pixel scale.
      if (maxDimension <= iconWidth) {
        scale = PIXEL_SCALE;
      } else if (width < iconWidth * PIXEL_SCALE) {
        scale = (iconWidth * PIXEL_SCALE) / width;
      }

      // Taller-than-wide art is shrunk so height fits the square frame.
      if (maxDimension > iconWidth && height > width) {
        scale *= width / height;
      }

      e.currentTarget.style.transform = `scale(${scale})`;
      e.currentTarget.style.opacity = "1";
    }}
  />
);

export const SquareIcon: React.FC<Props> = ({
  icon,
  width,
  className,
  style,
}) => (
  <div
    className={classNames(
      "relative flex items-center justify-center overflow-hidden",
      className,
    )}
    style={{
      width: `${PIXEL_SCALE * width}px`,
      height: `${PIXEL_SCALE * width}px`,
      ...style,
    }}
  >
    {getImage(icon, width)}
  </div>
);
