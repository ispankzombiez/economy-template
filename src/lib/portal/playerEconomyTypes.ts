/**
 * Published economy shapes for minigames. Editor rule JSON under `mint` / `burn` / `produce` /
 * `collect` is whatever the hosted API returns; the server validates. Use `EconomyActionType`
 * for the editor card kind; inspect rule objects at runtime when you need specifics.
 */

/** Editor rule card kind (shop, generator, custom). Not used by the server for validation. */
export type EconomyActionType = "shop" | "generator" | "custom";

/**
 * One action from the published economy. Opaque rule records mirror API/editor JSON.
 */
export type EconomyActionDefinition = {
  type?: EconomyActionType;
  showInShop?: boolean;
  /** Seconds after last successful run (`rules[actionId].ranAt`) before this action may run again. */
  cooldownSeconds?: number;
  purchaseLimit?: number;
  require?: Record<string, { amount: number }>;
  requireBelow?: Record<string, number>;
  requireAbsent?: string[];
  mint?: Record<string, unknown>;
  burn?: Record<string, unknown>;
  produce?: Record<string, unknown>;
  collect?: Record<string, unknown>;
};

/** Alias of {@link EconomyActionDefinition} (older template name). */
export type PlayerEconomyActionDefinition = EconomyActionDefinition;

export type PlayerEconomyBalanceItem = {
  name: string;
  description: string;
  image?: string;
  id?: number;
  /** Main marketplace currency for this minigame when true. */
  tradeable?: boolean;
  /**
   * When true, this balance item can be selected as the produce rule "requires" token
   * and appears in the dashboard production zone when the player owns it.
   */
  generator?: boolean;
  /**
   * The editor's "Show in dashboard inventory" toggle, published verbatim as
   * `is_visible` (snake_case, unlike every other key here).
   *
   * The API omits the key for an item that is shown, so only an explicit
   * `false` hides it — `undefined` means visible. This is a display flag, not a
   * gate: a hidden item is still minted, burned and `require`d normally.
   */
  is_visible?: boolean;
  /** Starting balance for new farms (no persisted minigame doc yet). */
  initialBalance?: number;
};

export type PlayerEconomyDescriptions = {
  title?: string;
  subtitle?: string;
  welcome?: string;
  rules?: string;
};

export type PlayerEconomyConfig = {
  actions: Record<string, EconomyActionDefinition>;
  items?: Record<string, PlayerEconomyBalanceItem>;
  descriptions?: PlayerEconomyDescriptions;
  /** Optional themed shell (e.g. bookmatched backdrop). */
  visualTheme?: string;
  /** Canonical iframe origin from API; overridden by `VITE_PORTAL_GAME_URL` when set. */
  playUrl?: string;
  /**
   * Balance token key (`items` record key) for dashboard HUD + price widget.
   * Must match an item with `tradeable: true` and a numeric `id`. Omit to auto-pick (id 0, else lowest id).
   */
  mainCurrencyToken?: string;
};

/** Virtual action id for completing a generator job (POST body `type: "generator.collected"`). */
export const PLAYER_ECONOMY_GENERATOR_COLLECTED_ACTION =
  "generator.collected" as const;

export type GeneratorJob = {
  outputToken: string;
  startedAt: number;
  completesAt: number;
  /** When set, this job counts only toward that cap lane (matches produce `requires`). */
  requires?: string;
  /** Action that created this job; used to resolve `collect` rules on harvest. */
  sourceActionId?: string;
};

export type DailyMintBucket = {
  utcDay: string;
  minted: Record<string, number>;
};

export type PlayerEconomyDailyActivity = {
  date: string;
  count: number;
};

export type PlayerEconomyRuleRunRecord = {
  ranAt: number;
};

export type PlayerEconomyRuntimeState = {
  balances: Record<string, number>;
  generating: Record<string, GeneratorJob>;
  dailyMinted: DailyMintBucket;
  activity: number;
  dailyActivity: PlayerEconomyDailyActivity;
  /** Per action id: last successful economy action completion time (ms). */
  rules?: Record<string, PlayerEconomyRuleRunRecord>;
  /** Per-action purchase counts when `purchaseLimit` is used on shop rules. */
  purchaseCounts?: Record<string, number>;
};

export type PlayerEconomyProcessInput = {
  actionId: string;
  itemId?: string;
  /** Ranged mint and ranged burn amounts (token key → integer). */
  amounts?: Record<string, number>;
  now: number;
};

export type PlayerEconomyCollectGrant = {
  token: string;
  amount: number;
};

export type PlayerEconomyProcessSuccess = {
  ok: true;
  state: PlayerEconomyRuntimeState;
  generatorJobId?: string;
  collectGrants?: PlayerEconomyCollectGrant[];
};

export type PlayerEconomyProcessFailure = {
  ok: false;
  error: string;
};

export type PlayerEconomyProcessResult =
  | PlayerEconomyProcessSuccess
  | PlayerEconomyProcessFailure;
