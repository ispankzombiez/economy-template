import React, { useMemo, useState } from "react";
import { Button } from "components/ui/Button";
import { Label } from "components/ui/Label";
import { useMinigameSession } from "lib/portal";
import { NightshadeArcadeDevMint } from "./NightshadeArcadeDevMint";

type EconomyAction = {
  type?: string;
  showInShop?: boolean;
  mint?: Record<string, { amount?: number } | number>;
  burn?: Record<
    string,
    { amount?: number; min?: number; max?: number } | number
  >;
};

type NightshadeArcadeShopProps = {
  onClose: () => void;
  /**
   * Whether to offer the developer Play Ticket mint.
   *
   * Resolved by the app through `lib/devAccess` so this component stays a plain
   * view. Note the gate is cosmetic — see `lib/devAccess.ts` and the warning on
   * `NightshadeArcadeDevMint` — the action's own `dailyCap` is what the server
   * enforces.
   */
  isDev?: boolean;
};

function toAmount(rule: unknown): number | null {
  if (typeof rule === "number") return rule;
  if (rule && typeof rule === "object" && "amount" in rule) {
    const amount = (rule as { amount?: number }).amount;
    return typeof amount === "number" ? amount : null;
  }
  return null;
}

export const NightshadeArcadeShop: React.FC<NightshadeArcadeShopProps> = ({
  onClose,
  isDev = false,
}) => {
  const { actions, dispatchAction, apiError, economyMeta } =
    useMinigameSession();
  const [localError, setLocalError] = useState<string | null>(null);
  const [showDevMint, setShowDevMint] = useState(false);

  const shopItems = useMemo(
    () =>
      Object.entries(actions as Record<string, EconomyAction>).filter(
        ([, action]) => action?.type === "shop" && action.showInShop !== false,
      ),
    [actions],
  );

  /**
   * Shop rules only carry `type` / `showInShop` / `burn` / `mint` — they have no
   * display copy. The template resolves a product's name, description and art
   * from `session.items[mintedToken]` (see `examples/ui-resources`), so do the
   * same here; otherwise every row would be titled with its raw action id
   * (`buy_nightshade_ticket` instead of `Nightshade Ticket`).
   */
  /**
   * Display name for an economy token.
   *
   * Hosted configs key items numerically (`"0"`, `"1"`), so printing the raw key
   * would show "Cost: 50 0" instead of "Cost: 50 Raven Coins". An offline sample
   * keys its items by name, in which case the token already reads correctly.
   */
  const labelFor = (token: string) =>
    economyMeta?.items?.[token]?.name ?? token;

  const displayFor = (id: string, action: EconomyAction) => {
    const mintedToken = Object.keys(action.mint ?? {})[0];
    const meta = mintedToken ? economyMeta?.items?.[mintedToken] : undefined;

    return {
      image: meta?.image,
      name: meta?.name ?? id,
      description: meta?.description,
      /** Action id — what `dispatchAction` needs. */
      actionId: id,
    };
  };

  return (
    <div className="w-full max-w-md rounded bg-[#1f1529] p-4 text-white">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Raven Coin Shop</h2>
        <Button onClick={onClose}>Close</Button>
      </div>

      {shopItems.length === 0 ? (
        <Label type="danger">No shop items are available right now.</Label>
      ) : (
        <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1">
          {shopItems.map(([id, action]) => {
            const burn = Object.entries(action.burn ?? {});
            const mint = Object.entries(action.mint ?? {});
            const hasRangedCost = burn.some(
              ([, value]) => toAmount(value) == null,
            );
            const { name, description, image } = displayFor(id, action);

            return (
              <div
                key={id}
                className="rounded border border-white/15 bg-black/30 p-3"
              >
                <div className="flex items-center gap-2">
                  {image ? (
                    <img
                      src={image}
                      alt=""
                      className="h-6 w-6 object-contain"
                    />
                  ) : null}
                  <div className="text-xs font-semibold">{name}</div>
                </div>
                {description ? (
                  <div className="mt-1 text-[11px] text-[#dfc7f1]">
                    {description}
                  </div>
                ) : null}
                {burn.length > 0 ? (
                  <div className="mt-2 text-[11px] text-[#f7d2dd]">
                    Cost:{" "}
                    {burn
                      .map(([token, value]) =>
                        toAmount(value) == null
                          ? `${labelFor(token)} (variable)`
                          : `${toAmount(value)} ${labelFor(token)}`,
                      )
                      .join(" + ")}
                  </div>
                ) : null}
                {mint.length > 0 ? (
                  <div className="mt-1 text-[11px] text-[#c9e5ff]">
                    Reward:{" "}
                    {mint
                      .map(([token, value]) =>
                        toAmount(value) == null
                          ? labelFor(token)
                          : `${toAmount(value)} ${labelFor(token)}`,
                      )
                      .join(", ")}
                  </div>
                ) : null}
                <div className="mt-2">
                  <Button
                    disabled={hasRangedCost}
                    onClick={() => {
                      setLocalError(null);
                      const result = dispatchAction({ action: id });
                      if (!result.ok) {
                        setLocalError(result.error);
                      }
                    }}
                  >
                    {hasRangedCost ? "Unavailable" : "Buy"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isDev ? (
        <div className="mt-4 rounded border border-amber-400/40 bg-amber-400/10 p-3">
          <div className="text-xs font-semibold text-amber-200">
            Developer tools
          </div>
          <div className="mt-1 text-[11px] text-[#dfc7f1]">
            Mint Play Tickets for testing. Capped per day by the server, and
            remove this action from the economy before launch.
          </div>
          <div className="mt-2">
            <Button onClick={() => setShowDevMint(true)}>
              Mint Play Tickets
            </Button>
          </div>
        </div>
      ) : null}

      {localError ? (
        <div className="mt-3 text-xs text-red-300">{localError}</div>
      ) : null}
      {apiError ? (
        <div className="mt-2 text-xs text-red-300">{apiError}</div>
      ) : null}

      {showDevMint ? (
        <NightshadeArcadeDevMint onClose={() => setShowDevMint(false)} />
      ) : null}
    </div>
  );
};
