import React from "react";
import { InnerPanel } from "components/ui/Panel";
import { Label } from "components/ui/Label";

/**
 * In-game "are you sure?" box.
 *
 * Replaces `window.confirm`, which is unusable here: the arcade runs in a
 * cross-origin iframe inside the Sunflower Land host page, and a native dialog
 * raised from that frame is auto-dismissed — the call returns `false` without
 * the player ever seeing it, so the button behind it silently does nothing.
 *
 * Styled like the rest of the cabinet UI (and like the Play Ticket prompt in
 * `rewardRun.tsx`) so the two confirmations feel like one system.
 */
export const ConfirmPanel: React.FC<{
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ title, body, confirmLabel, onConfirm, onCancel }) => (
  <InnerPanel className="bg-yellow-100 p-4 text-center">
    <Label className="block text-sm font-bold text-gray-800">{title}</Label>
    <div className="mt-2 text-xs text-gray-700">{body}</div>
    <div className="mt-3 flex flex-col gap-2">
      <button
        onClick={onConfirm}
        className="w-full px-4 py-3 rounded-lg font-bold text-sm bg-red-500 text-white hover:bg-red-600 active:scale-95 transition-all shadow-lg"
      >
        {confirmLabel}
      </button>
      <button
        onClick={onCancel}
        className="w-full px-4 py-2 rounded-lg font-semibold text-sm bg-gray-400 text-white hover:bg-gray-500 active:scale-95 transition-all"
      >
        CLOSE
      </button>
    </div>
  </InnerPanel>
);
