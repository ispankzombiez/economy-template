/**
 * Client for the reward-request worker (see `worker/README.md`).
 *
 * ## What this talks to, and what it deliberately does not
 *
 * The worker holds a list of rewards the arcade owner owes players. It answers
 * one question: *is this request actually for the person asking?* That is all it
 * is for, and that is all this module asks it.
 *
 * It cannot give anyone tokens. Every call here is about **permission to press a
 * button that was published in the Economy Editor**; the actual payout happens
 * afterwards in {@link dispatchAction}, against Sunflower Land's own server. A
 * worker that could mint would be a hole straight through the economy, so the
 * worker's routes are all reads and bookkeeping.
 *
 * ## Identity
 *
 * Every request carries the player's own portal JWT as a bearer token, and the
 * worker resolves it to a farm id by asking Sunflower Land. The client never
 * claims to be anyone — it has no `farmId` to send, only a token.
 *
 * That is why the dev-only routes are safe to expose from a browser: the worker
 * decides whether the caller holds the Dev Key, from Sunflower Land's answer, not
 * from anything in this file. A player calling `POST /requests` gets a 403 and
 * the request goes nowhere.
 *
 * ## Failures are always "nothing happened"
 *
 * Every helper resolves rather than throws, so a worker that is down, a deploy
 * mid-flight, or a network blip shows the player "couldn't load" instead of an
 * unhandled rejection. Reward UI must never be able to take the arcade down.
 */

import { CONFIG } from "lib/config";

/** One queued reward, as the worker stores it. */
export type RewardRequest = {
  id: string;
  farmId: number;
  /** Free-text name the owner typed. A label only — never used to look anyone up. */
  label: string;
  note: string;
  /** The published `Payout-*` button this request entitles the player to press. */
  actionId: string;
  createdAt: number;
  createdBy: number;
  createdByUsername: string;
  /** Epoch seconds, or null while still outstanding. */
  claimedAt: number | null;
  /**
   * When the claim's mint actually settled, epoch seconds — `null` while
   * outstanding, and still `null` on a claim that failed ambiguously (see
   * `POST /requests/claim`). `claimedAt` alone cannot tell those apart, which is
   * why the audit panel shows both.
   */
  settledAt?: number | null;
  /** What the claim was refused with, when it failed. */
  claimedDetail?: string | null;
  /** Username of the farm that claimed this reward (populated by worker). */
  claimedByUsername?: string;
};

/** The worker's answer to a write, including anything it wants to warn about. */
export type QueueResult = {
  request: RewardRequest;
  /**
   * The worker's read of the button that was picked — chiefly "this `requireAbsent`
   * names a marker the action never mints, so it is not actually one-use". Shown
   * to the owner rather than swallowed, because it is the difference between a
   * reward and an infinite faucet.
   */
  warnings: string[];
};

export type RewardsFailure = { ok: false; error: string };
export type RewardsSuccess<T> = { ok: true; value: T };
export type RewardsOutcome<T> = RewardsSuccess<T> | RewardsFailure;

type ResultShape<T> = RewardsOutcome<T>;

const workerUrl = () => CONFIG.REWARDS_WORKER_URL;

/** Whether the reward UI should render at all. */
export const rewardsWorkerConfigured = (): boolean =>
  typeof workerUrl() === "string" && workerUrl() !== "";

/**
 * One request to the worker.
 *
 * Returns a failure rather than throwing for every unhappy path — bad JSON, an
 * unreachable host, a 500 from a bad deploy — so callers only handle one shape.
 * The worker's own message is preferred when it sent one, because it is the only
 * party that knows why (expired session, not the owner, already claimed).
 */
/**
 * One request to the worker.
 *
 * Exported so the chest tally (`lib/chestApi.ts`) can share it rather than open a
 * second connection to the same host with a second copy of the failure handling.
 * Every helper here and there resolves rather than throws — see the note at the
 * top of this file.
 */
