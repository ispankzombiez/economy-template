import type {
  MinigameSessionEconomyMeta,
  MinigameSessionResponse,
} from "lib/portal/types";
import { emptySessionMinigame } from "lib/portal/runtimeHelpers";

// Editor-ready config: `features/arcade/nightshade-arcade-editor-sample.json`.
// Importing it (rather than duplicating the rules in TS) guarantees the offline
// shop renders exactly the economy you paste into the economy editor — edit the
// JSON once and both stay in sync.
import sample from "../nightshade-arcade-editor-sample.json";

/**
 * Shop / generator rules used when the app boots without a session.
 *
 * Same shape the Minigames API returns under `session.actions`, so the shop
 * component cannot tell the difference between offline and live.
 */
export const ARCADE_OFFLINE_ACTIONS: Record<string, unknown> = sample.actions;

/** `session.items` + `session.descriptions` stand-in: names, copy, marketplace ids. */
export function arcadeOfflineEconomyMeta(): MinigameSessionEconomyMeta {
  return {
    descriptions: sample.descriptions,
    items: sample.items,
  };
}

/**
 * Starting balances for a brand new (or offline) player.
 *
 * Derived from `items[token].initialBalance`, which is also honored by the
 * economy editor for new farms — so the offline sandbox starts with the same
 * RavenCoins a real player would. Without it the shop would render but every
 * row would be unaffordable.
 */
export function arcadeOfflineMinigame(): MinigameSessionResponse["playerEconomy"] {
  const base = emptySessionMinigame();

  for (const [token, item] of Object.entries(sample.items)) {
    // JSON imports infer a union of literal shapes; narrow defensively.
    const initial = (item as { initialBalance?: number }).initialBalance;
    if (typeof initial === "number" && initial > 0) {
      base.balances[token] = initial;
    }
  }

  return base;
}
