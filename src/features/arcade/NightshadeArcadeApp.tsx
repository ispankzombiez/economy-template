import React, { useEffect, useMemo, useState } from "react";
import { Modal } from "components/ui/Modal";
import { getGameEntry, GAME_REGISTRY } from "./games/registry";
import { NightshadeArcadePhaser } from "./NightshadeArcadePhaser";
import { minigamesEventEmitter } from "./lib/minigamesEvents";
import { nightshadeArcadeEvents } from "./lib/nightshadeArcadeEvents";
import { useMinigameSession } from "lib/portal";
import { submitScore } from "lib/portal/api";
import { getMinigamesApiUrl } from "lib/portal/url";
import { NightshadeArcadeHud } from "./components/NightshadeArcadeHud";
import { NightshadeArcadeShop } from "./components/NightshadeArcadeShop";

export const NightshadeArcadeApp: React.FC = () => {
  const { jwt } = useMinigameSession();
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

  const handleWin = (tokens: number) => {
    setTokenBalance((b) => b + tokens);
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
              onWin={(tokens) => handleWin(tokens)}
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
