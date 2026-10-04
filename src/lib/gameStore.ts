import { atom } from "nanostores";
import type { PlayerProfile } from "lib/api";

/** Shared client state for React + Phaser (see docs/TECHNICAL.md). */
export type GameState = {
  coins: number;
  /** Hide & Seek (and similar) scoring. */
  skulls: number;
  anonymous: boolean;
  /**
   * Key of the Phaser scene the player is currently on, published by each
   * scene's `create()`.
   *
   * React cannot work this out for itself: the floors are swapped by Phaser
   * (a Tiled warp calling `scene.start`), so the current one only exists inside
   * the game. Anything that has to react to *which floor* — the music, for one —
   * reads it from here.
   *
   * Deliberately never cleared on scene shutdown. The next floor publishes in
   * its own `create()`, so clearing would only publish a gap that makes anything
   * watching flicker between the two floors' state.
   */
  activeSceneId?: string;
};

export const $gameState = atom<GameState>({
  coins: 0,
  skulls: 0,
  anonymous: true,
});

export function hydrateGameState(profile: PlayerProfile): void {
  $gameState.set({
    ...$gameState.get(),
    coins: profile.coins,
    skulls: profile.skulls ?? $gameState.get().skulls,
    anonymous: profile.anonymous,
  });
}

export function patchGameState(partial: Partial<GameState>): void {
  $gameState.set({ ...$gameState.get(), ...partial });
}
