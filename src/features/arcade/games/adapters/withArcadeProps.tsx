import React, { useCallback, useEffect, useMemo, useRef } from "react";
import type { ComponentType } from "react";
import type { Equipped } from "features/game/types/bumpkin";
import { useVipAccess, useMinigameSession } from "lib/portal";
import type { ArcadeGameProps } from "../../types";
import type { GameState } from "./gameTypes";
import { ArcadePortalProvider } from "./portal";
import type { PortalSendResult } from "./portal";
import { RewardAttemptCleanup } from "./RewardAttemptCleanup";
import { getTodayKey } from "../poker/session";
import {
  buildAttemptHistory,
  getFreeRunTokenBalance,
  getPlayTicketBalance,
  resolveActionAmounts,
  resolveFreeRunGrantAction,
  resolveFreeRunStartAction,
  resolveFreeRunTokenKey,
  resolvePlayTicketTokenKey,
  resolveRewardAttemptTokenKey,
  TICKET_RUN_START_ACTION,
} from "../../lib/ravenCoin";

/** Signature the original arcade games were written against. */
type ArcadeOriginal = React.FC<{ onClose?: () => void }>;

/**
 * Adapts an original `React.FC<{ onClose?: () => void }>` game to the
 * arcade's `ArcadeGameProps`.
 *
 * @param Original  the ported game component
 * @param minigame  its `GAME_REGISTRY` id, which is also the id the game sends
 *                  in `arcadeMinigame.started`. It selects this cabinet's own
 *                  mint action, so a VIP's "one free run per machine" is counted
 *                  per machine and survives a refresh.
 *
 * Responsibilities:
 *  - build the `GameState` the games read through `PortalContext`
 *    (FLOWER balance, Play Tickets, bumpkin, mirroring what the HUD displays);
 *  - hydrate `minigames` from the server's daily mint ledger so the
 *    reward-run gate survives a refresh (see `lib/ravenCoin.ts`);
 *  - mount `ArcadePortalProvider`, which is what `portalService` and
 *    `useVipAccess` resolve against;
 *  - wire the game's `arcadeMinigame.ravenCoinWon` event to `onWin` so the
 *    arcade HUD credits the prize;
 *  - translate the game's exit control (`onClose`) into `onBack`.
 *
 * `tokenReward` is not forwarded: each original carries its own
 * `*_RAVEN_COIN_REWARD` constant and reports it through `ravenCoinWon`.
 */
