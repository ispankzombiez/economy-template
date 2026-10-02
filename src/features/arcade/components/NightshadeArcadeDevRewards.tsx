import React, { useCallback, useEffect, useState } from "react";
import { Button } from "components/ui/Button";
import { useMinigameSession } from "lib/portal";
import {
  cancelReward,
  fetchAllRewards,
  queueReward,
  type PayoutButton,
  type RewardRequest,
} from "../lib/rewardsApi";

const formatter = new Intl.NumberFormat();

type Feedback = { tone: "good" | "bad"; text: string } | null;

/**
 * The owner's side of the reward list: queue one, watch what is outstanding,
 * cancel what has not been taken.
 *
 * ## Colours
 *
 * Dark text on the light `Panel`, matching every other panel in the arcade
 * (`Inventory`, `Settings`, the shop). It used to be amber-on-dark for the chest
 * popup this component never rendered in — light text on a pale pixel panel is
 * close to unreadable, which is exactly how it looked.
 *
 * Only ever mounted from the settings panel's `developer` page, which itself only
 * renders for a Dev Key holder. Mounting is not the protection though — the worker
 * re-checks the key on every write and answers `403` regardless of what this
 * component believes. See `ArcadeSettingsPanel`.
 */
export const NightshadeArcadeDevRewards: React.FC<{
  payoutButtons: PayoutButton[];
}> = ({ payoutButtons }) => {
  const { jwt } = useMinigameSession();

  const [farmIdInput, setFarmIdInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [selectedAction, setSelectedAction] = useState<string>("");

  const [requests, setRequests] = useState<RewardRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  const refresh = useCallback(async () => {
    if (!jwt) return;
    const result = await fetchAllRewards(jwt);
    if (result.ok) setRequests(result.value.requests);
    // A failed read is deliberately silent: this is a background list, and the
    // write below reports its own failures. `queueReward` is the path that must
    // never look like it worked when it did not.
  }, [jwt]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Default to the first published button so the common case is two fields and a
  // click rather than three.
  useEffect(() => {
    if (selectedAction || payoutButtons.length === 0) return;
    setSelectedAction(payoutButtons[0].actionId);
  }, [payoutButtons, selectedAction]);

  const submit = async () => {
    if (!jwt || busy) return;

    const farmId = Number(farmIdInput.trim());
    if (!Number.isFinite(farmId) || farmId <= 0) {
      setFeedback({ tone: "bad", text: "Enter the player's farm number." });
      return;
    }
    if (!selectedAction) {
      setFeedback({ tone: "bad", text: "Pick a reward to send." });
      return;
    }

    setBusy(true);
    setFeedback(null);

    const result = await queueReward(jwt, {
      farmId,
      actionId: selectedAction,
      label: labelInput,
      note: noteInput,
    });

    if (!result.ok) {
      setFeedback({ tone: "bad", text: result.error });
      setBusy(false);
      return;
    }

    // The worker's read of the button, passed on rather than swallowed. Its most
    // important warning is a `requireAbsent` naming a marker the action never
    // mints, which turns a one-off reward into an unlimited faucet.
    const warnings = result.value.warnings ?? [];
    setFeedback(
      warnings.length > 0
        ? {
            tone: "bad",
            text: `Queued, but check the button: ${warnings.join(" ")}`,
          }
        : { tone: "good", text: "Reward queued." },
    );

    setFarmIdInput("");
    setLabelInput("");
    setNoteInput("");
    setBusy(false);
    void refresh();
  };

  const remove = async (id: string) => {
    if (!jwt || busy) return;
    setBusy(true);
    const result = await cancelReward(jwt, id);
    setBusy(false);
    if (!result.ok) {
      setFeedback({ tone: "bad", text: result.error });
      return;
    }
    void refresh();
  };

  const outstanding = requests.filter((entry) => !entry.claimedAt);
  const settled = requests.filter((entry) => entry.claimedAt);

  const inputClass =
    "mt-1 w-full rounded border border-[#7a4b52]/40 bg-white/70 p-2 text-sm text-[#3e2731]";

  return (
    <div className="rounded border border-[#7a4b52]/30 bg-white/30 p-3">
      <h3 className="text-xs font-semibold text-black">Dev: Send a reward</h3>

      {payoutButtons.length === 0 ? (
        <p className="mt-1 text-[11px] leading-relaxed text-black">
          No <code>Payout-*</code> actions are published, so there is nothing to
          send. Publish one in the Economy Editor first — it needs a{" "}
          <code>requireAbsent</code> naming a marker token it also mints, or it
          will not be one-use.
        </p>
      ) : (
        <>
          <label className="mt-2 block text-xs text-black">
            Farm number
            <input
              type="text"
              inputMode="numeric"
              value={farmIdInput}
              onChange={(e) => setFarmIdInput(e.target.value)}
              placeholder="1128976301583508"
              className={inputClass}
            />
          </label>

          <label className="mt-2 block text-xs text-black">
            Reward
            <select
              value={selectedAction}
              onChange={(e) => setSelectedAction(e.target.value)}
              className={inputClass}
            >
              {payoutButtons.map((button) => (
                <option key={button.actionId} value={button.actionId}>
                  {button.label || button.actionId}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-2 block text-xs text-black">
            Title <span className="opacity-60">(optional)</span>
            <input
              type="text"
              value={labelInput}
              onChange={(e) => setLabelInput(e.target.value)}
              placeholder="Stream reward"
              className={inputClass}
            />
          </label>

          <label className="mt-2 block text-xs text-black">
            Message <span className="opacity-60">(optional)</span>
            <input
              type="text"
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              placeholder="Thanks for Tuesday's stream"
              className={inputClass}
            />
          </label>

          <p className="mt-2 text-[11px] leading-relaxed text-black">
            Sending to <strong>farm {farmIdInput || "…"}</strong>. The player
            claims it themselves from their own rewards list — nothing is credited
            until they do.
          </p>

          <div className="mt-3">
            <Button disabled={busy} onClick={() => void submit()}>
              {busy ? "Sending…" : "Queue reward"}
            </Button>
          </div>
        </>
      )}

      {feedback ? (
        <p
          className={`mt-2 text-xs ${
            feedback.tone === "good" ? "text-green-800" : "text-red-800"
          }`}
        >
          {feedback.text}
        </p>
      ) : null}

      <div className="mt-4 border-t border-[#7a4b52]/25 pt-2">
        <h4 className="text-[11px] font-semibold text-black">
          Outstanding ({outstanding.length})
        </h4>
        {outstanding.length === 0 ? (
          <p className="mt-1 text-[11px] text-black opacity-70">Nothing queued.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {outstanding.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center justify-between gap-2 text-[11px] text-black"
              >
                <span className="min-w-0 truncate">
                  <strong>{formatter.format(entry.farmId)}</strong>{" "}
                  {entry.label || entry.actionId}
                </span>
                <button
                  type="button"
                  className="shrink-0 cursor-pointer text-red-800 underline"
                  onClick={() => void remove(entry.id)}
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )}

        {settled.length > 0 ? (
          <>
            <h4 className="mt-3 text-[11px] font-semibold text-black opacity-70">
              Claimed ({settled.length})
            </h4>
            <ul className="mt-1 space-y-1">
              {settled.slice(0, 5).map((entry) => (
                <li key={entry.id} className="text-[11px] text-black opacity-60">
                  <strong>{formatter.format(entry.farmId)}</strong>{" "}
                  {entry.label || entry.actionId}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
};