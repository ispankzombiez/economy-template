import { BlackjackGame } from "./blackjack/BlackjackGame";
import { GoFishGame } from "./gofish/GoFishGame";
import { UnoGame } from "./uno/UnoGame";
import { SolitaireGame } from "./solitaire/SolitaireGame";
import { PokerGame } from "./poker/PokerGame";
import { BarleyBreakerGame } from "./barleybreaker/BarleyBreakerGame";
import { TetrisGame } from "./tetris/TetrisGame";
import { GoblinInvadersGame } from "./goblininvaders/GoblinInvadersGame";
import { PacManGame } from "./pacman/PacManGame";
import { FroggerGame } from "./frogger/FroggerGame";
import { withArcadeProps } from "./adapters/withArcadeProps";
import type { ArcadeGameEntry } from "../types";

/**
 * Central arcade game registry — one entry per real Nightshade Arcade cabinet.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * The original arcade (`ispankzombiez/Sunflower-Land` @ `portal`,
 * `src/features/portal/nightshade-arcade/mini-games/`) shipped exactly **10**
 * games, which map 1:1 onto Tiled cabinets `Machine 1`…`Machine 10` (see
 * `../data/machineMap.ts`). Cabinets 11–16 were never wired, in the original
 * either, and are intentionally left inert.
 *
 * Template example apps (tile-jump, hide-and-seek, chicken-rescue,
 * golden-crops, plaza-party, ui-resources) were briefly registered here during
 * the port. They are **not** Nightshade Arcade games and have been pruned.
 *
 * ── Restore status ──────────────────────────────────────────────────────────
 * All ten are the **original** components, copied verbatim from `source-portal`
 * and re-wired through `games/adapters/` (the only thing changed in each file
 * is the import list). Every entry is therefore `local` + `available`.
 *
 * ── How an original plugs into the arcade ───────────────────────────────────
 * The originals are `React.FC<{ onClose?: () => void }>` and talk to an xstate
 * portal machine this template does not have. `withArcadeProps` supplies that
 * wiring: it mounts `ArcadePortalProvider`, translates `onClose` → `onBack`,
 * and turns the game's own `arcadeMinigame.ravenCoinWon` event into `onWin`.
 *
 * ── tokenReward ─────────────────────────────────────────────────────────────
 * Informational only — each game reports its prize itself via
 * `*_RAVEN_COIN_REWARD`, and every one of the originals is set to 1 RavenCoin.
 * These values mirror that so the hub can never advertise more than a game
 * actually pays out.
 */
export const GAME_REGISTRY: ArcadeGameEntry[] = [
  {
    id: "poker",
    name: "Poker",
    description: "Texas Hold'em against the house.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(PokerGame),
  },
  {
    id: "blackjack",
    name: "Blackjack",
    description: "Beat the dealer without busting.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(BlackjackGame),
  },
  {
    id: "gofish",
    name: "Go Fish",
    description: "Collect matching sets before your opponent.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(GoFishGame),
  },
  {
    id: "uno",
    name: "Uno",
    description: "Play special cards to empty your hand first.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(UnoGame),
  },
  {
    id: "solitaire",
    name: "Solitaire",
    description: "Classic card-stacking challenge.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(SolitaireGame),
  },
  {
    id: "goblin-invaders",
    name: "Goblin Invaders",
    description: "Arcade survival shooter.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(GoblinInvadersGame),
  },
  {
    id: "tetris",
    name: "Tetris",
    description: "Clear lines with falling blocks.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(TetrisGame),
  },
  {
    id: "barley-breaker",
    name: "Barley Breaker",
    description: "Classic 15-puzzle tile challenge.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(BarleyBreakerGame),
  },
  {
    id: "pac-man",
    name: "Pac-Man",
    description: "Navigate mazes and avoid enemies.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(PacManGame),
  },
  {
    id: "frogger",
    name: "Frogger",
    description: "Cross lanes and rivers safely.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(FroggerGame),
  },
];

/** Look up a registry entry by id. */
export function getGameEntry(id: string): ArcadeGameEntry | undefined {
  return GAME_REGISTRY.find((g) => g.id === id);
}
