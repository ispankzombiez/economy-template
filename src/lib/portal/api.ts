import type { MinigameSessionResponse, MinigameActionResponse } from "./types";
import { PLAYER_ECONOMY_GENERATOR_COLLECTED_ACTION } from "./playerEconomyTypes";
import { getEconomyWorkerUrl, getMinigamesApiUrl, getUrl } from "./url";

export async function getPortalPlayerProfile({
  token,
  portalId,
}: {
  token: string;
  portalId: string;
}): Promise<Record<string, unknown>> {
  const base = getUrl();
  if (!base) {
    throw new Error("No portal API URL available");
  }

  const url = new URL(
    `/portal/${encodeURIComponent(portalId)}/player`,
    `${base}/`,
  );

  const response = await window.fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
      Authorization: "Bearer " + token,
    },
  });

  const bodyText = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
  } catch {
    throw new Error(bodyText || `Invalid JSON (${response.status})`);
  }

  if (response.status >= 400) {
    throw new Error(
      typeof parsed.error === "string"
        ? parsed.error
        : bodyText || `Portal player load failed (${response.status})`,
    );
  }

  const farm =
    (parsed.farm as Record<string, unknown> | undefined) ??
    ((parsed.data as { farm?: Record<string, unknown> } | undefined)?.farm ??
      parsed);

  if (!farm || typeof farm !== "object" || Array.isArray(farm)) {
    throw new Error("Invalid portal player response (missing farm)");
  }

  return farm;
}

export async function getPlayerEconomySession({
  token,
}: {
  token: string;
}): Promise<MinigameSessionResponse> {
  const base = getMinigamesApiUrl();
  if (!base) {
    throw new Error(
      "No Minigames API URL (set VITE_MINIGAMES_API_URL or pass minigamesApiUrl=…)",
    );
  }

  const url = new URL("/data", `${base}/`);
  url.searchParams.set("type", "session");

  const response = await window.fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  const bodyText = await response.text();
  let parsed: { data?: MinigameSessionResponse; error?: string } = {};
  try {
    parsed = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error(bodyText || `Invalid JSON (${response.status})`);
  }

  if (response.status >= 400) {
    throw new Error(
      typeof parsed.error === "string"
        ? parsed.error
        : bodyText || `Minigame session ${response.status}`,
    );
  }

  if (!parsed.data) {
    throw new Error("Invalid session response (missing data)");
  }

  return parsed.data;
}

/**
 * The one way a player may write to this economy.
 *
 * ## Why the browser cannot do this itself
 *
 * The economy has **Require secret API key** turned on, so the economies API
 * refuses every write that does not carry `x-economy-private-key`: a direct
 * `POST /action` from a browser is answered `401 MISSING_PRIVATE_KEY`. That is
 * deliberate — it is what makes a published action id something a player can no
 * longer just call. Reads are unaffected, so
 * {@link getPlayerEconomySession} still goes straight to the API and the arcade
 * boots normally.
 *
 * So writes go to our own Worker, which holds the key and is the only caller the
 * API will listen to. See `worker/src/index.js` and `worker/README.md`.
 *
 * ## The client does not get to decide anything
 *
 * It sends an `intent` from a fixed vocabulary and that is all. The worker
 * derives the action id, the amounts and the entitlement itself, and refuses
 * anything it does not recognise. This module's job is only to translate an
 * action id into the intent that means it — see {@link intentForAction}.
 *
 * ## Shape is deliberately unchanged
 *
 * The worker replies with the same `{ data }` / `{ error }` envelope the
 * economies API uses, so nothing downstream — including the local rule engine
 * that reconciles the response — knows the write went somewhere else.
 */

/** The fixed vocabulary the worker accepts. Anything else is refused there. */
export type EconomyWriteIntent =
  | "grant-free-run"
  | "start-free-run"
  | "start-ticket-run"
  | "claim-result"
  | "claim-verified"
  | "void-attempt"
  | "claim-play-ticket"
  | "buy-item"
  | "dev-mint-tickets"
  | "submit-score";

const GRANT_PREFIX = "Grant-Free-Run-";
const START_FREE_PREFIX = "Start-Free-Run-";

