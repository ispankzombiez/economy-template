import type { InventoryItemName } from "./gameTypes";

/**
 * Faithful port of `features/portal/lib/portalUtil.ts` from the original
 * arcade (`source-portal`).
 *
 * These are **postMessage** calls to the hosting portal frame, not HTTP
 * requests — `startAttempt` / `submitScore` / `purchase` never touch the
 * Minigames API, so they are safe to run in an offline/local build. Outside an
 * iframe (the arcade running standalone) they degrade exactly as they did
 * before: attempts and scores are dropped, purchases self-confirm.
 *
 * Only the three helpers the ten games import are kept.
 */

const isInIframe = window.self !== window.top;

/**
 * Allow a player to spend FLOWER or items in your game.
 *
 * The arcade uses this for the "+1 reward attempt" button. Without a parent
 * frame it self-confirms (the original also posted a `purchased` event to
 * itself), but the arcade's local GameState has no FLOWER to deduct, so the
 * button stays disabled until a live session supplies a balance.
 */
export function purchase({
  sfl,
  items,
}: {
  sfl: number;
  items: Partial<Record<InventoryItemName, number>>;
}) {
  if (!isInIframe) {
    window.postMessage({ event: "purchased", sfl, items }, "*");
  } else {
    window.parent.postMessage({ event: "purchase", sfl, items }, "*");
  }
}

/** Starts a minigame attempt (the parent frame records it). */
export function startAttempt() {
  if (isInIframe) {
    window.parent.postMessage({ event: "attemptStarted" }, "*");
  }
}

/** Submits a minigame score (the parent frame records it). */
export function submitScore({ score }: { score: number }) {
  if (isInIframe) {
    window.parent.postMessage({ event: "scoreSubmitted", score }, "*");
  }
}
