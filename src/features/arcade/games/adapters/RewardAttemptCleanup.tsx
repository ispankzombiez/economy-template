import React, { useCallback, useEffect, useRef } from "react";
import { useMinigameSession } from "lib/portal";
import {
  countRewardAttempts,
  REWARD_ATTEMPT_VOID_ACTION,
  resolveActionAmounts,
  resolveRewardAttemptTokenKey,
} from "../../lib/ravenCoin";

/**
 * Keeps the Reward Attempt voucher from ever lingering.
 *
 * A voucher is the in-flight half of a paid run: `Start-Ticket-Run` mints one
 * when the player commits their Play Ticket, and `Claim-Raven-Coin` destroys it
 * for the Raven Coin on a win. It exists only while the cabinet is open, so:
 *
 *  - **on mount** it sweeps vouchers left behind by a previous session (a
 *    closed tab, a crash, a browser that never ran the unmount cleanup);
 *  - **on unmount** it voids the voucher of a run that was lost, abandoned or
 *    interrupted, which is also the path for backing out to the arcade floor.
 *
 * Both directions only ever *destroy* the player's own voucher, so the worst
 * outcome of a race here is a paid run that forfeits its claim - never currency
 * out of thin air. A win consumes the voucher through `Claim-Raven-Coin` before
 * this runs, so a successful payout is unaffected.
 *
 * Renders nothing; mounted by `withArcadeProps` inside the portal provider so it
 * can reach both the session and the store.
 */
export const RewardAttemptCleanup: React.FC = () => {
  const { playerEconomy, economyMeta, actions, dispatchAction } =
    useMinigameSession();

  const tokenKey = resolveRewardAttemptTokenKey({
    economyMeta,
    items: playerEconomy?.items,
    balances: playerEconomy?.balances,
  });
  const outstanding = countRewardAttempts({
    playerEconomy,
    tokenKey,
  });

  // Read the live value at teardown: the effect closes over the count from the
  // render that is unmounting, and `outstanding` there is already correct.
  const outstandingRef = useRef(outstanding);
  outstandingRef.current = outstanding;

  const voidAttempts = useCallback(
    (count: number) => {
      if (!tokenKey || count <= 0) return;
      dispatchAction({
        action: REWARD_ATTEMPT_VOID_ACTION,
        amounts: resolveActionAmounts({
          actions,
          actionId: REWARD_ATTEMPT_VOID_ACTION,
          tokenKey,
          amount: count,
        }),
      });
    },
    [actions, dispatchAction, tokenKey],
  );

  // Sweep anything left over from a previous session.
  useEffect(() => {
    voidAttempts(outstanding);
    // Intentionally mount-only: this is a boot sweep, not a balance watcher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The teardown below must fire on a real unmount only. Holding the callback
  // in a ref keeps its identity out of the dep list: `actions` changes identity
  // the moment a voucher is minted, and depending on it would run the cleanup
  // mid-session - voiding the voucher the player had just paid for.
  const voidRef = useRef(voidAttempts);
  voidRef.current = voidAttempts;

  // Void an unfinished paid run when the cabinet closes.
  useEffect(
    () => () => {
      voidRef.current(outstandingRef.current);
    },
    [],
  );

  return null;
};
