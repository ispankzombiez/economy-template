import React from "react";
import { Button } from "components/ui/Button";
import { Modal } from "components/ui/Modal";

export type ArcadeNotice = {
  title: string;
  body: string;
  /** `good` for a reward, `bad` for a refusal. Drives the heading colour. */
  tone?: "good" | "bad";
};

/**
 * The arcade's one-at-a-time popup.
 *
 * Used for feedback the player asked for directly - opening a chest and finding
 * out whether today's Play Ticket was still there. It is deliberately modal and
 * single-button: the chest is a physical click in the world, so the answer has to
 * be something they cannot miss and cannot get out of sync with.
 *
 * One question per dialog. It used to accept arbitrary extra content, which is
 * how the developer Play Ticket mint ended up sharing this dialog with the daily
 * chest — so a developer checking the ticket also got a mint form, and the dialog
 * had two jobs. The developer tools are under Settings → Developer now.
 *
 * `children` is the one exception, and the reason it is not the old mistake: it
 * is a **read-only** part of the same answer, never a second action. The chest
 * uses it for the leaderboard that belongs to the "the pots are empty" message —
 * showing the scoreboard is what makes that message land, and splitting it into a
 * second dialog would put two popups where the arcade has one. Nothing here may
 * dispatch an action or hold a form.
 *
 * ## OK is the only way out
 *
 * `Modal` dismisses on a backdrop click, but only when it is handed an `onHide`.
 * This one is deliberately not: the chest's answer is the payoff of a hidden,
 * unadvertised mechanic, several of which are taunts, and a player who
 * accidentally dismisses one loses the message and the leaderboard with no way
 * to get it back. So a stray click on the dark backdrop does nothing, and the
 * player has to press OK on the panel itself.
 *
 * That is the whole reason the button exists. It is not decoration, and it is
 * the only interactive element in this dialog — do not add another.
 *
 * The world still runs underneath, so `NightshadeArcadeApp` also ignores chest
 * clicks while this is open: otherwise a click landing on a chest behind the
 * modal could swap one message for another mid-read.
 */
export const NightshadeArcadeNotice: React.FC<{
  notice: ArcadeNotice | null;
  onClose: () => void;
  children?: React.ReactNode;
}> = ({ notice, onClose, children }) => (
  // No `onHide`: that is what makes the backdrop inert. See the note above.
  <Modal show={notice !== null}>
    <div className="w-full max-w-sm max-h-[80vh] overflow-y-auto rounded bg-[#1f1529] p-4 text-white">
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
      {children}
      <div className="mt-4">
        <Button onClick={onClose}>OK</Button>
      </div>
    </div>
  </Modal>
);
