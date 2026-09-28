import React, { useCallback, useMemo } from "react";
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
  getFreeRunsOpenedToday,
  getPlayTicketBalance,
  getRavenCoinsMintedToday,
  resolveActionAmounts,
  resolveFreeRunStartAction,
  resolvePlayTicketTokenKey,
  resolveRavenCoinMintAction,
  resolveRavenCoinTokenKey,
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
      const coinKey = resolveRavenCoinTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
      });
      const attemptKey = resolveRewardAttemptTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
      });

      // Which daily ledger answers "have I already opened a free run today?".
      //
      // When the economy publishes the run-opens, the count comes from the
      // **open** action and the voucher it minted, because that is recorded
      // whether the run is won, lost or abandoned. Counting minted coins instead
      // would only ever charge the player for winning, which let a run be
      // restarted for free after a loss or a reload.
      //
      // Falling back to the payout ledger keeps a fork that has not published the
      // opens working, at the old (loss-is-free) semantics.
      const openAction = resolveFreeRunStartAction({
        actions,
        isVip,
        machine: minigame,
      });
      const attemptsToday = openAction
        ? getFreeRunsOpenedToday({
            playerEconomy,
            actionId: openAction,
            voucherKey: attemptKey,
          })
        : getRavenCoinsMintedToday({
            playerEconomy,
            actionId: resolveRavenCoinMintAction(
              isVip
                ? { actions, coinKey, variant: "machine", machine: minigame }
                : { actions, coinKey, variant: "free" },
            ),
            coinKey,
          });

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
     * Spend a free reward run by opening it.
     *
     * Dispatches the run-open action, which mints the run's voucher under a
     * `dailyCap`. That mint is what records the attempt, so it is issued when the
     * run *starts* rather than when it is won — otherwise losing, or walking away
     * mid-run, would cost the player nothing and the free allowance could be
     * retried indefinitely.
     *
     * `dispatchAction` applies the rule engine locally first, so a `dailyCap`
     * refusal comes back as `{ ok: false }` without a round trip and the run is
     * never started.
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

      const attemptKey = resolveRewardAttemptTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
      });
      if (!attemptKey) {
        return {
          ok: false,
          error:
            "This economy has no Reward Attempt item, so a free reward run cannot be opened yet.",
        };
      }

      return dispatchAction({
        action: openAction,
        amounts: resolveActionAmounts({
          actions,
          actionId: openAction,
          tokenKey: attemptKey,
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
