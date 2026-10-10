import React, { useCallback, useEffect, useState } from "react";
import { Button } from "components/ui/Button";
import { Modal } from "components/ui/Modal";
import { Panel } from "components/ui/Panel";
import { useMinigameSession } from "lib/portal";
import {
  cancelReward,
  fetchAllRewards,
  forgetReward,
  queueReward,
  type PayoutButton,
  type RewardRequest,
} from "../lib/rewardsApi";

/**
 * How a farm id is printed.
 *
 * Plain digits, deliberately. `Intl.NumberFormat` groups them (`1,128,976,301,
 * 583,508`), and this is an **identifier** — the owner copies it straight into the
 * "send a reward" box to fill the form. A grouped number does not paste back as
 * the same value, so every reward the owner sends risks going to a farm that does
 * not exist.
 *
 * The number is long enough that grouping is genuinely easier to read on screen,
 * which is why this is a trade-off and not an oversight. Correctness of the copy
 * wins: the label above the field says to copy the digits.
 */
const farmIdText = (farmId: number): string => String(farmId);

/**
 * The owner's audit view: every claimed reward, with everything attached to it.
 *
 * ## Why this exists
 *
 * The inline `Claimed (5)` list answers "is anything moving". This panel answers
 * the question that actually needs answering weeks later: *did that payout really
 * go out, and to whom?* So every field the worker holds is on screen rather than a
 * summary line.
 *
 * ## What to read
 *
 * `Claimed` is when the player pressed the button. `Settled` is when the mint came
 * back confirmed. The two differ only in the failure case, and that difference is
 * the whole point:
 *
 *  - **both set** — the reward went out.
 *  - **claimed, not settled** — the call failed *ambiguously* (a 5xx, a timeout).
 *    The worker deliberately keeps the claim row in this state rather than
 *    releasing it, because the write may have landed. Treat it as "possibly paid"
 *    and check the player's balance before re-sending. The worker's refusal
 *    message is shown so the reason is on record.
 *  - **not claimed** — it has not been pressed. Should not appear here.
 *
 * That is why the worker exposes `settledAt` and `claimedDetail` at all: without
 * them a stuck claim is indistinguishable from a clean one, and a stuck claim is
 * the one case where re-sending would pay twice.
 *
 * Scoped to Dev Key holders by the page that mounts it, and re-checked by the
 * worker on every read — mounting is not the protection.
 */
