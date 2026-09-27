import React, { useEffect, useMemo, useState } from "react";
import { HudContainer } from "components/ui/HudContainer";
import { useMinigameSession } from "lib/portal";
import { Modal } from "components/ui/Modal";
import { Panel } from "components/ui/Panel";
import ravenCoinIcon from "../assets/RavenCoin.webp";
import { resolveRavenCoinTokenKey } from "../lib/ravenCoin";
import flowerIcon from "../assets/flower_token.webp";
import { PortalBasketButton } from "./PortalBasketButton";
import { requestClosePortal } from "lib/portal/closePortal";
import { SUNNYSIDE } from "example-assets/sunnyside";
import { PIXEL_SCALE } from "lib/constants";
import worldIcon from "example-assets/icons/world.png";

type NightshadeArcadeHudProps = {
  extraRavenCoins: number;
};

const formatter = new Intl.NumberFormat();

/** How long the full FLOWER balance stays on screen after a click. */
const FULL_BALANCE_HOLD_MS = 4000;

const NightshadeArcadeBalances: React.FC<{
  flowers: number;
  ravenCoins: number;
}> = ({ flowers, ravenCoins }) => {
  // FLOWER is a long decimal; the arcade shows the whole number and only
  // reveals the exact figure on click, for a few seconds.
  const [showFullBalance, setShowFullBalance] = useState(false);

  useEffect(() => {
    if (!showFullBalance) return;
    const timer = window.setTimeout(
      () => setShowFullBalance(false),
      FULL_BALANCE_HOLD_MS,
    );
    return () => window.clearTimeout(timer);
  }, [showFullBalance]);

  return (
    <div
      className="relative flex items-center space-x-2 cursor-pointer !text-[28px] text-stroke"
      onClick={() => setShowFullBalance(true)}
      title="Click to show the exact FLOWER balance"
    >
      <div className="h-9 w-full bg-black opacity-25 absolute sfl-hud-backdrop -z-10" />
      <span className="balance-text">
        {flowers.toLocaleString(undefined, {
          maximumFractionDigits: showFullBalance ? 8 : 0,
        })}
      </span>
      <img alt="FLOWER" src={flowerIcon} style={{ width: 26 }} />
      <div className="flex items-center space-x-2">
        <span className="balance-text mt-0.5">
          {formatter.format(ravenCoins)}
        </span>
        <img
          alt="RavenCoins"
          src={ravenCoinIcon}
          style={{ width: 25, height: 25 }}
        />
      </div>
    </div>
  );
};

export const NightshadeArcadeHud: React.FC<NightshadeArcadeHudProps> = ({
  extraRavenCoins,
}) => {
  const { farmId, playerEconomy, farm, playerData, economyMeta } =
    useMinigameSession();
  const profileInventory = playerData.resolvedProfile.inventory;
  const readAmount = (value: unknown) => {
    const amount = Number(value ?? 0);
    return Number.isFinite(amount) ? amount : 0;
  };
  const readInventoryAmount = (token: string) =>
    readAmount(profileInventory?.[token]);

  // Hosted builds key this currency `mainCurrencyToken` (`"0"`), the offline
  // sample keys it `RavenCoin` — reading a hard-coded name shows 0 either way.
  const ravenCoinToken = resolveRavenCoinTokenKey({
    economyMeta,
    items: playerEconomy?.items,
    balances: playerEconomy?.balances,
  });

  const baseRavenCoins = readAmount(
    playerEconomy.balances?.[ravenCoinToken] ??
      readInventoryAmount(ravenCoinToken),
  );
  const totalRavenCoins = Math.max(0, baseRavenCoins + extraRavenCoins);
  const flowers = readAmount(
    playerData.resolvedProfile.balance ?? farm.balance,
  );
  const [showInventory, setShowInventory] = useState(false);
  const visibleInventoryEntries = useMemo(() => {
    const merged = new Map<string, number>();

    const appendEntries = (entries: Record<string, unknown> | undefined) => {
      Object.entries(entries ?? {}).forEach(([token, amount]) => {
        const numericAmount = Number(amount ?? 0);
        if (!Number.isFinite(numericAmount) || numericAmount <= 0) return;
        merged.set(token, Math.max(numericAmount, merged.get(token) ?? 0));
      });
    };

    appendEntries(playerData.resolvedProfile.inventory);
    appendEntries(playerEconomy.balances);

    // Hosted configs key items numerically (`"0"`), so a raw key in the list
    // would read "0" instead of "Raven Coin".
    const labelFor = (token: string) =>
      economyMeta?.items?.[token]?.name ?? token;

    return Array.from(merged.entries())
      .map(([token, amount]) => ({ token, label: labelFor(token), amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [
    playerData.resolvedProfile.inventory,
    playerEconomy.balances,
    economyMeta?.items,
  ]);

  return (
    <>
      <HudContainer>
        <div
          id="travel"
          className="absolute bottom-3 left-3 z-50 flex justify-center cursor-pointer hover:img-highlight"
          style={{
            width: `${PIXEL_SCALE * 22}px`,
            height: `${PIXEL_SCALE * 23}px`,
          }}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            requestClosePortal();
          }}
        >
          <img
            src={SUNNYSIDE.ui.round_button}
            className="absolute"
            style={{
              width: `${PIXEL_SCALE * 22}px`,
            }}
          />
          <img
            src={worldIcon}
            style={{
              width: `${PIXEL_SCALE * 12}px`,
              left: `${PIXEL_SCALE * 5}px`,
              top: `${PIXEL_SCALE * 4}px`,
            }}
            className="absolute"
          />
        </div>

        <div className="absolute left-3 top-3 rounded bg-black/55 px-3 py-2 text-xs text-white">
          <div className="font-semibold">
            {playerData.resolvedProfile.username ?? `Farmer #${farmId}`}
          </div>
          <div className="text-[11px] text-[#e6bfd4]">Nightshade Arcade</div>
        </div>

        <div className="absolute right-0 top-0 p-2.5">
          <NightshadeArcadeBalances
            flowers={flowers}
            ravenCoins={totalRavenCoins}
          />
        </div>

        <div className="absolute right-0 top-24 p-2.5 flex flex-col space-y-2.5">
          <PortalBasketButton onClick={() => setShowInventory(true)} />
        </div>
      </HudContainer>

      <Modal show={showInventory} onHide={() => setShowInventory(false)}>
        <Panel className="w-full max-w-sm">
          <div className="p-2 text-[#3e2731]">
            <div className="mb-2 text-sm font-bold">Inventory</div>
            {visibleInventoryEntries.length ? (
              <div className="max-h-72 overflow-y-auto space-y-1 text-xs">
                {visibleInventoryEntries.map(({ token, label, amount }) => (
                  <div
                    className="flex items-center justify-between"
                    key={token}
                  >
                    <span>{label}</span>
                    <span>{formatter.format(amount)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs">No items yet.</div>
            )}
          </div>
        </Panel>
      </Modal>
    </>
  );
};