export async function call<T>(
  path: string,
  {
    token,
    method = "GET",
    body,
    query,
  }: {
    token: string;
    method?: "GET" | "POST" | "DELETE";
    body?: unknown;
    /** Query string params, appended as `?k=v&…`. */
    query?: Record<string, string>;
  },
): Promise<ResultShape<T>> {
  const base = workerUrl();
  if (!base) {
    return { ok: false, error: "Rewards are not set up in this build." };
  }

  let url = `${base}${path}`;
  if (query) {
    const params = new URLSearchParams(query);
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    return { ok: false, error: "Could not reach the rewards service." };
  }

  let parsed: Record<string, unknown> = {};
  try {
    const text = await response.text();
    if (text) parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, error: "The rewards service sent something unreadable." };
  }

  if (!response.ok) {
    const detail = typeof parsed.error === "string" ? parsed.error : undefined;
    return { ok: false, error: detail ?? `Rewards service error (${response.status}).` };
  }

  return { ok: true, value: parsed as T };
}

/** Everything the worker knows about this player. Also the reachability check. */
export function fetchWhoami(
  token: string,
): Promise<
  ResultShape<{ farmId: number; username: string; isDev: boolean }>
> {
  return call("/whoami", { token });
}

/** This player's own outstanding rewards, newest first. */
export function fetchMyRewards(
  token: string,
): Promise<ResultShape<{ farmId: number; requests: RewardRequest[] }>> {
  return call("/requests/mine", { token });
}

/**
 * Every queued reward, for the owner's list. Worker-side dev check only; the
 * client cannot make this succeed without the Dev Key.
 */
export function fetchAllRewards(
  token: string,
): Promise<ResultShape<{ requests: RewardRequest[] }>> {
  return call("/requests", { token });
}

/** Queue a reward for `farmId`. */
export function queueReward(
  token: string,
  input: { farmId: number; actionId: string; note?: string; label?: string },
): Promise<ResultShape<QueueResult>> {
  return call("/requests", { token, method: "POST", body: input });
}

/**
 * Claim a reward, mint included.
 *
 * The worker does the whole thing: it looks the grant up, checks it is addressed
 * to this farm and has not been taken, records the claim, and calls the published
 * reward button with the economy's private key. The client sends only a `grantId`
 * and is never told which action runs or how much it mints.
 *
 * This used to be two calls — press the button, then tell the worker it was done —
 * which meant the *client* chose which action to press, with `requireAbsent` on a
 * marker item as the only thing making it once-only. That primitive cannot express
 * "the same reward several times to one player", so uniqueness moved into the
 * worker's ledger where it can.
 *
 * The worker's own message comes back on refusal, so the panel can show the real
 * reason ("You have already claimed that reward") rather than guessing.
 */
export function claimReward(
  token: string,
  grantId: string,
): Promise<
  ResultShape<{
    grantId: string;
    actionId: string;
    label: string;
    claimedAt: number;
    data?: unknown;
  }>
> {
  return call("/requests/claim", { token, method: "POST", body: { grantId } });
}

/** Withdraw a queued reward before the player takes it. */
export function cancelReward(
  token: string,
  id: string,
): Promise<ResultShape<{ cancelled: string }>> {
  return call(`/requests/${encodeURIComponent(id)}`, {
    token,
    method: "DELETE",
  });
}

/**
 * Delete a claimed reward from the owner's history. Dev Key only.
 *
 * A different verb from {@link cancelReward} on purpose. Cancelling withdraws a
 * grant nobody has taken; this removes a row from the audit trail after the fact.
 * Conflating them would mean a single `DELETE` could quietly rewrite history.
 *
 * The worker enforces the Dev Key again on this route — the button being visible
 * only to a Dev Key holder is a UI convenience, not the protection.
 *
 * `force` overrides the worker's refusal to delete a claim that never settled. It
 * is for the case where the owner has checked the player's balance, confirmed the
 * payout did not land, and still wants the record gone. The worker logs a forced
 * removal separately, so the audit trail records that the override happened even
 * though the row itself is deleted.
 */
export function forgetReward(
  token: string,
  grantId: string,
  force = false,
): Promise<ResultShape<{ removed: string }>> {
  return call(`/requests/${encodeURIComponent(grantId)}/history`, {
    token,
    method: "DELETE",
    query: force ? { force: "true" } : undefined,
  });
}

