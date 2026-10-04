import React from "react";
import { RoundButton } from "components/ui/RoundButton";
import { PIXEL_SCALE } from "lib/constants";
import { useSound } from "lib/utils/hooks/useSound";
import settingsGear from "../assets/settings_gear.png";

/**
 * The arcade's settings button.
 *
 * Uses the same `RoundButton` chrome as the other HUD buttons, so it reads as
 * part of that set rather than a new control.
 *
 * ## Why the gear lives in `features/arcade/assets`
 *
 * The main game has an `icons/settings.png`, and reusing it was the obvious move
 * — but that path 404s on the testnet-assets CDN the arcade loads from, so the
 * button would render with a broken image. The CDN carries only the small icon set
 * `example-assets/sunnyside` declares; `hammer`, `basket`, `confirm` and friends
 * resolve, `settings` does not.
 *
 * The sibling `images` repo (`@sl-assets`) is the usual home for art, but it is
 * not installed on every machine that builds this, and a button is not worth a
 * build that fails without it. So the gear is a local asset next to the arcade's
 * other images (`RavenCoin.webp`, `flower_token.webp`) — committed with the
 * feature, and independent of both the CDN and `@sl-assets`.
 *
 * This replaces a hand-drawn inline SVG that used two sliders, on the reasoning
 * that a toothed gear would be illegible at 12 grid squares. At the size this
 * actually renders that proved untrue; the PNG reads fine, so the real art wins.
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
      {/* Sized like every other HUD glyph: 12 grid squares inside the 22px button.
          Both axes are pinned and the box is square, so a non-square source is
          letterboxed by `objectFit` instead of skewing off-centre. */}
      <img
        src={settingsGear}
        alt="Settings"
        className="absolute group-active:translate-y-[2px]"
        style={{
          top: `${PIXEL_SCALE * 5}px`,
          left: `${PIXEL_SCALE * 5}px`,
          width: `${PIXEL_SCALE * 12}px`,
          height: `${PIXEL_SCALE * 12}px`,
          objectFit: "contain",
          imageRendering: "pixelated",
        }}
      />
    </RoundButton>
  );
};