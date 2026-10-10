/**
 * The entryway chests' click streak.
 *
 * ## What this counts
 *
 * Both chests share **one** streak. Clicking either advances it; a streak is not
 * per-chest, so alternating between the two is a legitimate way to keep it
 * alive. {@link CHEST_STREAK_CLICKS} chest clicks in a row pays one Play
 * Ticket.
 *
 * ## What "in a row" means
 *
 * Exactly three things end a streak:
 *
 *  1. **A click on anything that is not a chest.** The scenes emit
 *     `emitNonChestClick` for a machine, a prize desk or Raven, so wandering off
 *     to play a cabinet costs the streak. This is the rule that stops the chest
 *     being something you click twice a day.
 *  2. **A gap of {@link CHEST_STREAK_RESET_MS} or more** between two chest
 *     clicks. Checked lazily, on the next click, so there is no timer to leak.
 *  3. **A page load.** State is in this module and nowhere else — no
 *     `localStorage`, no session restore — so a refresh starts everyone at zero.
 *
 * Completing a streak resets the count rather than rolling over, which is what
 * lets the chests pay out more than once in a session.
 *
 * ## Why the count is not on screen anywhere
 *
 * It is not a combo meter, and there is deliberately no progress bar, tick sound
 * or floating number. The whole feature is a secret the owner does not
 * publicise, and a visible counter would turn it into a chore rather than the
 * accident it is meant to feel like. The player's only feedback is the popup at
 * 50, or nothing at all — see `NightshadeArcadeApp`'s chest handler.
 */

/** Chest clicks in a row before the chest pays out. */
export const CHEST_STREAK_CLICKS = 50;

/** A gap of this many milliseconds or more between clicks ends the streak. */
export const CHEST_STREAK_RESET_MS = 10_000;

/**
 * In-memory streak. Deliberately a module singleton rather than React state:
 *
 *  - chest clicks arrive from Phaser through `nightshadeArcadeEvents`, outside
 *    React's render cycle, and a `useState` setter would not have committed
 *    between two clicks in the same tick;
 *  - it is ephemeral by design, so it needs no provider, no store entry and no
 *    cleanup beyond unmount.
 *
 * `now` is injectable so the time-based reset is testable without a fake clock.
 */
class ChestStreak {
  private streak = 0;
  private lastClickAt = 0;

  /** Clicks banked so far in the current streak. */
  get count(): number {
    return this.streak;
  }

  /**
   * Register one chest click.
   *
   * Returns `true` on the click that completed a streak, so the caller can pay
   * out. The count resets to zero on that same click.
   */
  click(now: number = Date.now()): boolean {
    // The first click of a streak always starts a new one: there is no previous
    // click to measure a gap from, so `streak === 0` is what makes `lastClickAt`
    // irrelevant here.
    const continues =
      this.streak > 0 && now - this.lastClickAt < CHEST_STREAK_RESET_MS;

    this.streak = continues ? this.streak + 1 : 1;
    this.lastClickAt = now;

    if (this.streak < CHEST_STREAK_CLICKS) {
      return false;
    }

    this.reset();
    return true;
  }

  /** A click that was not on a chest. Ends the streak. */
  miss(): void {
    this.reset();
  }

  /** Forget the streak without pretending anything was clicked. */
  reset(): void {
    this.streak = 0;
    this.lastClickAt = 0;
  }
}

export const chestStreak = new ChestStreak();