/**
 * Restore this farm's Dev Key, once, after an economy reset.
 *
 * The worker gates it three ways and the answer comes back either way: the caller
 * must be the arcade owner's farm (from the verified identity, not the request),
 * must not already hold a key, and the economy must currently hold none at all.
 * The last of those is why this can stay in the code permanently — once the owner
 * has the key, the route refuses forever.
 *
 * The worker's own message is surfaced, because the two failure modes are very
 * different for the person reading it: "publish a `Bootstrap-Dev-Key` action"
 * means an editor change is the next step, while "a Dev Key already exists" means
 * there is nothing to do.
 */
export function bootstrapDevKey(
  token: string,
): Promise<ResultShape<{ restored: boolean }>> {
  return call("/dev-key/bootstrap", { token, method: "POST" });
}

// ---------------------------------------------------------------------------
// Published payout buttons
// ---------------------------------------------------------------------------

/**
 * The `Payout-*` actions this economy publishes, and what each one awards.
 *
 * Discovered from the session rather than hard-coded, so adding a new reward size
 * is a publish in the Economy Editor and nothing else — the same reason the shop
 * reads `actions` at runtime. Anything without a resolvable mint is skipped: the
 * owner cannot be offered a button whose reward cannot be read back.
 */
export type PayoutButton = {
  actionId: string;
  /** Token key -> amount, straight from the published mint rule. */
  grants: Record<string, number>;
  /** Short human summary, e.g. "Raven Coin x25". */
  label: string;
};

type MintRule = { amount?: number; min?: number; max?: number };

function readAmount(rule: unknown): number | null {
  if (typeof rule === "number") return Number.isFinite(rule) ? rule : null;
  if (!rule || typeof rule !== "object") return null;

  const record = rule as MintRule;
  if (typeof record.amount === "number" && Number.isFinite(record.amount)) {
    return record.amount;
  }
  // A ranged mint (`min`/`max`) has no single amount. Report the ceiling so the
  // owner is told the largest possible payout, never a flattering floor.
  if (typeof record.max === "number" && Number.isFinite(record.max)) {
    return record.max;
  }
  return null;
}

/**
 * One line describing what a button awards.
 *
 * The marker token a one-use button mints alongside its reward is skipped: it is
 * bookkeeping, and "Raven Coin x25 + Payout-Marker-3" is noise to a human.
 */
function summariseGrants(
  grants: Record<string, number>,
  labelFor: (token: string) => string,
): string {
  return Object.entries(grants)
    .filter(([token, amount]) => amount !== 0 && !isMarkerToken(labelFor(token)))
    .map(([token, amount]) => `${labelFor(token)} x${amount}`)
    .join(", ");
}

/**
 * Is this token one of the one-use markers?
 *
 * Matched on the item's *display name* rather than its key, because a hosted
 * economy keys items numerically (`"0"`, `"1"`, …) and those keys are the editor's
 * to assign — nothing about `"3"` says "marker". Markers are conventionally named
 * `Payout-Marker-*`, which is the convention the worker README asks for.
 */
function isMarkerToken(label: string): boolean {
  return /^payout[\s_-]*marker/i.test(label.trim());
}

export function resolvePayoutButtons({
  actions,
  items,
}: {
  actions: Record<string, unknown> | undefined;
  items: Record<string, { name?: string } | undefined> | undefined;
}): PayoutButton[] {
  const labelFor = (token: string) => items?.[token]?.name ?? token;

  return Object.entries(actions ?? {})
    .filter(([actionId]) => /^Payout-/.test(actionId))
    .map(([actionId, definition]) => {
      const mint = (definition as { mint?: Record<string, unknown> } | undefined)?.mint;
      const grants: Record<string, number> = {};

      for (const [token, rule] of Object.entries(mint ?? {})) {
        const amount = readAmount(rule);
        if (amount !== null) grants[token] = amount;
      }
      return { actionId, grants, label: summariseGrants(grants, labelFor) };
    })
    .filter((button) => Object.keys(button.grants).length > 0)
    .sort((a, b) => a.actionId.localeCompare(b.actionId));
}
