/**
 * Event emitter for Nightshade Arcade interactions
 * Used to communicate between NightshadeArcadeScene and NightshadeArcade component
 */
export const nightshadeArcadeEvents = {
  onChestClicked: null as (() => void) | null,
  /**
   * A click on an interactable that is **not** a chest — a machine, a prize
   * desk, Raven. Its only consumer is the chest streak, which it ends: see
   * `lib/chestStreak.ts`.
   *
   * Emitted from the same `pointerdown` handlers that open the thing that was
   * clicked, so the streak breaks whether or not the player was close enough to
   * actually use it. Wandering off to play a cabinet is meant to cost the run.
   */
  onNonChestClick: null as (() => void) | null,
  onMinigameRequested: null as ((gameType: string) => void) | null,
  onOpenShop: null as (() => void) | null,
  isMinigameActive: false,

  setMinigameActive(active: boolean) {
    this.isMinigameActive = active;
  },

  registerChestClickHandler(callback: (() => void) | null) {
    this.onChestClicked = callback;
  },

  registerNonChestClickHandler(callback: (() => void) | null) {
    this.onNonChestClick = callback;
  },

  registerMinigameHandler(callback: ((gameType: string) => void) | null) {
    this.onMinigameRequested = callback;
  },

  registerShopHandler(callback: (() => void) | null) {
    this.onOpenShop = callback;
  },

  emitChestClicked() {
    if (this.onChestClicked) {
      this.onChestClicked();
    }
  },

  emitNonChestClick() {
    if (this.onNonChestClick) {
      this.onNonChestClick();
    }
  },

  emitMinigameRequested(gameType: string) {
    if (this.onMinigameRequested) {
      this.onMinigameRequested(gameType);
    }
  },

  emitOpenShop() {
    if (this.onOpenShop) {
      this.onOpenShop();
    }
  },
};
