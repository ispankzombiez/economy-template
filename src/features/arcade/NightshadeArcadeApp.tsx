import React, { useEffect, useMemo, useState } from "react";
import { Modal } from "components/ui/Modal";
import { getGameEntry, GAME_REGISTRY } from "./games/registry";
import { NightshadeArcadePhaser } from "./NightshadeArcadePhaser";
import { minigamesEventEmitter } from "./lib/minigamesEvents";
import { nightshadeArcadeEvents } from "./lib/nightshadeArcadeEvents";
import { useMinigameSession, resolveVipAccess } from "lib/portal";
import { submitScore } from "lib/portal/api";
import { getMinigamesApiUrl } from "lib/portal/url";
import {
  resolveActionAmounts,
  resolveRavenCoinMintAction,
  resolveRavenCoinTokenKey,
} from "./lib/ravenCoin";
import type { RewardWinMeta } from "./games/adapters/portal";
import { NightshadeArcadeHud } from "./components/NightshadeArcadeHud";
import { NightshadeArcadeShop } from "./components/NightshadeArcadeShop";

export const NightshadeArcadeApp: React.FC = () => {
  const {
    jwt,
    actions,
    playerData,
    playerEconomy,
    economyMeta,
    dispatchAction,
  } = useMinigameSession();
  // Same signal `withArcadeProps` gives the cabinets: VIP reads the SFL farm's
  // `vip.expiresAt` through the portal player profile.
  const isVip = useMemo(
    () => resolveVipAccess(!!jwt, playerData?.portalProfile),
    [jwt, playerData?.portalProfile],
  );
  const [tokenBalance, setTokenBalance] = useState(0);
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const [showShopModal, setShowShopModal] = useState(false);
  const activeEntry = useMemo(
    () => (activeGameId ? getGameEntry(activeGameId) : undefined),
    [activeGameId],
  );
  const ActiveGameComponent = activeEntry?.component;

  const handleBack = () => {
    setActiveGameId(null);
  };

  /**
   * Pay out a win.
   *
   * Two separate things happen here and only one of them is the reward:
   *
   *  1. **The mint** — `dispatchAction({ action })` runs the published economy
   *     rule. It applies optimistically, POSTs `/action`, then merges the
   *     server's authoritative `playerEconomy` back in. That is what makes the
   *     coin survive a refresh, and what makes the server's daily cap the real
   *     limit rather than the client's say-so.
   *  2. **The score** — `submitScore` only writes the portal leaderboard. It
   *     never credits currency; it stays as a best-effort side channel.
   *
   * `tokenBalance` is deliberately *not* incremented when the mint runs:
   * `playerEconomy.balances` already carries it, and adding both would double
   * count. It is only used as the degraded path where no coin-minting action is
   * published at all, so the player still sees what they won instead of nothing.
   *
   * When the rule engine *rejects* the mint (daily cap reached, say) nothing is
   * credited: `dispatchAction`'s `{ ok: false }` is the server's own rule
   * verdict mirrored locally, and honouring it is the whole point of the cap.
   * The reason is left on `apiError` for the shop to surface.
   */
  const handleWin = (tokens: number, meta?: RewardWinMeta) => {
    if (!Number.isFinite(tokens) || tokens <= 0) return;

    const coinKey = resolveRavenCoinTokenKey({
      economyMeta,
      items: playerEconomy?.items,
      balances: playerEconomy?.balances,
    });

    // Three payouts, three published actions:
    //   ticket-funded → the uncapped one, or the free run's cap would reject it;
    //   VIP free run  → this cabinet's own action, so "one free run per machine"
    //                   is enforced *and counted* per machine (refresh-proof);
    //   non-VIP free  → the arcade-wide action, capped at one for the day.
    //
    // `meta.isVip` is the store's view at the moment of the win, which is the
    // same signal; the local `isVip` is only the fallback for a win that
    // arrives without a run context.
    const vip = meta?.isVip ?? isVip;
    const variant =
      meta?.fundedBy === "ticket" ? "ticket" : vip ? "machine" : "free";

    const mintAction = resolveRavenCoinMintAction({
      actions,
      coinKey,
      variant,
      machine: meta?.machine,
    });
    const amounts = resolveActionAmounts({
      actions,
      actionId: mintAction,
      tokenKey: coinKey,
      amount: 1,
    });

    if (!mintAction) {
      // No rule published that mints the coin — nothing can be committed, so
      // show it for this session only.
      setTokenBalance((b) => b + tokens);
    } else {
      // The rule mints a fixed amount (1) per call, so a larger payout is N
      // calls. Every game currently reports `*_RAVEN_COIN_REWARD = 1`, so this
      // is a single call in practice.
      for (let i = 0; i < tokens; i++) {
        dispatchAction({ action: mintAction, amounts });
      }
    }

    if (getMinigamesApiUrl() && jwt) {
      void submitScore({ token: jwt, score: tokens }).catch(() => {
        // score submission errors are non-blocking
      });
    }
  };

  useEffect(() => {
    // Registry-driven: every entry in GAME_REGISTRY becomes launchable from a
    // cabinet (see data/machineMap.ts) without touching this file again.
    const unsubscribes = GAME_REGISTRY.map((entry) =>
      minigamesEventEmitter.subscribe(
        entry.id as Parameters<typeof minigamesEventEmitter.subscribe>[0],
        () => setActiveGameId(entry.id),
      ),
    );

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  useEffect(() => {
    const openShop = () => setShowShopModal(true);
    nightshadeArcadeEvents.registerShopHandler(openShop);

    return () => {
      nightshadeArcadeEvents.registerShopHandler(null);
    };
  }, []);

  useEffect(() => {
    const isGameOpen = Boolean(activeEntry && ActiveGameComponent);
    nightshadeArcadeEvents.setMinigameActive(isGameOpen);

    return () => {
      nightshadeArcadeEvents.setMinigameActive(false);
    };
  }, [activeEntry, ActiveGameComponent]);

  // Every registry entry is "local" or "scaffolded", so the game component owns
  // its own back navigation via `onBack` — no hub-injected overlay is needed.
  return (
    <>
      <NightshadeArcadePhaser />
      <NightshadeArcadeHud extraRavenCoins={tokenBalance} />
      {activeEntry && ActiveGameComponent ? (
        <Modal show className="justify-stretch items-stretch bg-black/55 p-0">
          <div className="relative h-full w-full overflow-hidden">
            <ActiveGameComponent
              onBack={handleBack}
              onWin={handleWin}
              tokenReward={activeEntry.tokenReward}
            />
          </div>
        </Modal>
      ) : null}
      <Modal show={showShopModal} onHide={() => setShowShopModal(false)}>
        <NightshadeArcadeShop onClose={() => setShowShopModal(false)} />
      </Modal>
    </>
  );
};