const ClaimedHistory: React.FC<{
  entries: RewardRequest[];
  payoutButtons: PayoutButton[];
  onClose: () => void;
  /** Re-read after a removal, so the list does not need a manual reload. */
  onChanged: () => void;
}> = ({ entries, payoutButtons, onClose, onChanged }) => {
  const { jwt } = useMinigameSession();
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const labelFor = (actionId: string) =>
    payoutButtons.find((button) => button.actionId === actionId)?.label ??
    actionId;

  /**
   * The search box matches on the two things the owner actually looks something up
   * by — the unique id and the action id — plus the title and message, because a
   * half-remembered stream name is a reasonable thing to search for too.
   *
   * Case-insensitive substring matching on each field separately, rather than one
   * concatenated haystack: a query is looked for in one place at a time, so
   * "a query matching one field and not another" behaves the way a reader expects
   * rather than turning into an accidental AND.
   */
  const matches = (entry: RewardRequest, needle: string): boolean => {
    if (!needle) return true;
    const q = needle.toLowerCase();
    return (
      entry.id.toLowerCase().includes(q) ||
      entry.actionId.toLowerCase().includes(q) ||
      entry.label.toLowerCase().includes(q) ||
      entry.note.toLowerCase().includes(q) ||
      farmIdText(entry.farmId).includes(q)
    );
  };

  const visible = entries.filter((entry) => matches(entry, query.trim()));
  const unsettled = visible.filter((entry) => entry.claimedAt && !entry.settledAt);

  const forget = async (entry: RewardRequest) => {
    if (!jwt || busyId) return;
    setError(null);

    // An unsettled claim may or may not have paid out. The worker refuses to
    // delete one without an explicit override, so the owner confirms first —
    // having checked the balance — and the call is then sent with `force`.
    const stuck = Boolean(entry.claimedAt) && !entry.settledAt;
    if (stuck) {
      const confirmed = window.confirm(
        "This claim never settled, so the payout may or may not have gone out.\n\n" +
          "Check the player's balance first. Confirm to permanently remove this record anyway.",
      );
      if (!confirmed) return;
    }

    setBusyId(entry.id);
    const result = await forgetReward(jwt, entry.id, stuck);
    if (!result.ok) {
      setError(result.error);
      setBusyId(null);
      return;
    }

    setBusyId(null);
    onChanged();
  };

  const inputClass =
    "mt-1 w-full rounded border border-[#7a4b52]/40 bg-white/70 p-2 text-sm text-[#3e2731]";

  return (
    <Modal show onHide={onClose}>
      {/*
        Fills the viewport for the same reasons the settings panel does, and with
        the same two details: `100dvh` so a phone's browser chrome does not hide
        the bottom of a long list, and `[&>div]` because `Panel` puts `className`
        on the outer wrapper only — sizing that alone leaves the inner panel at its
        natural height and nothing actually fills.

        Stacking the search field above the scroll area rather than inside it is
        deliberate: an audit search that scrolls out of reach is useless, since the
        thing you are searching *for* is in the list you have scrolled.
      */}
      <Panel className="flex h-[calc(100dvh-1rem)] w-full max-w-none flex-col [&>div]:flex [&>div]:flex-col [&>div]:min-h-0 [&>div]:flex-1">
        <div className="flex min-h-0 flex-col p-3 text-[#3e2731]">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-bold">
              Claimed rewards ({entries.length})
            </div>
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer text-xs underline"
            >
              Close
            </button>
          </div>

          <label className="mt-2 block text-xs text-black">
            Search
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="id, action, title, message or farm number"
              className={inputClass}
            />
          </label>
          <p className="mt-1 text-[11px] text-black opacity-70">
            {query.trim()
              ? `${visible.length} of ${entries.length} shown.`
              : `Showing all ${entries.length}.`}
          </p>

          {/* Everything below the search scrolls, so the field stays put. */}
          <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-1">

          {error ? (
            <p className="mt-2 rounded border border-red-800/40 bg-red-50/60 p-2 text-[11px] leading-relaxed text-red-900">
              {error}
            </p>
          ) : null}

          {unsettled.length > 0 ? (
            <p className="mt-2 rounded border border-red-800/40 bg-red-50/60 p-2 text-[11px] leading-relaxed text-red-900">
              <strong>
                {unsettled.length} claim
                {unsettled.length === 1 ? "" : "s"} never settled.
              </strong>{" "}
              The player pressed the button but the mint was never confirmed, so it
              may or may not have gone out. Check their balance before sending
              anything again.
            </p>
          ) : null}

          {visible.length === 0 ? (
            <p className="mt-2 text-xs">
              {entries.length === 0
                ? "Nothing has been claimed yet."
                : "Nothing matches that search."}
            </p>
          ) : (
            <table className="mt-2 w-full border-collapse text-[11px]">
              <thead>
                <tr className="text-left">
                  {["Claimed (UTC)", "Player", "Farm", "Reward", "Title", "Queued (UTC)", "Sent by", ""].map((h) => (
                    <th key={h} className="sticky top-0 z-10 border border-[#7a4b52]/30 bg-white/40 px-2 py-1 font-bold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((entry) => {
                  const stuck = Boolean(entry.claimedAt) && !entry.settledAt;
                  return (
                    <tr key={entry.id} className={stuck ? "bg-red-50/50" : "bg-white/30"}>
                      <td className="border border-[#7a4b52]/25 px-2 py-1">
                        {entry.claimedAt ? plainTimestamp(entry.claimedAt) : "—"}
                      </td>
                      <td className="border border-[#7a4b52]/25 px-2 py-1">
                        {entry.claimedByUsername ? entry.claimedByUsername : entry.farmId}
                      </td>
                      <td className="border border-[#7a4b52]/25 px-2 py-1">{farmIdText(entry.farmId)}</td>
                      <td className="border border-[#7a4b52]/25 px-2 py-1">
                        <div>{labelFor(entry.actionId)}</div>
                        <div className="opacity-70">{entry.actionId}</div>
                      </td>
                      <td className="border border-[#7a4b52]/25 px-2 py-1">
                        <div>{entry.label || "—"}</div>
                        {entry.note ? <div className="opacity-70">{entry.note}</div> : null}
                      </td>
                      <td className="border border-[#7a4b52]/25 px-2 py-1">
                        {plainTimestamp(entry.createdAt)}
                      </td>
                      <td className="border border-[#7a4b52]/25 px-2 py-1 opacity-60">
                        {entry.createdByUsername || entry.createdBy}
                      </td>
                      <td className="border border-[#7a4b52]/25 px-2 py-1">
                        <button
                          type="button"
                          className="cursor-pointer text-red-800 underline disabled:opacity-50"
                          disabled={busyId === entry.id}
                          onClick={() => void forget(entry)}
                        >
                          {busyId === entry.id ? "Removing…" : "Remove"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          </div>
        </div>
      </Panel>
    </Modal>
  );
};

/**
 * How many claimed rewards the inline list shows before the `All` panel takes over.
 *
 * Five is enough to recognise a pattern ("is this the same player over and over?")
 * without turning the Send page into a ledger. The full history is one click away
 * because the question it answers — "did that payout actually settle?" — matters
 * occasionally and not constantly.
 */
const CLAIMED_PREVIEW_COUNT = 5;

/** A timestamp as plain text, so it can be compared against a bank statement. */
const plainTimestamp = (epochSeconds: number): string =>
  `${new Date(epochSeconds * 1000).toISOString().replace("T", " ").slice(0, 19)} UTC`;

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
  const [showAllClaimed, setShowAllClaimed] = useState(false);

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
                  <strong>{farmIdText(entry.farmId)}</strong>{" "}
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
            {/*
              The heading doubles as the toggle for the full history, rather than
              adding a second control: it already carries the count, so it is the
              one line that answers "how much is there" and the one line that
              should answer "show me all of it".
            */}
            <div className="mt-3 flex items-center justify-between gap-2">
              <h4 className="text-[11px] font-semibold text-black opacity-70">
                Claimed ({settled.length})
              </h4>
              <button
                type="button"
                className="cursor-pointer text-[11px] text-black underline opacity-70 hover:opacity-100"
                onClick={() => setShowAllClaimed(true)}
              >
                All
              </button>
            </div>
            <ul className="mt-1 space-y-1">
              {settled.slice(0, CLAIMED_PREVIEW_COUNT).map((entry) => (
                <li key={entry.id} className="text-[11px] text-black opacity-60">
                  <strong>{farmIdText(entry.farmId)}</strong>{" "}
                  {entry.label || entry.actionId}
                </li>
              ))}
            </ul>
            {settled.length > CLAIMED_PREVIEW_COUNT ? (
              <p className="mt-1 text-[11px] text-black opacity-50">
                Showing {CLAIMED_PREVIEW_COUNT} of {settled.length}.
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      {showAllClaimed ? (
        <ClaimedHistory
          entries={settled}
          payoutButtons={payoutButtons}
          onClose={() => setShowAllClaimed(false)}
          onChanged={() => void refresh()}
        />
      ) : null}
    </div>
  );
};