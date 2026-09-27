import React, { useMemo } from "react";
import type { ComponentType } from "react";
import type { Equipped } from "features/game/types/bumpkin";
import { useMinigameSession } from "lib/portal";
import type { ArcadeGameProps } from "../../types";
import type { GameState } from "./gameTypes";
import { ArcadePortalProvider } from "./portal";

/** Signature the original arcade games were written against. */
type ArcadeOriginal = React.FC<{ onClose?: () => void }>;

/**
 * Adapts an original `React.FC<{ onClose?: () => void }>` game to the
 * arcade's `ArcadeGameProps`.
 *
 * Responsibilities:
 *  - build the `GameState` the games read through `PortalContext`
 *    (FLOWER balance + bumpkin, mirroring what the HUD displays);
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
): ComponentType<ArcadeGameProps> {
  const ArcadeGame: React.FC<ArcadeGameProps> = ({ onBack, onWin }) => {
    const { jwt, playerData, farm } = useMinigameSession();

    // Same source the arcade HUD shows, so the "has enough FLOWER" gate and
    // the number on screen can never disagree.
    const balance = playerData?.resolvedProfile?.balance ?? farm?.balance ?? 0;
    const equipped = playerData?.resolvedAvatar?.equipped;

    const baseState = useMemo<GameState>(
      () => ({
        balance,
        bumpkin: equipped
          ? { equipped: equipped as unknown as Equipped }
          : null,
        minigames: { games: {} },
      }),
      [balance, equipped],
    );

    return (
      <ArcadePortalProvider baseState={baseState} isVip={!jwt} onWin={onWin}>
        <Original onClose={onBack} />
      </ArcadePortalProvider>
    );
  };

  ArcadeGame.displayName = `ArcadeGame(${
    Original.displayName ?? Original.name ?? "Unnamed"
  })`;

  return ArcadeGame;
}
