import React, { useCallback, useMemo } from "react";
import type { ComponentType } from "react";
import type { Equipped } from "features/game/types/bumpkin";
import { resolveVipAccess, useMinigameSession } from "lib/portal";
import type { ArcadeGameProps } from "../../types";
import type { GameState } from "./gameTypes";
import { ArcadePortalProvider } from "./portal";
import type { PortalSendResult } from "./portal";
import { getTodayKey } from "../poker/session";
import {
  buildAttemptHistory,
  getPlayTicketBalance,
  getRavenCoinsMintedToday,
  PLAY_TICKET_SPEND_ACTION,
  resolveActionAmounts,
  resolvePlayTicketTokenKey,
  resolveRavenCoinMintAction,
  resolveRavenCoinTokenKey,
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

    // VIP comes from the SFL farm (`farm.vip.expiresAt` or the lifetime banner),
    // which the portal player profile carries. A session-less boot stays VIP so
    // a dev session can still exercise the per-cabinet reward path.
    const isVip = useMemo(
      () => resolveVipAccess(!!jwt, playerData?.portalProfile),
      [jwt, playerData?.portalProfile],
    );

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
     * Burn one Play Ticket to open a reward run past the free allowance.
     *
     * The published action is burn-only (`Mint-Play-Ticket`), so the optimistic
     * rule check inside `dispatchAction` is what refuses the run for a player
     * who has none — the store surfaces that as a rejected `send`.
     */
    const onSpendTicket = useCallback<() => PortalSendResult>(() => {
      const ticketKey = resolvePlayTicketTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
      });

      return dispatchAction({
        action: PLAY_TICKET_SPEND_ACTION,
        amounts: resolveActionAmounts({
          actions,
          actionId: PLAY_TICKET_SPEND_ACTION,
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
        <Original onClose={onBack} />
      </ArcadePortalProvider>
    );
  };

  ArcadeGame.displayName = `ArcadeGame(${
    Original.displayName ?? Original.name ?? "Unnamed"
  })`;

  return ArcadeGame;
}
