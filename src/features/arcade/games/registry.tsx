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
import { RavenBubblesGame } from "./ravenbubbles/RavenBubblesGame";
import { SunflowerBrawlerGame } from "./sunflowerbrawler/SunflowerBrawlerGame";
import { withArcadeProps } from "./adapters/withArcadeProps";
import type { ArcadeGameEntry } from "../types";

import pokerMusic from "../assets/poker_music.mp3";
import blackjackMusic from "../assets/black_jack_music.mp3";
import goFishMusic from "../assets/go_fish_music.mp3";
import unoMusic from "../assets/uno_music.mp3";
import solitaireMusic from "../assets/solitare_music.mp3";
import goblinInvadersMusic from "../assets/goblin_invaders_music.mp3";
import tetrisMusic from "../assets/tetris_music.mp3";
import pacManMusic from "../assets/bumpkin_man_music.mp3";
import barleyBreakerMusic from "../assets/barley_breaker_music.mp3";
import froggerMusic from "../assets/frogger_music.mp3";
import ravenBubblesMusic from "../assets/raven_bubbles_music.mp3";
import sunflowerBrawlerMusic from "../assets/sunflower_brawler_music.mp3";

/**
 * Central arcade game registry — one entry per real Nightshade Arcade cabinet.
 *
 * ── Scope ───────────────────────────────────────────────────────────────────
 * The original arcade (`ispankzombiez/Sunflower-Land` @ `portal`,
 * `src/features/portal/nightshade-arcade/mini-games/`) shipped exactly **10**
 * games, which map 1:1 onto Tiled cabinets `Machine 1`…`Machine 10` (see
 * `../data/machineMap.ts`). Cabinets 12–16 were never wired, in the original
 * either, and are intentionally left inert.
 *
 * This fork adds an eleventh, `raven-bubbles` (Raven Bubbles), on `Machine 11`
 * — the first cabinet the original left empty.
 *
 * Template example apps (tile-jump, hide-and-seek, chicken-rescue,
 * golden-crops, plaza-party, ui-resources) were briefly registered here during
 * the port. They are **not** Nightshade Arcade games and have been pruned.
 *
 * ── Restore status ──────────────────────────────────────────────────────────
 * The ten originals are the **original** components, copied verbatim from
 * `source-portal` and re-wired through `games/adapters/` (the only thing
 * changed in each file is the import list). Every entry is therefore `local` +
 * `available`. `raven-bubbles` is written natively against the same adapters.
 *
 * ── How an original plugs into the arcade ───────────────────────────────────
 * The originals are `React.FC<{ onClose?: () => void }>` and talk to an xstate
 * portal machine this template does not have. `withArcadeProps` supplies that
 * wiring: it mounts `ArcadePortalProvider`, translates `onClose` → `onBack`,
 * and turns the game's own `arcadeMinigame.ravenCoinWon` event into `onWin`.
 *
 * ── Adding a soundtrack ──────────────────────────────────────────────────────
 * Per-game music is a `music` field on the entry, holding a Vite asset import.
 * Drop the file in `../assets/` and add two lines beside the entry:
 *
 *     import myMusic from "../assets/my_game.mp3";
 *     // ...
 *     music: myMusic,
 *
 * It takes over from the floor's music the moment the cabinet is clicked and
 * hands back on exit — see `useArcadeMusic`. Entries without one keep playing
 * their floor's music, so tracks can be added one game at a time.
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
    component: withArcadeProps(PokerGame, "poker"),
    music: pokerMusic,
  },
  {
    id: "blackjack",
    name: "Blackjack",
    description: "Beat the dealer without busting.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(BlackjackGame, "blackjack"),
    music: blackjackMusic,
  },
  {
    id: "gofish",
    name: "Go Fish",
    description: "Collect matching sets before your opponent.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(GoFishGame, "gofish"),
    music: goFishMusic,
  },
  {
    id: "uno",
    name: "Uno",
    description: "Play special cards to empty your hand first.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(UnoGame, "uno"),
    music: unoMusic,
  },
  {
    id: "solitaire",
    name: "Solitaire",
    description: "Classic card-stacking challenge.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(SolitaireGame, "solitaire"),
    music: solitaireMusic,
  },
  {
    id: "goblin-invaders",
    name: "Goblin Invaders",
    description: "Arcade survival shooter.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(GoblinInvadersGame, "goblin-invaders"),
    music: goblinInvadersMusic,
  },
  {
    id: "tetris",
    name: "Tetris",
    description: "Clear lines with falling blocks.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(TetrisGame, "tetris"),
    music: tetrisMusic,
  },
  {
    id: "barley-breaker",
    name: "Barley Breaker",
    description: "Classic 15-puzzle tile challenge.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(BarleyBreakerGame, "barley-breaker"),
    music: barleyBreakerMusic,
  },
  {
    id: "pac-man",
    name: "Pac-Man",
    description: "Navigate mazes and avoid enemies.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(PacManGame, "pac-man"),
    // The file is named for the source game's own title: `PacManGame` was
    // ported from a game called Bumpkin-Man, and its exit dialog still says
    // "Exit Bumpkin-Man?". Only the in-game copy carries that name — the
    // registry id and the hub both call it `pac-man` / "Pac-Man".
    music: pacManMusic,
  },
  {
    id: "frogger",
    name: "Frogger",
    description: "Cross lanes and rivers safely.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(FroggerGame, "frogger"),
    music: froggerMusic,
  },
  {
    id: "raven-bubbles",
    name: "Raven Bubbles",
    description: "Pop crop bubbles and hit the target score.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(RavenBubblesGame, "raven-bubbles"),
    music: ravenBubblesMusic,
  },
  {
    id: "sunflower-brawler",
    name: "Sunflower Brawler",
    description: "Fifteen waves down a scrolling street, then endless.",
    tokenReward: 1,
    status: "available",
    backingType: "local",
    component: withArcadeProps(SunflowerBrawlerGame, "sunflower-brawler"),
    music: sunflowerBrawlerMusic,
  },
];

/** Look up a registry entry by id. */
export function getGameEntry(id: string): ArcadeGameEntry | undefined {
  return GAME_REGISTRY.find((g) => g.id === id);
}
