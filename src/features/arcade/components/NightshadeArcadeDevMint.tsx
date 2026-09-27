import React, { useMemo, useState } from "react";
import { Button } from "components/ui/Button";
import { useMinigameSession } from "lib/portal";
import {
  DEV_PLAY_TICKET_MINT_ACTION,
  getPlayTicketBalance,
  resolveActionAmounts,
  resolveActionMintLimits,
  resolvePlayTicketTokenKey,
} from "../lib/ravenCoin";

/**
 * Developer-only Play Ticket mint: type a number, press Mint.
 *
 * Renders as a **panel inside the chest popup** (`NightshadeArcadeNotice`),
 * which is where the arcade owner wanted the dev mint to live — the player
 * clicks a chest at the front entryway, and the dev account gets the mint form
 * in the same dialog as the chest's result. It brings no modal or close button
 * of its own; the notice's single OK button dismisses the whole thing.
 *
 * Uncapped by the owner's decision — the dev account mints as many tickets as
 * it needs, as many times as it needs them. `min`/`max`/`dailyCap` are read
 * back from the published rule purely so the input never asks for a number the
 * rule engine will reject outright (`Amount for 2 must be between 1 and 10000`).
 *
 * Note the username gate in `lib/devAccess.ts` is a UI gate only: a modified
 * client can dispatch this action without ever rendering this panel. Delete the
 * action from the economy before launch.
 */
export const NightshadeArcadeDevMint: React.FC = () => {
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

  const limits = resolveActionMintLimits({
    actions,
    actionId: DEV_PLAY_TICKET_MINT_ACTION,
    tokenKey: ticketKey,
  });
  const held = getPlayTicketBalance({ playerEconomy, tokenKey: ticketKey });
  const published = Boolean(actions?.[DEV_PLAY_TICKET_MINT_ACTION]);

  const perCallMax =
    limits && Number.isFinite(limits.max) ? limits.max : undefined;
  // The editor publishes a sentinel `dailyCap` on a ranged mint that declares
  // none, so read an absurd cap as "no daily limit" instead of printing it.
  const dailyCap =
    limits?.dailyCap !== undefined && limits.dailyCap < 1_000_000
      ? limits.dailyCap
      : undefined;

  const requested = Math.trunc(Number(rawAmount));
  const inRange =
    Number.isFinite(requested) &&
    requested >= (limits?.min ?? 1) &&
    (perCallMax === undefined || requested <= perCallMax) &&
    (dailyCap === undefined || requested <= dailyCap);

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
    <div className="mt-3 rounded border border-amber-400/40 bg-amber-400/10 p-3">
      <h3 className="text-xs font-semibold text-amber-200">
        Dev: Mint Play Tickets
      </h3>

      {!published ? (
        <p className="mt-1 text-[11px] text-red-300">
          No <code>{DEV_PLAY_TICKET_MINT_ACTION}</code> action is published, so
          there is nothing to dispatch. Publish it in the economy editor first.
        </p>
      ) : (
        <>
          <label className="mt-2 block text-xs text-[#dfc7f1]">
            How many Play Tickets?
            <input
              type="number"
              inputMode="numeric"
              min={limits?.min ?? 1}
              max={perCallMax}
              value={rawAmount}
              onChange={(e) => setRawAmount(e.target.value)}
              className="mt-1 w-full rounded border border-white/20 bg-black/40 p-2 text-sm"
            />
          </label>

          <p className="mt-2 text-[11px] text-[#c9e5ff]">
            Holding {held}.{" "}
            {perCallMax === undefined
              ? "No per-mint limit published."
              : `Up to ${perCallMax.toLocaleString()} per mint.`}{" "}
            {dailyCap === undefined
              ? "No daily limit — mint as often as you need."
              : `Daily limit ${dailyCap.toLocaleString()}.`}
          </p>

          {!inRange && rawAmount.trim() !== "" ? (
            <p className="mt-1 text-[11px] text-amber-300">
              {perCallMax === undefined
                ? `Enter a whole number of at least ${limits?.min ?? 1}.`
                : `Enter a whole number between ${limits?.min ?? 1} and ${perCallMax.toLocaleString()}.`}
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

          <div className="mt-3">
            <Button disabled={!inRange} onClick={mint}>
              Mint
            </Button>
          </div>
        </>
      )}
    </div>
  );
};
