/**
 * Build-time portal / API settings (mirrors Chicken Rescue `lib/config` subset).
 */
function defaultImageBase(): string {
  const raw =
    import.meta.env.VITE_IMAGE_BASE_URL ||
    "https://sunflower-land.com/testnet-assets";
  return raw.replace(/\/$/, "");
}

const API_URL = import.meta.env.VITE_API_URL as string | undefined;
const PORTAL_APP = import.meta.env.VITE_PORTAL_APP as string | undefined;
const PORTAL_GAME_URL = import.meta.env.VITE_PORTAL_GAME_URL as string | undefined;
/** Minigames API Gateway: `/data`, `/action`, `/bumpkins/metadata/...`. */
const MINIGAMES_API_URL = import.meta.env.VITE_MINIGAMES_API_URL as
  | string
  | undefined;

const PROTECTED_IMAGE_URL =
  (import.meta.env.VITE_PRIVATE_IMAGE_URL as string | undefined)?.trim() ||
  defaultImageBase();

const NETWORK =
  (import.meta.env.VITE_NETWORK as "mainnet" | "amoy" | undefined) || "mainnet";

/**
 * Reward-request worker (see `worker/`). Holds the arcade's outstanding rewards
 * and answers "is this request actually for the person asking?".
 *
 * Unset means the My Rewards button and the dev request form do not render at
 * all, rather than rendering something that cannot work. That is the safe
 * default for a build that has not been pointed at a worker.
 */
const REWARDS_WORKER_URL = (
  import.meta.env.VITE_REWARDS_WORKER_URL as string | undefined
)?.trim();

const CLIENT_VERSION =
  (import.meta.env.VITE_CLIENT_VERSION as string | undefined)?.trim() || "dev";

const PORTAL_CR_ACTION_START_BASIC = import.meta.env
  .VITE_PORTAL_CR_ACTION_START_BASIC as string | undefined;
const PORTAL_CR_ACTION_GAME_OVER_BASIC = import.meta.env
  .VITE_PORTAL_CR_ACTION_GAME_OVER_BASIC as string | undefined;
const PORTAL_CR_ACTION_START_ADVANCED = import.meta.env
  .VITE_PORTAL_CR_ACTION_START_ADVANCED as string | undefined;
const PORTAL_CR_ACTION_GAME_OVER_ADVANCED = import.meta.env
  .VITE_PORTAL_CR_ACTION_GAME_OVER_ADVANCED as string | undefined;

/**
 * Economy `items` key passed in `amounts` for `GAMEOVER` ranged mint (must match the portal
 * config’s `actions.GAMEOVER.mint`). Bumpkin Hunter / skull-style configs typically use `"0"`;
 * chicken-rescue-v2 uses `"1"` for chooks.
 */
const GAMEOVER_MINT_TOKEN_KEY = (
  import.meta.env.VITE_GAMEOVER_MINT_TOKEN_KEY as string | undefined
)?.trim();

/** Production Colyseus endpoint (fixed; not configurable via env). */
const MMO_PRODUCTION_ROOM_URL = "wss://mmo.sunflower-land.com";

export const CONFIG = {
  API_URL,
  PORTAL_APP,
  PORTAL_GAME_URL: PORTAL_GAME_URL || "https://sunflower-land.com",
  MINIGAMES_API_URL,
  /** CDN / image host for Phaser tilesets, SFX, and SUNNYSIDE URLs. */
  PROTECTED_IMAGE_URL,
  NETWORK,
  CLIENT_VERSION,
  PORTAL_CR_ACTION_START_BASIC,
  PORTAL_CR_ACTION_GAME_OVER_BASIC,
  PORTAL_CR_ACTION_START_ADVANCED,
  PORTAL_CR_ACTION_GAME_OVER_ADVANCED,
  /** Default `"0"` when env unset; set to `1` when testing with chicken-rescue-v2 JWT. */
  GAMEOVER_MINT_TOKEN_KEY: GAMEOVER_MINT_TOKEN_KEY || "0",
  /**
   * Base URL of the reward-request worker, without a trailing slash. Undefined
   * when `VITE_REWARDS_WORKER_URL` is unset, which hides the reward UI.
   */
  REWARDS_WORKER_URL: REWARDS_WORKER_URL
    ? REWARDS_WORKER_URL.replace(/\/$/, "")
    : undefined,
  /** Sunflower Land production MMO (`wss://mmo.sunflower-land.com`). */
  MMO_PRODUCTION_ROOM_URL,
};