export function withArcadeProps(
  Original: ArcadeOriginal,
  minigame: string,
): ComponentType<ArcadeGameProps> {
  const ArcadeGame: React.FC<ArcadeGameProps> = ({ onBack, onWin }) => {
    const {
      jwt,
      playerData,
      farm,
      playerEconomy,
      actions,
      economyMeta,
      dispatchAction,
    } = useMinigameSession();

    // VIP comes from the SFL farm's `vip.expiresAt`: the player economies session
    // first, then the Community API as a fallback. A session-less boot stays VIP
    // so a dev session can still exercise the per-cabinet reward path.
    const isVip = useVipAccess();

    // Same source the arcade HUD shows, so the "has enough FLOWER" gate and
    // the number on screen can never disagree.
    const balance = playerData?.resolvedProfile?.balance ?? farm?.balance ?? 0;
    const equipped = playerData?.resolvedAvatar?.equipped;

    const baseState = useMemo<GameState>(() => {
      const tokenKey = resolveFreeRunTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
        isVip,
        machine: minigame,
      });

      // "Have I already used today's free run on this cabinet?" is answered by
      // whether the player is **still holding its token**. The token is minted on
      // first visit and burned when a free run starts, so its absence is the
      // signal — a plain balance read, with no mint ledger to interpret and
      // nothing that depends on how the run turned out.
      //
      // `attemptsToday` is the shape the gate expects (used runs, not remaining
      // ones), so a held token means zero used.
      const openAction = resolveFreeRunStartAction({
        actions,
        isVip,
        machine: minigame,
      });
      const tokenBalance = getFreeRunTokenBalance({
        playerEconomy,
        tokenKey,
      });

      // **Fails closed.** If the token economy is not fully published, or has not
      // finished loading, this reports the allowance as spent rather than
      // guessing. That used to fall back to counting minted coins, which is zero
      // for any run that did not win — so a partial publish silently handed out
      // free runs on every loss and every walk-out. A wrong "charges a ticket"
      // costs the player one ticket; a wrong "free" costs the economy a coin per
      // attempt, every time.
      const attemptsToday =
        !openAction || !tokenKey ? 1 : tokenBalance > 0 ? 0 : 1;

      const playTicketKey = resolvePlayTicketTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
      });

      return {
        balance,
        playTickets: getPlayTicketBalance({
          playerEconomy,
          tokenKey: playTicketKey,
        }),
        bumpkin: equipped
          ? { equipped: equipped as unknown as Equipped }
          : null,
        minigames: {
          games: buildAttemptHistory({
            isVip,
            minigame,
            attemptsToday,
            today: getTodayKey(),
          }),
        },
      };
    }, [
      balance,
      equipped,
      isVip,
      minigame,
      playerEconomy,
      actions,
      economyMeta,
    ]);

    /**
     * Mint this cabinet's free-run token, on first visit.
     *
     * Lazy rather than at boot: one request instead of ten, and it happens where
     * a failure would be visible. A refusal is **not** an error — the grant
     * carries `dailyCap: 1`, so being refused simply means today's token was
     * already minted and spent, which is exactly the state we want.
     *
     * ## Why this fires once and not on every balance change
     *
     * `playerEconomy` is a dependency of almost everything here and changes on
     * *every* action, so an effect that re-asks whenever the token is missing
     * re-asks the moment a free run **burns** it — which is precisely the moment
     * the player must not be handed one back. Depending on the live balance
     * re-opens the very hole the token exists to close.
     *
     * So the grant is attempted once per cabinet mount, behind a ref, reading the
     * balance as it was when the cabinet opened. A refusal is left to stand: it
     * means today is spent, and re-asking would only risk handing the token back.
     */
    const grantAttemptedRef = useRef(false);
    useEffect(() => {
      if (grantAttemptedRef.current) return;
      if (!jwt) return;
      const grantAction = resolveFreeRunGrantAction({
        actions,
        isVip,
        machine: minigame,
      });
      if (!grantAction) return;

      const tokenKey = resolveFreeRunTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
        isVip,
        machine: minigame,
      });
      if (!tokenKey) return;

      // Already holding one: nothing to grant, and do not spend the attempt.
      if (getFreeRunTokenBalance({ playerEconomy, tokenKey }) > 0) return;

      grantAttemptedRef.current = true;
      // Deliberately not awaited and not surfaced: a refusal is the expected
      // "already used today" answer, not a failure to report.
      dispatchAction({
        action: grantAction,
        amounts: resolveActionAmounts({
          actions,
          actionId: grantAction,
          tokenKey,
          amount: 1,
        }),
      });
      // Intentionally mount-only; see the note above.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * Spend a free reward run by burning its token.
     *
     * `Start-Free-Run-<Cabinet>` burns the token and mints the run's voucher in
     * one atomic request. The burn happens when the run *starts*, so the outcome
     * cannot give the attempt back: a loss, a walk-out mid-run or a refresh all
     * leave the cabinet charging a Play Ticket for the rest of the day.
     *
     * `dispatchAction` runs the rule engine locally first, so a refusal comes
     * back as `{ ok: false }` without a round trip and the run never starts.
     */
    const onStartFreeRun = useCallback<() => PortalSendResult>(() => {
      const openAction = resolveFreeRunStartAction({
        actions,
        isVip,
        machine: minigame,
      });

      // No run-opens published: the payout carries the cap instead, so there is
      // nothing to spend here.
      if (!openAction) return { ok: true, funding: "free" };

      const tokenKey = resolveFreeRunTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
        isVip,
        machine: minigame,
      });
      const attemptKey = resolveRewardAttemptTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
      });
      if (!tokenKey || !attemptKey) {
        return {
          ok: false,
          error:
            "This economy has no Free Run Token item, so a free reward run cannot be opened yet.",
        };
      }

      return dispatchAction({
        action: openAction,
        amounts: resolveActionAmounts({
          actions,
          actionId: openAction,
          tokenKey,
          amount: 1,
        }),
      });
    }, [actions, dispatchAction, economyMeta, isVip, minigame, playerEconomy]);

    /**
     * Open a Play-Ticket-funded reward run.
     *
     * One atomic request: the server burns a Play Ticket and mints the voucher
     * the run pays out against (`Start-Ticket-Run`). Keeping it to a single
     * action is what stops the ticket spend and the coin payout drifting apart —
     * when they were separate, the payout could be called on its own and
     * credited a coin for free.
     */
    const onSpendTicket = useCallback<() => PortalSendResult>(() => {
      const ticketKey = resolvePlayTicketTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
      });
      const attemptKey = resolveRewardAttemptTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
      });

      // With no published voucher the run could never be paid out, so refuse
      // to spend the player's ticket on it.
      if (!attemptKey) {
        return {
          ok: false,
          error:
            "This economy has no Reward Attempt item, so a Play Ticket cannot be used yet.",
        };
      }

      return dispatchAction({
        action: TICKET_RUN_START_ACTION,
        amounts: resolveActionAmounts({
          actions,
          actionId: TICKET_RUN_START_ACTION,
          tokenKey: ticketKey,
          amount: 1,
        }),
      });
    }, [actions, dispatchAction, economyMeta, playerEconomy]);

    return (
      <ArcadePortalProvider
        baseState={baseState}
        isVip={isVip}
        onWin={onWin}
        onSpendTicket={onSpendTicket}
        onStartFreeRun={onStartFreeRun}
      >
        <RewardAttemptCleanup />
        <Original onClose={onBack} />
      </ArcadePortalProvider>
    );
  };

  ArcadeGame.displayName = `ArcadeGame(${
    Original.displayName ?? Original.name ?? "Unnamed"
  })`;

  return ArcadeGame;
}
