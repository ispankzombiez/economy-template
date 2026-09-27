/**
 * Legacy portal helpers from the original arcade (`source-portal`
 * `features/portal/lib/portalUtil.ts`) — now inert.
 *
 * ## Why they no longer talk to the host page
 *
 * These were `postMessage` calls to the Sunflower Land frame that embeds the
 * arcade. The host reacted by looking the portal up in its minigame registry,
 * and a hosted *economy* (`Nightshade-Arcade`) is not a registered minigame, so
 * every reward run and every score produced an uncaught error in the **host**
 * page:
 *
 * ```
 * Uncaught Error: Nightshade-Arcade is not a valid minigame
 *   at startMinigameAttempt (...)
 *   at submitMinigameScore (...)
 * ```
 *
 * That is the `Uncaught Error` beta testers saw mid-hand in Blackjack. The
 * events are also redundant now — this arcade records both itself:
 *
 *  - **attempts** — `portalService.send({ type: "arcadeMinigame.started" })`,
 *    persisted through the economy's `dailyMinted` ledger;
 *  - **scores** — `submitScore` in `lib/portal/api`, from `handleWin`.
 *
 * The functions are kept (rather than deleted) so the ten ported games, which
 * were copied verbatim and still import them, keep compiling. They are
 * deliberately no-ops.
 */

const isInIframe = window.self !== window.top;

/**
 * Kept for the ported games' import list only.
 *
 * The "+1 reward attempt" purchase that used this was replaced by the Play
 * Ticket flow (`Mint-Play-Ticket` burns one, dispatched by the portal store),
 * so nothing calls it any more.
 */
export function purchase({
  sfl,
  items,
}: {
  sfl: number;
  items: Record<string, number>;
}) {
  void sfl;
  void items;
  void isInIframe;
}

/** Attempt recording now goes through `portalService` and the economy ledger. */
export function startAttempt() {}

/** Leaderboard submission now goes through `submitScore` in `lib/portal/api`. */
export function submitScore({ score }: { score: number }) {
  void score;
}
