import type { MinigameActionResponse, MinigameSessionResponse } from "./types";
import {
  emptyPlayerEconomyState,
  processPlayerEconomyAction,
  type MinigameActionDefinition,
  type MinigameConfig,
  type MinigameRuntimeState,
  type PlayerEconomyConfig,
  utcCalendarDay,
} from "./processAction";

export function cloneMinigameSnapshot(
  m: MinigameSessionResponse["playerEconomy"],
): MinigameSessionResponse["playerEconomy"] {
  const day = utcCalendarDay(Date.now());
  const dm = m.dailyMinted ?? { utcDay: day, minted: {} };
  const base: MinigameSessionResponse["playerEconomy"] = {
    balances: { ...m.balances },
    generating: Object.fromEntries(
      Object.entries(m.generating).map(([k, v]) => [k, { ...v }]),
    ),
    activity: m.activity,
    dailyActivity: { ...m.dailyActivity },
    dailyMinted: { utcDay: dm.utcDay, minted: { ...dm.minted } },
  };
  if (m.rules && Object.keys(m.rules).length > 0) {
    base.rules = Object.fromEntries(
      Object.entries(m.rules).map(([id, rec]) => [id, { ranAt: rec.ranAt }]),
    );
  }
  if (m.purchaseCounts != null) {
    base.purchaseCounts = { ...m.purchaseCounts };
  }
  return base;
}

export function minigameSessionToRuntime(
  m: MinigameSessionResponse["playerEconomy"],
  nowMs: number,
): MinigameRuntimeState {
  const day = utcCalendarDay(nowMs);
  const dm = m.dailyMinted ?? { utcDay: day, minted: {} };
  return {
    balances: { ...m.balances },
    generating: Object.fromEntries(
      Object.entries(m.generating).map(([k, v]) => [k, { ...v }]),
    ),
    activity: m.activity,
    dailyActivity: { ...m.dailyActivity },
    dailyMinted: { utcDay: dm.utcDay, minted: { ...dm.minted } },
    ...(m.rules && Object.keys(m.rules).length > 0
      ? {
          rules: Object.fromEntries(
            Object.entries(m.rules).map(([id, rec]) => [
              id,
              { ranAt: rec.ranAt },
            ]),
          ),
        }
      : {}),
    ...(m.purchaseCounts != null
      ? { purchaseCounts: { ...m.purchaseCounts } }
      : {}),
  };
}

export function runtimeToMinigameSession(
  r: MinigameRuntimeState,
): MinigameSessionResponse["playerEconomy"] {
  const base: MinigameSessionResponse["playerEconomy"] = {
    balances: { ...r.balances },
    generating: Object.fromEntries(
      Object.entries(r.generating).map(([k, v]) => [k, { ...v }]),
    ),
    activity: r.activity,
    dailyActivity: { ...r.dailyActivity },
    dailyMinted: {
      utcDay: r.dailyMinted.utcDay,
      minted: { ...r.dailyMinted.minted },
    },
  };
  if (r.rules && Object.keys(r.rules).length > 0) {
    base.rules = Object.fromEntries(
      Object.entries(r.rules).map(([id, rec]) => [id, { ranAt: rec.ranAt }]),
    );
  }
  if (r.purchaseCounts != null) {
    base.purchaseCounts = { ...r.purchaseCounts };
  }
  return base;
}

export function normalizeMinigameFromApi(
  raw: MinigameSessionResponse["playerEconomy"],
): MinigameSessionResponse["playerEconomy"] {
  const day = utcCalendarDay(Date.now());
  const dm = raw.dailyMinted ?? { utcDay: day, minted: {} };
  const base: MinigameSessionResponse["playerEconomy"] = {
    balances: { ...raw.balances },
    generating: Object.fromEntries(
      Object.entries(raw.generating).map(([k, v]) => [k, { ...v }]),
    ),
    activity: raw.activity,
    dailyActivity: { ...raw.dailyActivity },
    dailyMinted: { utcDay: dm.utcDay, minted: { ...dm.minted } },
  };
  if (raw.rules && Object.keys(raw.rules).length > 0) {
    base.rules = Object.fromEntries(
      Object.entries(raw.rules).map(([id, rec]) => [id, { ranAt: rec.ranAt }]),
    );
  }
  if (raw.purchaseCounts != null) {
    base.purchaseCounts = { ...raw.purchaseCounts };
  }
  return base;
}

const RUN_SESSION_BALANCE_KEYS = ["LIVE_GAME", "ADVANCED_GAME"] as const;

