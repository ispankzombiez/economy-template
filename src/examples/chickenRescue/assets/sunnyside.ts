/**
 * CDN URL helpers for the template's example games and the arcade (paths match
 * main-game PROTECTED_IMAGE_URL layout).
 */
import { CONFIG } from "lib/config";

const B = () => CONFIG.PROTECTED_IMAGE_URL;

export const SUNNYSIDE = {
  icons: {
    expression_alerted: `${B()}/icons/expression_alerted.png`,
    expression_confused: `${B()}/icons/expression_confused.png`,
    close: `${B()}/icons/close.png`,
    arrow_left: `${B()}/icons/arrow_left.png`,
    basket: `${B()}/icons/basket.png`,
    confirm: `${B()}/icons/confirm.png`,
    timer: `${B()}/icons/timer.png`,
    hammer: `${B()}/icons/hammer.png`,
    disc: `${B()}/icons/disc.png`,
    heart: `${B()}/icons/heart.png`,
    sad: `${B()}/icons/sad.png`,
    happy: `${B()}/icons/happy.png`,
    search: `${B()}/icons/search.png`,
    // Sunflower Brawler: the projectile sprites and the impact mark.
    lightning: `${B()}/icons/lightning.png`,
    expression_attack: `${B()}/icons/expression_attack.png`,
    angry: `${B()}/icons/angry.png`,
    // The main game's own settings glyph, so the arcade's settings button is the
    // same icon players already know from the HUD. Same path on the same CDN.
    // (`hammer` above is the mark on the Developer row.)
    settings: `${B()}/icons/settings.png`,
  },
  decorations: {
    skull: `${B()}/decorations/skull.webp`,
  },
  // Used by the arcade's Frogger (splash art).
  brand: {
    water_landing: `${B()}/brand/water_landing.webp`,
  },
  npcs: {
    bumpkin: `${B()}/npcs/idle.gif`,
    // Used by the arcade's Goblin Invaders.
    goblin: `${B()}/npcs/goblin.gif`,
  },
  resource: {
    stone_rock: `${B()}/resources/stone_rock.png`,
    boulder: `${B()}/resources/rare_mine.png`,
  },
  ui: {
    round_button: `${B()}/ui/round_button.png`,
    round_button_pressed: `${B()}/ui/round_button_pressed.png`,
  },
} as const;
