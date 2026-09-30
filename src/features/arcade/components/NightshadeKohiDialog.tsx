import React, { useEffect } from "react";
import { SpeakingModal, type Message } from "features/game/components/SpeakingModal";
import { PIXEL_SCALE } from "lib/constants";
import kohiDialogImage from "features/arcade/assets/kohi-dialog-image.webp";

/**
 * Kohi's lines — one word, at the real Kohi's request. Single message, no
 * actions, so a tap closes the panel straight after it types out.
 */
const KOHI_DIALOGUE: Message[] = [{ text: "feet" }];

/**
 * Kohi's NPC dialog.
 *
 * The panel itself is the main game's {@link SpeakingModal} untouched — same
 * typing effect, same "Tap to continue", same tap/Enter/Space/Escape handling —
 * wrapped exactly the way the main game's `Modal` wraps it (`relative
 * w-full max-w-[500px]`) and portraited in the slot the main game reserves for
 * an NPC portrait (`Panel`'s `bumpkinParts`: `top: -61px`, `left: -8px`,
 * `width: 100px`, all in `PIXEL_SCALE`, painted behind the panel).
 *
 * Kohi has his own art rather than a bumpkin, so `kohi-dialog-image.webp` is
 * rendered in that slot instead of `DynamicNFT`.
 */
export const NightshadeKohiDialog: React.FC<{ onClose: () => void }> = ({
  onClose,
}) => {
  // The main game's Modal closes on Escape; SpeakingModal treats it as a tap,
  // so both are registered there too — this one wins by unmounting the panel.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="relative w-full max-w-[500px]">
      <div
        className="absolute pointer-events-none"
        style={{
          zIndex: -10,
          top: `${PIXEL_SCALE * -61}px`,
          left: `${PIXEL_SCALE * -8}px`,
          width: `${PIXEL_SCALE * 100}px`,
        }}
      >
        <img
          src={kohiDialogImage}
          alt="Kohi"
          className="w-full"
          style={{ imageRendering: "pixelated" }}
        />
      </div>

      <SpeakingModal onClose={onClose} message={KOHI_DIALOGUE} />
    </div>
  );
};
