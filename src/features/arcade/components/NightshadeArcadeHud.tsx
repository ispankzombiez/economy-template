import React, { useEffect, useMemo, useState } from "react";
import { HudContainer } from "components/ui/HudContainer";
import { useMinigameSession } from "lib/portal";
import { Modal } from "components/ui/Modal";
import { Panel } from "components/ui/Panel";
import ravenCoinIcon from "../assets/RavenCoin.webp";
import {
  resolveRavenCoinTokenKey,
  resolveRewardAttemptTokenKey,
} from "../lib/ravenCoin";
import flowerIcon from "../assets/flower_token.webp";
import { PortalBasketButton } from "./PortalBasketButton";
import { ArcadeSettingsButton } from "./ArcadeSettingsButton";
import { requestClosePortal } from "lib/portal/closePortal";
import { isHiddenBalanceItem } from "lib/portal/playerEconomyItemHelpers";
import { SUNNYSIDE } from "example-assets/sunnyside";
import { PIXEL_SCALE } from "lib/constants";
import worldIcon from "example-assets/icons/world.png";

type NightshadeArcadeHudProps = {
  extraRavenCoins: number;
  /** Opens the settings panel. The HUD owns the button, not the pages. */
  onOpenSettings: () => void;
};

const formatter = new Intl.NumberFormat();

/** How long the full FLOWER balance stays on screen after a click. */
const FULL_BALANCE_HOLD_MS = 4000;

/**
 * Copy via the async Clipboard API. Returns false instead of throwing, so the
 * caller can fall through to `execCommand` without a try/catch.
 *
 * Resolves false rather than throwing on rejection: this is a convenience on a
 * HUD label, and a rejected clipboard write is an expected state (see
 * `copyFarmId` below), not an error worth propagating.
 */
