import React from "react";
import { NightshadeArcadeApp } from "features/arcade";
import { MinigamePortalProvider } from "lib/portal";
import {
  ARCADE_OFFLINE_ACTIONS,
  arcadeOfflineEconomyMeta,
  arcadeOfflineMinigame,
} from "features/arcade/lib/offlineEconomy";

export const App: React.FC = () => {
  return (
    <MinigamePortalProvider
      offlineActions={ARCADE_OFFLINE_ACTIONS}
      offlineEconomyMeta={arcadeOfflineEconomyMeta()}
      offlineMinigame={arcadeOfflineMinigame}
    >
      <NightshadeArcadeApp />
    </MinigamePortalProvider>
  );
};