/**
 * The economy to merge out of a `POST /action` response.
 *
 * The response carries the economy twice: a top-level `playerEconomy`, and
 * `economy` — documented as the "full session-shaped payload after the action
 * (same shape as GET session `data`)". The full payload is the authoritative one
 * and is the only place `dailyMinted` is reliably populated, so prefer it and
 * fall back to the top-level field for older/leaner responses.
 */
export function authoritativePlayerEconomy(
  res: MinigameActionResponse,
): MinigameSessionResponse["playerEconomy"] {
  return res.economy?.playerEconomy ?? res.playerEconomy;
}

/**
 * Some portal action responses return a partial `balances` map. If `LIVE_GAME` /
 * `ADVANCED_GAME` are omitted, keep the values from `prev` so an in-progress run
 * is not cleared before GAMEOVER.
 *
 * ## `dailyMinted` must survive the merge
 *
 * `dailyMinted` is the **only** persisted record of what the player has already
 * minted today, and the arcade's free reward-run allowance is derived from it
 * (`getRavenCoinsMintedToday` in `features/arcade/lib/ravenCoin.ts`).
 *
 * `normalizeMinigameFromApi` defaults an absent `dailyMinted` to
 * `{ utcDay: today, minted: {} }`, so taking it straight from the response — as
 * this function used to — means an action response that omits the field **erases
 * the player's usage history**. The optimistic apply had already counted the mint
 * correctly; the merge then threw that count away, the free-run gate read zero,
 * and every subsequent run looked unused. That showed up as an arcade handing out
 * unlimited free runs and never asking for a Play Ticket.
 *
 * So `dailyMinted`, like `rules` and `purchaseCounts`, falls back to `prev` when
 * the response leaves it out — with one extra condition: only while `prev` is
 * still today's ledger. Carrying yesterday's totals forward would lock a player
 * out of their free run until a response happened to include the field.
 */
export function mergeMinigameEconomyFromApi(
  prev: MinigameSessionResponse["playerEconomy"],
  raw: MinigameSessionResponse["playerEconomy"],
): MinigameSessionResponse["playerEconomy"] {
  const next = normalizeMinigameFromApi(raw);
  const balances = { ...next.balances };
  for (const key of RUN_SESSION_BALANCE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(balances, key)) {
      const v = prev.balances[key];
      if (v !== undefined) {
        balances[key] = v;
      }
    }
  }

  const keepPreviousLedger =
    raw.dailyMinted == null &&
    prev.dailyMinted != null &&
    next.dailyMinted != null &&
    prev.dailyMinted.utcDay === next.dailyMinted.utcDay;

  return {
    ...next,
    balances,
    dailyMinted: keepPreviousLedger ? prev.dailyMinted : next.dailyMinted,
    rules: next.rules !== undefined ? next.rules : prev.rules,
    purchaseCounts:
      next.purchaseCounts !== undefined
        ? next.purchaseCounts
        : prev.purchaseCounts,
  };
}

export function applyOptimisticPortalAction(
  actions: Record<string, unknown>,
  minigame: MinigameSessionResponse["playerEconomy"],
  input: {
    actionId: string;
    amounts?: Record<string, number>;
    itemId?: string;
    now?: number;
  },
  economyItems?: PlayerEconomyConfig["items"],
):
  | {
      ok: true;
      playerEconomy: MinigameSessionResponse["playerEconomy"];
      collectGrants?: { token: string; amount: number }[];
      generatorJobId?: string;
    }
  | { ok: false; error: string } {
  const now = input.now ?? Date.now();
  const config: MinigameConfig = {
    actions: actions as Record<string, MinigameActionDefinition>,
    ...(economyItems != null ? { items: economyItems } : {}),
  };
  const runtime = minigameSessionToRuntime(minigame, now);
  const result = processPlayerEconomyAction(config, runtime, {
    actionId: input.actionId,
    amounts: input.amounts,
    itemId: input.itemId,
    now,
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    playerEconomy: runtimeToMinigameSession(result.state),
    ...(result.collectGrants !== undefined
      ? { collectGrants: result.collectGrants }
      : {}),
    ...(result.generatorJobId !== undefined
      ? { generatorJobId: result.generatorJobId }
      : {}),
  };
}

export function emptySessionMinigame(
  now = Date.now(),
): MinigameSessionResponse["playerEconomy"] {
  return runtimeToMinigameSession(emptyPlayerEconomyState(now));
}