async function copyViaClipboardApi(value: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy by selecting a throwaway textarea and running the legacy `copy` command.
 *
 * Deprecated, and the reason it is here is that it is the only copy path that
 * works when the document is not focused — which `writeText` refuses to do. The
 * textarea is positioned off-screen rather than hidden with `display: none`,
 * because a non-rendered element cannot be selected and the command would then
 * copy nothing while still reporting success.
 */
function copyViaExecCommand(value: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);

  try {
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

/** Decimals shown on the totals at rest. */
const BALANCE_DECIMALS = 2;

/**
 * A balance, written out in full.
 *
 * `String()` is the one formatter here that cannot round: it returns the
 * shortest text that reads back as the exact same number. `Intl.NumberFormat`
 * and `toFixed` both have to pick a cut point, and every cut point rounds —
 * which is how a balance of 0.6 was being shown to players as 1. The
 * exponential text `String()` produces for extreme magnitudes ("1e-7") is
 * expanded by hand for the same reason: reaching for a formatter there would
 * put the rounding back in.
 */
const toExactString = (value: number): string => {
  const raw = String(value);
  if (!/e/i.test(raw)) return raw;

  const negative = raw.startsWith("-");
  const [mantissa, exponentText] = (negative ? raw.slice(1) : raw).split(/e/i);
  const shift = Number(exponentText);
  const [whole, decimals = ""] = mantissa.split(".");
  const digits = whole + decimals;
  const point = whole.length + shift;

  const plain =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${"0".repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;

  return negative ? `-${plain}` : plain;
};

/**
 * Render a balance, cutting it off after `decimals` places if given.
 *
 * Digits are only ever *truncated*, never rounded, so the figure on screen is
 * never worth more than the balance behind it. Pass `null` to show every digit
 * the value actually has — that is what the click-to-reveal uses.
 */
const formatBalance = (value: number, decimals: number | null): string => {
  const [integer, fraction = ""] = toExactString(value).split(".");
  // Trailing zeros carry no information, so they go — but nothing is ever
  // rounded up to fill their place.
  const shown = (
    decimals === null ? fraction : fraction.slice(0, decimals)
  ).replace(/0+$/, "");
  const grouped = formatter.format(Number(integer));
  return shown ? `${grouped}.${shown}` : grouped;
};

const NightshadeArcadeBalances: React.FC<{
  flowers: number;
  ravenCoins: number;
}> = ({ flowers, ravenCoins }) => {
  // FLOWER carries far more precision than fits on the HUD, so the arcade
  // truncates to 2 decimals and only reveals the exact figure on click, for a
  // few seconds. Truncation rather than rounding: the shown number is never
  // worth more than the balance behind it.
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
      className="flex cursor-pointer flex-col items-end space-y-1 !text-[28px]"
      onClick={() => setShowFullBalance(true)}
      title="Click to show the exact FLOWER balance"
    >
      {/* The main game puts its coin-family totals on the top row. */}
      <div className="relative flex items-center space-x-2">
        <div className="coins-bb-hud-backdrop absolute h-9 w-full -z-10" />
        <span className="balance-text mt-0.5">
          {formatBalance(ravenCoins, null)}
        </span>
        <img
          alt="RavenCoins"
          src={ravenCoinIcon}
          style={{ width: 25, height: 25 }}
        />
      </div>

      {/* FLOWER gets a row of its own underneath, as it does in the main game. */}
      <div className="relative flex items-center space-x-2">
        <div className="sfl-hud-backdrop absolute h-9 w-full -z-10" />
        <span className="balance-text">
          {formatBalance(flowers, showFullBalance ? null : BALANCE_DECIMALS)}
        </span>
        <img alt="FLOWER" src={flowerIcon} style={{ width: 26, height: 26 }} />
      </div>
    </div>
  );
};

export const NightshadeArcadeHud: React.FC<NightshadeArcadeHudProps> = ({
  extraRavenCoins,
  onOpenSettings,
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
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  /**
   * The farm number, when the session actually resolved one.
   *
   * `farmId` is 0 until the session lands and until the portal profile or JWT
   * supplies a real one (`resolveFarmId` in `lib/portal/playerData` returns 0 when
   * it finds nothing). Printing "Farm #0" would be worse than printing nothing,
   * and someone could then paste 0 into the dev form and queue a reward to a farm
   * that does not exist.
   *
   * Printed as bare digits, with no thousands separators, because this is a value
   * to be copied rather than read: it goes into the dev form's farm-number box,
   * and `Number("1,128,976,301,583,508")` is `NaN`. The 16 digits are hard to
   * transcribe by eye either way, so the click-to-copy is what makes this
   * usable — the grouping was only ever a legibility aid that cost correctness.
   */
  const hasFarmId = Number.isFinite(farmId) && farmId > 0;

  /**
   * Copy the farm number.
   *
   * `navigator.clipboard.writeText` is the obvious call and it fails here. It
   * rejects with `NotAllowedError: Document is not focused` whenever the game
   * window does not hold OS focus — which is the normal state for a tab the
   * player has backgrounded, for a second monitor, and for a browser window that
   * lost focus to devtools. Measured, not assumed: on this page `writeText`
   * rejected exactly that way while `document.execCommand("copy")` returned true.
   *
   * So the fallback is the older `execCommand` path, driven from a throwaway
   * textarea. It is deprecated but it is still the only thing that works without
   * document focus, and it is what makes this button dependable.
   *
   * Both paths are attempted and only a success is reported. A "Copied!" that did
   * not copy is worse than no feedback at all, because the player stops trying and
   * pastes the wrong thing into the dev form.
   */
  const copyFarmId = async (value: string) => {
    // Ordered deliberately: the API first because it is the modern path and does
    // not need a temporary node, `execCommand` second because it is the one that
    // survives an unfocused document. `execCommand` is also tried when the API is
    // *missing* rather than only when it rejects, so both paths run in sequence
    // and the first success wins.
    const copiedOk = (await copyViaClipboardApi(value)) || copyViaExecCommand(value);

    if (copiedOk) {
      setCopied(true);
    } else {
      setCopyFailed(true);
    }
    window.setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, FULL_BALANCE_HOLD_MS);
  };

  /**
   * The Reward Attempt voucher is an internal in-flight marker for a paid run,
   * not something a player holds. It is voided the moment its cabinet closes (see
   * `RewardAttemptCleanup`), so showing it here would only ever surface a stale
   * row.
   */
  const rewardAttemptToken = resolveRewardAttemptTokenKey({
    economyMeta,
    items: playerEconomy?.items,
    balances: playerEconomy?.balances,
  });

  /**
   * What the basket is allowed to show, and why there are two rules.
   *
   * The arcade holds three kinds of bookkeeping balance a player should never see:
   * the **Reward Attempt** voucher above, the **Dev Key** that gates the developer
   * mint, and the eleven **Free Run Tokens** that ration the daily allowance. Only
   * the first has a stable name we can resolve — a config that has not adopted the
   * others would have no such key — so the two filters are deliberately different:
   *
   *  - `rewardAttemptToken` matches the voucher **by name**, which keeps working
   *    on an economy that predates the editor flag;
   *  - `isHiddenBalanceItem` reads `is_visible: false`, which is what the editor's
   *    "Show in dashboard inventory" toggle publishes. The **landing-hub**
   *    inventory is SFL's own UI and reads that same flag, so one toggle in the
   *    editor is what keeps both inventories honest.
   *
   * Neither rule touches the balances: they are still minted, burned and
   * `require`d exactly as before, they simply have no row here.
   */
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
    // would read "0" instead of "Raven Coin". The session meta wins over
    // `playerEconomy.items`, matching every resolver in `lib/ravenCoin`.
    const catalogue = { ...playerEconomy?.items, ...economyMeta?.items };
    const itemFor = (token: string) => catalogue[token];
    const labelFor = (token: string) => itemFor(token)?.name ?? token;

    return Array.from(merged.entries())
      .filter(
        ([token]) =>
          token !== rewardAttemptToken &&
          !isHiddenBalanceItem(itemFor(token)),
      )
      .map(([token, amount]) => ({ token, label: labelFor(token), amount }))
      .sort((a, b) => b.amount - a.amount);
  }, [
    playerData.resolvedProfile.inventory,
    playerEconomy.balances,
    playerEconomy?.items,
    economyMeta?.items,
    rewardAttemptToken,
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

        {/* Identity block, top-left. The farm number is here because it is the
            only thing a player needs to hand over when someone sends them a
            reward, and reading a 16-digit number off a screenshot is a miserable
            way to do it. Click to copy.

            Shown only when the session actually resolved a farm: `farmId` is 0
            before the session lands (see `resolveFarmId`), and printing "Farm #
            0" would be worse than printing nothing. */}
        <div className="absolute left-3 top-3 rounded bg-black/55 px-3 py-2 text-xs text-white">
          <div className="font-semibold">
            {playerData.resolvedProfile.username ?? `Farmer #${farmId}`}
          </div>

          {hasFarmId ? (
            <button
              type="button"
              className={`mt-0.5 cursor-pointer text-left text-[11px] hover:underline ${
                copyFailed ? "text-red-300" : "text-[#8fe3a0]"
              }`}
              title="Copy farm number"
              onClick={(e) => {
                e.stopPropagation();
                void copyFarmId(String(farmId));
              }}
            >
              {copied
                ? "Copied!"
                : copyFailed
                  ? "Copy failed — select it"
                  : `Farm #${farmId}`}
            </button>
          ) : null}
        </div>

        <div className="absolute right-0 top-0 p-2.5">
          <NightshadeArcadeBalances
            flowers={flowers}
            ravenCoins={totalRavenCoins}
          />
        </div>

        {/* Sits directly under the totals — the rows end at 65px and this wrap
            adds its own 10px padding, so top-16 (64px) leaves a 9px gap rather
            than the 41px gap that top-24 used to leave. Kept as its own
            container so the two never overlap, whatever the totals do. */}
        <div className="absolute right-0 top-16 p-2.5 flex flex-col space-y-2.5">
          <PortalBasketButton onClick={() => setShowInventory(true)} />
        </div>

        {/* Settings lives in its own bottom-right corner rather than stacked under
            the inventory: the top-right column is already balances-then-inventory,
            and a third round button there crowds the numbers players actually read
            mid-run. Bottom-right is empty on every arcade scene and mirrors where
            the main game parks its own utility buttons. */}
        <div className="absolute bottom-3 right-3">
          <ArcadeSettingsButton onClick={onOpenSettings} />
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
