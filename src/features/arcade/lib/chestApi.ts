/**
 * Client for the chests' global tally (worker routes `/chest/*`).
 *
 * ## What this is for, and what it is not for
 *
 * The chests' **cap is not enforced here.** It is enforced by the
 * `chest_click_tracker` item's global `supply` in the Economy Editor, which the
 * server decrements as part of the same mint that hands over the Play Ticket —
 * atomic, and inside Sunflower Land where a player cannot edit it. See
 * `lib/ravenCoin.ts`.
 *
 * What the worker holds is the part the economy cannot express: **who got how
 * many**. There is no published ranking, no global counter readable per player
 * and no way to ask "top ten chest winners" through the economy API. So the
 * chest tells the worker after a successful payout, and reads the tally back to
 * put a leaderboard on the screen once the pot is empty.
 *
 * That makes every number here **advisory and best-effort**:
 *
 *  - A player who closes the tab between winning a ticket and the report
 *    reaching the worker is under-counted. The pot still moved — the server drew
 *    down the supply regardless — so the worst outcome is a leaderboard one row
 *    short and the end-of-the-line message arriving one click late.
 *  - A player who skips the report entirely (or is a cheater who never bothers)
 *    is under-counted in the same way. They cannot gain anything by doing it:
 *    the ticket was already minted, and there is no second door here.
 *  - KV is eventually consistent, so a concurrent burst of reports can lose a
 *    count or two.
 *
 * None of that can hand out a ticket the economy did not mint, which is the only
 * direction that matters. Treat the ledger as a scoreboard that is allowed to be
 * a little wrong, not as a ledger of record.
 */

import { call, rewardsWorkerConfigured } from "./rewardsApi";

export type ChestTallyEntry = {
  farmId: number;
  /** Sunflower Land's own username, or empty — the worker never takes one on trust. */
  username: string;
  /** Tickets this player has won from the chests. */
  tickets: number;
};

export type ChestTally = {
  /** Total the chests may ever hand out. Mirrors the tracker's `supply`. */
  cap: number;
  /** Handed out so far, as far as this worker has been told. */
  granted: number;
  /**
   * Advisory. The chest treats this as "show the end-of-the-line copy early",
   * and still honours a refusal from the economy as the real answer.
   */
  exhausted: boolean;
  /** Highest first. Bounded by the worker. */
  entries: ChestTallyEntry[];
  /** The caller's own row, or `null` if they have never won from a chest. */
  you: ChestTallyEntry | null;
};

/** The chest's own tally works or does not work with the rest of the reward UI. */
export const chestTallyConfigured = (): boolean => rewardsWorkerConfigured();

/** The current tally: how much is left, and who is at the top of it. */
export function fetchChestTally(
  token: string,
): Promise<
  | { ok: true; value: ChestTally }
  | { ok: false; error: string }
> {
  return call<ChestTally>("/chest", { token });
}

/**
 * Report one chest payout.
 *
 * Called *after* the economy has confirmed the mint, never before — the ticket
 * is the fact, this is the note about it. So a failure here is deliberately
 * swallowed by the caller: nothing about the player's reward depends on it.
 *
 * The worker only accepts an amount of 1. A chest pays one ticket, so there is
 * no legitimate larger figure, and accepting one would let a player paste
 * themselves to the top of a leaderboard they are only ever shown.
 */
export function recordChestTicket(
  token: string,
): Promise<
  | { ok: true; value: { farmId: number; tickets: number; granted: number } }
  | { ok: false; error: string }
> {
  return call<{ farmId: number; tickets: number; granted: number }>(
    "/chest/tickets",
    { token, method: "POST", body: { amount: 1 } },
  );
}