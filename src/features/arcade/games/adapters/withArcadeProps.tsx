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
  getPlayTicketBalance,
  getRavenCoinsMintedToday,
  resolveActionAmounts,
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

      // Which daily ledger answers "have I already had a free run today?".
      //
      //  - **VIP** is rationed per cabinet, so count *this* cabinet's own action
      //    (`Mint-Raven-Coin-<Cabinet>`). That is the only per-machine history
      //    the server keeps, which is what makes the rule refresh-proof.
      //  - **non-VIP** is rationed arcade-wide, so count the shared free action
      //    and record it under {@link ARCADE_WIDE_ATTEMPT_SLOT}.
      //
      // Only the relevant one is hydrated: filling both would make
      // `getArcadeAttemptsUsedToday` sum the two together.
      const ledgerAction = resolveRavenCoinMintAction(
        isVip
          ? { actions, coinKey, variant: "machine", machine: minigame }
          : { actions, coinKey, variant: "free" },
      );
      const attemptsToday = getRavenCoinsMintedToday({
        playerEconomy,
        actionId: ledgerAction,
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
