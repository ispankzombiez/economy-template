/**
 * machineMap.ts — arcade cabinet (Tiled object name) → registry game id.
 *
 * The Tiled map `assets/nightshade_arcade.json` contains an object layer
 * `Collision` with 16 objects named `Machine 1` … `Machine 16`, plus
 * `Claw Machine`, `daily chest` and `prize desk 1/2`.
 *
 * Only this file decides which game a cabinet launches. To re-point a cabinet,
 * edit the value below — no scene or React changes required.
 *
 * ── History ────────────────────────────────────────────────────────────────
 * Both the original source scene (`ispankzombiez/Sunflower-Land` @ `portal`,
 * `src/features/portal/nightshade-arcade/NightshadeArcadeScene.ts`) and the
 * first port used a hard-coded 10-branch if-chain covering machines 1–10 only.
 * That chain has been replaced by this lookup.
 *
 * ── Cabinets 12–16 are intentionally inert ──────────────────────────────────
 * The original arcade shipped exactly 10 games for 16 cabinets, so 11–16 were
 * dead in the original too. This fork wires `Machine 11` to `raven-bubbles`
 * (Raven Bubbles); 12–16 are still deliberately left unmapped. Do not map
 * template example apps (tile-jump, chicken-rescue, …) here — those are not
 * Nightshade Arcade games. `slots` / `roulette` exist as event types in
 * `lib/minigamesEvents.ts` but have never had components, so they are not
 * mapped either.
 */

/** Cabinet object name (lower-case) → `GAME_REGISTRY` id. */
export const MACHINE_TO_GAME: Readonly<Record<string, string>> = {
  // ── The original 10 cabinets / 10 games (unchanged from source) ──────────
  "machine 1": "poker",
  "machine 2": "blackjack",
  "machine 3": "gofish",
  "machine 4": "uno",
  "machine 5": "solitaire",
  "machine 6": "goblin-invaders",
  "machine 7": "tetris",
  "machine 8": "pac-man",
  "machine 9": "barley-breaker",
  "machine 10": "frogger",
  // ── This fork's eleventh cabinet ──────────────────────────────────────────
  "machine 11": "raven-bubbles",
};

/**
 * Resolve a Tiled object name to a registry game id.
 *
 * Matching is exact on the normalised name so `Machine 1` cannot accidentally
 * match `Machine 10`.
 */
export function getGameIdForMachine(
  rawName: string | null | undefined,
): string | undefined {
  if (!rawName) return undefined;
  return MACHINE_TO_GAME[rawName.trim().toLowerCase()];
}
