import React from "react";
import { SUNNYSIDE } from "example-assets/sunnyside";
import { RoundButton } from "components/ui/RoundButton";
import { PIXEL_SCALE } from "lib/constants";
import { useSound } from "lib/utils/hooks/useSound";

/**
 * The arcade's settings button.
 *
 * Uses the same `RoundButton` chrome as the other HUD buttons, so it reads as
 * part of that set rather than a new control.
 *
 * ## Why the gear is drawn rather than imported
 *
 * The main game has an `icons/settings.png`, and reusing it was the obvious move
 * — but that path 404s on the testnet-assets CDN the arcade loads from, so the
 * button rendered with a broken image. The CDN carries only the small icon set
 * `example-assets/sunnyside` declares; `hammer`, `basket`, `confirm` and friends
 * resolve, `settings` does not.
 *
 * The sibling `images` repo (`@sl-assets`) is the supported place to add art, but
 * it is not present on every machine that builds this, and a button is not worth a
 * build that fails without it. So the gear is a three-line inline SVG: it needs no
 * asset, cannot 404, and stays crisp at any `PIXEL_SCALE`. Dropping in a real PNG
 * later is a one-line change here.
 */
export const ArcadeSettingsButton: React.FC<{
  onClick: () => void;
  className?: string;
}> = ({ onClick, className }) => {
  const button = useSound("button");

  return (
    <RoundButton
      onClick={() => {
        button.play();
        onClick();
      }}
      className={className}
    >
      {/* Sized like every other HUD glyph: 12 grid squares inside the 22px button. */}
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        className="absolute group-active:translate-y-[2px]"
        style={{
          top: `${PIXEL_SCALE * 5}px`,
          left: `${PIXEL_SCALE * 5}px`,
          width: `${PIXEL_SCALE * 12}px`,
          height: `${PIXEL_SCALE * 12}px`,
        }}
      >
        {/* Two horizontal sliders — the conventional settings mark, and legible
            at this size where a toothed gear would turn to mush. */}
        <g
          stroke="#4a2f3a"
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
        >
          <line x1="3" y1="8" x2="21" y2="8" />
          <line x1="3" y1="16" x2="21" y2="16" />
        </g>
        <g fill="#4a2f3a">
          <circle cx="9" cy="8" r="3.2" />
          <circle cx="16" cy="16" r="3.2" />
        </g>
      </svg>
    </RoundButton>
  );
};