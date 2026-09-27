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
 * ── Implementation status key ───────────────────────────────────────────────
 * backingType "local"      → fully playable React game component (owns back button via onBack)
 * backingType "scaffolded" → non-broken placeholder (owns back button via onBack)
 * backingType "portal"     → reserved for future hosted-portal integration
 *
 * ── Originals to restore from source-portal ─────────────────────────────────
 * [x] Poker              — local
 * [x] Blackjack          — local
 * [x] Go Fish            — local
 * [x] Uno                — local
 * [x] Solitaire          — local
 * [x] Goblin Invaders    — local
 * [x] Tetris             — local
 * [x] Barley Breaker     — local
 * [ ] Pac-Man            — stub (46 lines) vs 1,277-line original + session.ts
 * [ ] Frogger            — stub (46 lines) vs 1,293-line original + session.ts
 */
export const GAME_REGISTRY: ArcadeGameEntry[] = [
  // ── Migration checklist: completed ─────────────────────────────────────────
  {
    id: "poker",
    name: "Poker",
    description: "Texas Hold'em against the house.",
    tokenReward: 100,
    status: "available",
    backingType: "local",
    component: PokerGame,
  },
  {
    id: "blackjack",
    name: "Blackjack",
    description: "Beat the dealer without busting.",
    tokenReward: 100,
    status: "available",
    backingType: "local",
    component: BlackjackGame,
  },
  {
    id: "gofish",
    name: "Go Fish",
    description: "Collect matching sets before your opponent.",
    tokenReward: 75,
    status: "available",
    backingType: "local",
    component: GoFishGame,
  },
  {
    id: "uno",
    name: "Uno",
    description: "Play special cards to empty your hand first.",
    tokenReward: 90,
    status: "available",
    backingType: "local",
    component: UnoGame,
  },
  {
    id: "solitaire",
    name: "Solitaire",
    description: "Classic card-stacking challenge.",
    tokenReward: 70,
    status: "available",
    backingType: "local",
    component: SolitaireGame,
  },
  // ── Migration checklist: newly implemented (target-native) ──────────────────
  {
    id: "goblin-invaders",
    name: "Goblin Invaders",
    description: "Arcade survival shooter.",
    tokenReward: 120,
    status: "available",
    backingType: "local",
    component: GoblinInvadersGame,
    devNote:
      "Target-native Space Invaders variant. Source minigame id `goblin-invaders` is known; local source file in Sunflower-Land was not verified during the research handoff.",
  },
  {
    id: "tetris",
    name: "Tetris",
    description: "Clear lines with falling blocks.",
    tokenReward: 110,
    status: "available",
    backingType: "local",
    component: TetrisGame,
    devNote:
      "Target-native Tetris implementation. Source minigame id `tetris` is known; local source file in Sunflower-Land was not verified during the research handoff.",
  },
  {
    id: "barley-breaker",
    name: "Barley Breaker",
    description: "Classic 15-puzzle tile challenge.",
    tokenReward: 80,
    status: "available",
    backingType: "local",
    component: BarleyBreakerGame,
    devNote:
      "Target-native 15-puzzle implementation. Source minigame id `barley-breaker` is known; local source file in Sunflower-Land was not verified during the research handoff.",
  },
  // ── Migration checklist: scaffolded (pending implementation) ───────────────
  {
    id: "pac-man",
    name: "Pac-Man",
    description: "Navigate mazes and avoid enemies.",
    tokenReward: 95,
    status: "scaffolded",
    backingType: "scaffolded",
    component: PacManGame,
    portalId: "pac-man",
    devNote:
      "Scaffolded. Source minigame id `pac-man` is known; local source file in Sunflower-Land was not verified. Implement as target-native maze game (Path A) or confirm portal hosting (Path B).",
  },
  {
    id: "frogger",
    name: "Frogger",
    description: "Cross lanes and rivers safely.",
    tokenReward: 85,
    status: "scaffolded",
    backingType: "scaffolded",
    component: FroggerGame,
    portalId: "frogger",
    devNote:
      "Scaffolded. Source minigame id `frogger` is known; local source file in Sunflower-Land was not verified. Implement as target-native lane-crossing game (Path A) or confirm portal hosting (Path B).",
  },
];

/** Look up a registry entry by id. */
export function getGameEntry(id: string): ArcadeGameEntry | undefined {
  return GAME_REGISTRY.find((g) => g.id === id);
}
