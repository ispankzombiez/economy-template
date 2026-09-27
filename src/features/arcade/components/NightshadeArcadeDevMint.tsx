import React, { useMemo, useState } from "react";
import { Button } from "components/ui/Button";
import { Modal } from "components/ui/Modal";
import { useMinigameSession } from "lib/portal";
import {
  DEV_PLAY_TICKET_MINT_ACTION,
  getPlayTicketBalance,
  resolveActionAmounts,
  resolveActionDailyCap,
  resolvePlayTicketTokenKey,
} from "../lib/ravenCoin";

type NightshadeArcadeDevMintProps = {
  onClose: () => void;
};

/**
 * Developer-only Play Ticket mint: type a number, press Mint.
 *
 * ## What actually protects this
 *
 * Not the fact that it is behind a modal, and not the username check in
 * `lib/devAccess.ts` — a modified client can dispatch
 * `Dev-Mint-Play-Ticket` without ever rendering this. The protection is the
 * action's **`dailyCap`**, which the server enforces, and which this dialog
 * reads back to clamp the input. That way the number in the box is a number the
 * rule engine will actually grant instead of a silent rejection.
 *
 * The action should be deleted from the economy before launch.
 */
export const NightshadeArcadeDevMint: React.FC<
  NightshadeArcadeDevMintProps
> = ({ onClose }) => {
  const { actions, economyMeta, playerEconomy, dispatchAction, apiError } =
    useMinigameSession();
  const [rawAmount, setRawAmount] = useState("1");
  const [feedback, setFeedback] = useState<{
    tone: "good" | "bad";
    text: string;
  } | null>(null);

  const ticketKey = useMemo(
    () =>
      resolvePlayTicketTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
      }),
    [economyMeta, playerEconomy?.items, playerEconomy?.balances],
  );

  const cap = resolveActionDailyCap({
    actions,
    actionId: DEV_PLAY_TICKET_MINT_ACTION,
    tokenKey: ticketKey,
  });
  const held = getPlayTicketBalance({ playerEconomy, tokenKey: ticketKey });
  const published = Boolean(actions?.[DEV_PLAY_TICKET_MINT_ACTION]);

  const requested = Math.trunc(Number(rawAmount));
  const inRange =
    Number.isFinite(requested) &&
    requested >= 1 &&
    (cap === undefined || requested <= cap);

  const mint = () => {
    if (!inRange) return;
    setFeedback(null);
    const result = dispatchAction({
      action: DEV_PLAY_TICKET_MINT_ACTION,
      amounts: resolveActionAmounts({
        actions,
        actionId: DEV_PLAY_TICKET_MINT_ACTION,
        tokenKey: ticketKey,
        amount: requested,
      }),
    });
    setFeedback(
      result.ok
        ? { tone: "good", text: `Minted ${requested} Play Ticket(s).` }
        : { tone: "bad", text: result.error || "The server refused the mint." },
    );
  };

  return (
    <Modal show onHide={onClose}>
      <div className="w-full max-w-sm rounded bg-[#1f1529] p-4 text-white">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Dev: Mint Play Tickets</h2>
          <Button className="w-auto" onClick={onClose}>
            Close
          </Button>
        </div>

        {!published ? (
          <p className="text-xs text-red-300">
            No <code>{DEV_PLAY_TICKET_MINT_ACTION}</code> action is published,
            so there is nothing to dispatch. Publish it in the economy editor
            first.
          </p>
        ) : (
          <>
            <label className="block text-xs text-[#dfc7f1]">
              How many Play Tickets?
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={cap}
                value={rawAmount}
                onChange={(e) => setRawAmount(e.target.value)}
                className="mt-1 w-full rounded border border-white/20 bg-black/40 p-2 text-sm"
              />
            </label>

            <p className="mt-2 text-[11px] text-[#c9e5ff]">
              Holding {held}. Server cap:{" "}
              {cap === undefined ? "none published" : `${cap} per day`}.
            </p>

            {!inRange && rawAmount.trim() !== "" ? (
              <p className="mt-1 text-[11px] text-amber-300">
                {cap === undefined
                  ? "Enter a whole number of at least 1."
                  : `Enter a whole number between 1 and ${cap}.`}
              </p>
            ) : null}

            {feedback ? (
              <p
                className={`mt-2 text-xs ${
                  feedback.tone === "good" ? "text-[#8fe3a0]" : "text-red-300"
                }`}
              >
                {feedback.text}
              </p>
            ) : null}
            {apiError && !feedback ? (
              <p className="mt-2 text-xs text-red-300">{apiError}</p>
            ) : null}

            <div className="mt-4">
              <Button disabled={!inRange} onClick={mint}>
                Mint
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};