/**
 * The intent that means a given published action.
 *
 * Reads the published ids rather than duplicating them, so renaming an action in
 * the Economy Editor is a one-place change. Returns `undefined` for an action
 * this fork has no intent for — the caller then refuses locally instead of
 * sending something the worker would reject anyway.
 *
 * Note this is a *translation*, not a permission: it does not decide whether the
 * player is entitled to the thing. That is the worker's job, from the session's
 * own `vip.isVip`.
 */
function intentForAction(action: string): EconomyWriteIntent | undefined {
  if (action === "Claim-Raven-Coin") return "claim-result";
  if (action === "Void-Reward-Attempt") return "void-attempt";
  if (action === "Start-Ticket-Run") return "start-ticket-run";
  if (action === "Claim-Play-Ticket") return "claim-play-ticket";
  if (action === "Dev-Mint-Play-Ticket") return "dev-mint-tickets";
  if (action.startsWith(GRANT_PREFIX)) return "grant-free-run";
  if (action.startsWith(START_FREE_PREFIX)) return "start-free-run";
  if (/^buy_[a-z0-9_]{1,64}$/.test(action)) return "buy-item";
  return undefined;
}

/** A nonce so a double-tap, a retry or a replayed request cannot mint twice. */
function writeNonce(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return random.replace(/-/g, "").slice(0, 32);
}

/**
 * Send one write through the worker.
 *
 * Resolves the way the previous direct call did — same envelope, same thrown
 * errors — so this is a transport swap rather than a change every caller has to
 * understand.
 */
async function postEconomyWrite({
  token,
  intent,
  actionId,
  amount,
  score,
  cabinet,
  checkpoints,
  elapsedMs,
}: {
  token: string;
  intent: EconomyWriteIntent;
  actionId?: string;
  amount?: number;
  score?: number;
  /** Only read by `claim-verified`: the registry id of the cabinet played. */
  cabinet?: string;
  /** Only read by `claim-verified`: the run's milestone checkpoints. */
  checkpoints?: unknown[];
  /** Only read by `claim-verified`: the run's wall-clock duration in ms. */
  elapsedMs?: number;
}): Promise<MinigameActionResponse> {
  const base = getEconomyWorkerUrl();
  if (!base) {
    throw new Error(
      "This arcade cannot write to its economy: the rewards worker URL is not set (VITE_REWARDS_WORKER_URL).",
    );
  }

  const response = await window.fetch(`${base}/economy/write`, {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      intent,
      nonce: writeNonce(),
      ...(actionId !== undefined ? { actionId } : {}),
      ...(amount !== undefined ? { amount } : {}),
      ...(score !== undefined ? { score } : {}),
      // The anti-cheat payload. The worker re-derives everything it can and
      // refuses the claim if the checkpoints do not describe a reachable run —
      // so these fields are a *claim to be checked*, never trusted as-is.
      ...(cabinet !== undefined ? { cabinet } : {}),
      ...(checkpoints !== undefined ? { checkpoints } : {}),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    }),
  });

  const bodyText = await response.text();
  let envelope: { data?: MinigameActionResponse; error?: string } = {};
  try {
    envelope = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error(bodyText || `Invalid JSON (${response.status})`);
  }

  if (response.status >= 400) {
    throw new Error(
      typeof envelope.error === "string"
        ? envelope.error
        : `Action failed (${response.status})`,
    );
  }

  if (!envelope.data) {
    throw new Error("Invalid action response (missing data)");
  }

  return envelope.data;
}

