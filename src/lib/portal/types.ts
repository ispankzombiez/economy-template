import type {
  PlayerEconomyBalanceItem,
  PlayerEconomyDescriptions,
} from "./playerEconomyTypes";

/** Session metadata merged into dashboard / config (`items`, theme, optional game data). */
export type MinigameSessionEconomyMeta = {
  items?: Record<string, PlayerEconomyBalanceItem>;
  descriptions?: PlayerEconomyDescriptions;
  visualTheme?: string;
  playUrl?: string;
  mainCurrencyToken?: string;
  dashboard?: {
    visualTheme?: string;
    /**
     * Optional server-defined Hide & Seek round (same shape as client).
     * When omitted, the game generates a random round locally.
     */
    hideAndSeekRound?: {
      eatOrder: Array<{ npcName: string; tokenParts: string }>;
      npcSpawnList: Array<{ npcName: string; tokenParts: string }>;
    };
  };
};

export type PortalLaunchContext = {
  href: string;
  embedded: boolean;
  query: Record<string, string>;
  jwt?: string;
  network?: string;
  language?: string;
  font?: string;
  apiUrl?: string;
  minigamesApiUrl?: string;
};

export type ResolvedAvatarData = {
  equipped?: Record<string, string>;
  experience?: number;
  id?: number;
  tokenUri?: string;
  source: "portal" | "session" | "jwt" | "fallback";
};

export type ResolvedPlayerProfile = {
  farmId: number;
  portalId: string;
  username?: string;
  balance?: string;
  coins?: number;
  inventory?: Record<string, unknown>;
  bumpkin?: unknown;
  source: "portal" | "session" | "jwt" | "offline";
};

export type PortalPlayerData = {
  launchContext: PortalLaunchContext;
  tokenClaims: Record<string, unknown> | null;
  portalProfile?: Record<string, unknown>;
  minigameSession?: MinigameSessionResponse;
  resolvedProfile: ResolvedPlayerProfile;
  resolvedAvatar: ResolvedAvatarData;
};

export type MinigameSessionResponse = {
  farm: {
    balance: string;
    bumpkin?: unknown;
    /** When the economies API includes it, forwarded to MMO join as `username`. */
    username?: string;
    /**
     * The farm's main-game VIP status, as the economies API resolves it.
     *
     * Optional on purpose, and doubly so: every field inside is omitted for a
     * player who is not VIP, and an `economies-api` predating the block omits
     * `vip` altogether. `resolveVipAccess` reads a missing block as non-VIP
     * rather than failing, so adding or removing the field needs no coordinated
     * release - see `vip.ts`.
     */
    vip?: {
      /**
       * The server's own answer, covering paid VIP, an active trial and the
       * Lifetime Farmer Banner. Preferred over anything derived from the
       * timestamp below.
       */
      isVip?: boolean;
      /**
       * Which of those three `isVip` covers: `paid`, `trial` or `lifetime`.
       * Omitted when the player is not VIP.
       */
      type?: "paid" | "trial" | "lifetime";
      /** Millisecond timestamp; VIP while it is in the future. */
      expiresAt?: number;
      bundles?: unknown[];
    } | null;
  };
  playerEconomy: {
    balances: Record<string, number>;
    generating: Record<
      string,
      {
        outputToken: string;
        startedAt: number;
        completesAt: number;
        requires?: string;
        sourceActionId?: string;
      }
    >;
    activity: number;
    dailyActivity: { date: string; count: number };
    /** Present when API returns the extended player economy payload. */
    dailyMinted?: { utcDay: string; minted: Record<string, number> };
    rules?: Record<string, { ranAt: number }>;
    purchaseCounts?: Record<string, number>;
    /** Some responses mirror `items` inside `playerEconomy`. */
    items?: Record<string, PlayerEconomyBalanceItem>;
  };
  actions: Record<string, unknown>;
  items?: Record<string, PlayerEconomyBalanceItem>;
  descriptions?: PlayerEconomyDescriptions;
  visualTheme?: string;
  playUrl?: string;
  mainCurrencyToken?: string;
  dashboard?: MinigameSessionEconomyMeta["dashboard"];
};

export type MinigameActionResponse = {
  /** Full session-shaped payload after the action (same shape as GET session `data`). */
  economy: MinigameSessionResponse;
  /** Per-token balance deltas (after − before); non-zero entries only. */
  changeset: { balances: Record<string, number> };
  playerEconomy: MinigameSessionResponse["playerEconomy"];
  generatorJobId?: string;
  collectGrants?: { token: string; amount: number }[];
  /** Seed the server issued for the run that is open. Present only on `run-seed`. */
  run?: { seed: number; runKey: number; cabinet: string };
};

export type BootstrapContext = {
  id: number;
  jwt: string;
  /**
   * Must match `portalId` inside the portal JWT (client-side; economies API reads
   * portal id from the Bearer token for session + actions).
   */
  portalId: string;
  farm: MinigameSessionResponse["farm"];
  playerEconomy: MinigameSessionResponse["playerEconomy"];
  actions: Record<string, unknown>;
  /** Session fields used to build player-economy dashboard / editor config. */
  economyMeta?: MinigameSessionEconomyMeta;
  playerData: PortalPlayerData;
};

export function resolvePlayerEconomySessionItems(
  raw: MinigameSessionResponse,
): Record<string, PlayerEconomyBalanceItem> | undefined {
  if (raw.items != null) return raw.items;
  const pe = raw.playerEconomy;
  if (
    pe &&
    typeof pe === "object" &&
    "items" in pe &&
    (pe as { items?: Record<string, PlayerEconomyBalanceItem> }).items != null
  ) {
    return (pe as { items: Record<string, PlayerEconomyBalanceItem> }).items;
  }
  return undefined;
}

export function buildEconomyMetaFromSession(
  raw: MinigameSessionResponse,
): MinigameSessionEconomyMeta {
  return {
    items: resolvePlayerEconomySessionItems(raw),
    descriptions: raw.descriptions,
    visualTheme: raw.visualTheme ?? raw.dashboard?.visualTheme,
    playUrl: raw.playUrl,
    mainCurrencyToken: raw.mainCurrencyToken,
    dashboard: raw.dashboard,
  };
}
