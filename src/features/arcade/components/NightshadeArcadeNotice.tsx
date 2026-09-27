import React from "react";
import { Button } from "components/ui/Button";
import { Modal } from "components/ui/Modal";

export type ArcadeNotice = {
  title: string;
  body: string;
  /** `good` for a reward, `bad` for a refusal. Drives the heading colour. */
  tone?: "good" | "bad";
};

type NightshadeArcadeNoticeProps = {
  notice: ArcadeNotice | null;
  onClose: () => void;
};

/**
 * The arcade's one-at-a-time popup.
 *
 * Used for feedback the player asked for directly - opening a chest and finding
 * out whether today's Play Ticket was still there. It is deliberately modal and
 * single-button: the chest is a physical click in the world, so the answer has to
 * be something they cannot miss and cannot get out of sync with.
 */
export const NightshadeArcadeNotice: React.FC<NightshadeArcadeNoticeProps> = ({
  notice,
  onClose,
}) => (
  <Modal show={notice !== null} onHide={onClose}>
    <div className="w-full max-w-sm rounded bg-[#1f1529] p-4 text-white">
      <h2
        className={`text-sm font-semibold ${
          notice?.tone === "bad" ? "text-red-300" : "text-[#8fe3a0]"
        }`}
      >
        {notice?.title}
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-[#dfc7f1]">
        {notice?.body}
      </p>
      <div className="mt-4">
        <Button onClick={onClose}>OK</Button>
      </div>
    </div>
  </Modal>
);
