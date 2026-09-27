/**
 * Minigames Event Emitter
 * Manages communication between the portal scene and minigame modals
 */

/**
 * Every launchable arcade game id.
 *
 * These are the original Nightshade Arcade ids (matching `GAME_REGISTRY` and
 * `data/machineMap.ts`), plus `slots` / `roulette` which the source repo
 * declared but never shipped components for — kept so a future cabinet mapping
 * still type-checks.
 *
 * Template example ids (tile-jump, hide-and-seek, chicken-rescue,
 * golden-crops, plaza-party, ui-resources) were briefly added during the port
 * and have been removed: they are not Nightshade Arcade games.
 */
export type MinigameType =
  | "poker"
  | "slots"
  | "barley-breaker"
  | "roulette"
  | "blackjack"
  | "gofish"
  | "uno"
  | "solitaire"
  | "goblin-invaders"
  | "tetris"
  | "pac-man"
  | "frogger";

interface MinigameEvent {
  type: MinigameType;
  machineId?: string;
}

class MinigamesEventEmitter {
  private listeners: Map<MinigameType, Set<() => void>> = new Map();

  subscribe(gameType: MinigameType, callback: () => void): () => void {
    if (!this.listeners.has(gameType)) {
      this.listeners.set(gameType, new Set());
    }
    this.listeners.get(gameType)!.add(callback);

    // Return unsubscribe function
    return () => {
      this.listeners.get(gameType)?.delete(callback);
    };
  }

  emit(event: MinigameEvent): void {
    const callbacks = this.listeners.get(event.type);
    if (callbacks) {
      callbacks.forEach((callback) => callback());
    }
  }
}

export const minigamesEventEmitter = new MinigamesEventEmitter();