async function postMinigameEconomyActionRequest(
  token: string,
  body: Record<string, unknown>,
): Promise<MinigameActionResponse> {
  const base = getMinigamesApiUrl();
  if (!base) {
    throw new Error(
      "No Minigames API URL (set VITE_MINIGAMES_API_URL or pass minigamesApiUrl=…)",
    );
  }

  const response = await window.fetch(`${base}/action`, {
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const bodyText = await response.text();
  let envelope: {
    data?: MinigameActionResponse;
    error?: string;
  } = {};
  try {
    envelope = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error(bodyText || `Invalid JSON (${response.status})`);
  }

  if (response.status >= 400) {
    throw new Error(envelope.error || `Action failed (${response.status})`);
  }

  if (!envelope.data) {
    throw new Error("Invalid action response (missing data)");
  }

  return envelope.data;
}

/**
 * Collect a completed generator job. `jobId` is the key in `playerEconomy.generating`
 * (same value the economies API expects as `itemId` on `type: "generator.collected"`).
 */
export async function postPlayerEconomyGeneratorCollect(params: {
  token: string;
  jobId: string;
}): Promise<MinigameActionResponse> {
  const jobId = params.jobId.trim();
  if (!jobId) {
    throw new Error("jobId is required to collect a generator job");
  }
  throw new Error(
    "The arcade economy publishes no generator jobs, so there is no worker route for collecting one.",
  );
}

/**
 * A run's proof of legitimacy, sent alongside a claim.
 *
 * The worker does not trust these numbers — it re-derives what a legitimate run
 * could have produced at each of those waves and refuses anything unreachable.
 * They are a *claim to be checked*, never an entitlement.
 */
export type VerifiedRun = {
  /** Registry id of the cabinet played. Selects the worker's rule set. */
  cabinet: string;
  /** The score the player says they earned. */
  score: number;
  /** The run's milestone log, in play order. */
  checkpoints: unknown[];
  /** The run's simulated duration in ms — the pace floor is checked against it. */
  elapsedMs: number;
  /**
   * The run's full input trace, for **shadow replay** (Stage B).
   *
   * Checkpoints say what happened at fifteen moments; this says what the player
   * *did*, which lets the worker re-simulate the run from tick zero and check
   * that the claimed outcome is not merely reachable but *produced*. That is the
   * difference between "a run like this could exist" and "this run existed".
   *
   * Stage B replays and **records** whether the result matched — the payout still
   * rests on the checkpoints, so a replay mismatch changes nothing yet. It is
   * collected now because a match rate measured on real runs is the only way to
   * learn whether replay is safe to enforce before it starts refusing money.
   *
   * `seed` is client-chosen for now. Harmless while replay only observes (a
   * cheater who shops for a favourable seed simply produces a mismatch nobody
   * acts on), but it must become server-issued at run-open before Stage C makes
   * a mismatch refuse payout.
   */
  replay?: {
    /** The simulation RNG seed the run was created with. */
    seed: number;
    /** Number of simulated ticks in the log — must equal `inputs` length. */
    ticks: number;
    /** Per-tick input bitmask, base64. One byte per tick; see `encodeInputLog`. */
    inputs: string;
  };
};

/**
 * Named economy action: `{ "type": "minigame.action", "action", "amounts"? }`.
 *
 * Two optional extras, both read by the worker rather than passed through:
 *
 *  - `verify` routes the write to `claim-verified` instead of the trusting
 *    `claim-result`, so the worker certifies the run before minting.
 *  - `cabinet` names the registry id a **run-open** is for. It is required by
 *    `start-ticket-run` because that is the only moment the cabinet is knowable:
 *    the worker fixes it to the farm then, and every later claim on that run is
 *    checked against it.
 */
export async function postPlayerEconomyAction(params: {
  token: string;
  action: string;
  amounts?: Record<string, number>;
  verify?: VerifiedRun;
  cabinet?: string;
}): Promise<MinigameActionResponse> {
  if (params.verify) {
    // Only the win claim carries proof, and only the win claim has a verified
    // intent. Any other action pairing is a programming error, so refuse it
    // rather than silently dropping the proof — dropping it would downgrade to
    // the trusting route, which is precisely what must never happen by accident.
    const intent = intentForAction(params.action);
    if (intent !== "claim-result") {
      throw new Error(
        `Refusing to send run proof with "${params.action}": only a win claim can be verified.`,
      );
    }
    return postEconomyWrite({
      token: params.token,
      intent: "claim-verified",
      actionId: params.action,
      ...params.verify,
    });
  }

  const intent = intentForAction(params.action);
  if (!intent) {
    throw new Error(
      `This arcade has no server route for "${params.action}", so it cannot be run safely.`,
    );
  }
  return postEconomyWrite({
    token: params.token,
    intent,
    actionId: params.action,
    ...(params.cabinet !== undefined ? { cabinet: params.cabinet } : {}),
  });
}

/** Minigames `POST /action` with `type: "score.submitted"` and integer `score` ≥ 0. */
export async function submitScore(params: {
  token: string;
  score: number;
}): Promise<MinigameActionResponse> {
  return postEconomyWrite({
    token: params.token,
    intent: "submit-score",
    score: Math.max(0, Math.floor(params.score)),
  });
}
