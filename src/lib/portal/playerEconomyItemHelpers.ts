import type { PlayerEconomyBalanceItem } from "./playerEconomyTypes";

/** True when the balance item is marked as a generator building in the published economy. */
export function isGeneratorBalanceItem(
  item: PlayerEconomyBalanceItem | undefined,
): boolean {
  return item?.generator === true;
}

/**
 * True when the published economy says this item is not for inventories.
 *
 * The editor's "Show in dashboard inventory" toggle serialises as `is_visible`,
 * and the key is absent for anything shown — so this is deliberately
 * `=== false` rather than a falsy check: an item we know nothing about stays
 * visible instead of silently disappearing from a player's list.
 */
export function isHiddenBalanceItem(
  item: PlayerEconomyBalanceItem | undefined,
): boolean {
  return item?.is_visible === false;
}
