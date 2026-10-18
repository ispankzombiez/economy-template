import React from "react";
import { RoundButton } from "components/ui/RoundButton";
import { PIXEL_SCALE } from "lib/constants";
import { useSound } from "lib/utils/hooks/useSound";
import settingsIcon from "../assets/settings.png";

/**
 * The arcade's settings button.
 *
 * Uses the same `RoundButton` chrome as the other HUD buttons, so it reads as
 * part of that set rather than a new control.
 *
 * Uses the main game's `icons/settings.png` (local copy) so it matches the HUD
 * gear players already know.
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
      <img
        src={settingsIcon}
        alt="Settings"
        className="absolute group-active:translate-y-[2px]"
        style={{
          top: `${PIXEL_SCALE * 4}px`,
          left: `${PIXEL_SCALE * 4}px`,
          width: `${PIXEL_SCALE * 14}px`,
        }}
      />
    </RoundButton>
  );
};