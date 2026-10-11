import type { MinigameSessionResponse, MinigameActionResponse } from "./types";
import { PLAYER_ECONOMY_GENERATOR_COLLECTED_ACTION } from "./playerEconomyTypes";
import { getEconomyWorkerUrl, getMinigamesApiUrl, getUrl } from "./url";

export { getEconomyWorkerUrl };
// The same two numbers the worker replays with. Chosen together there and here
// because a continuation budget short of the worker's log ceiling would strand
// a legal submission mid-verification — see `replayBudget.js`.
import {
  CHUNK_TICKS,
  MAX_REPLAY_TICKS,
} from "@nightshade/shared/anticheat/replayBudget";

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
  | "continue-verification"
  | "void-attempt"
  | "claim-play-ticket"
  | "buy-item"
  | "dev-mint-tickets"
  | "submit-score";

const GRANT_PREFIX = "Grant-Free-Run-";
const START_FREE_PREFIX = "Start-Free-Run-";

/**
 * How many continuation requests one replay may send before giving up.
 *
 * Derived rather than chosen. The worker steps `CHUNK_TICKS` per request and
 * accepts logs up to `MAX_REPLAY_TICKS`, so anything short of the ceiling
 * divided by the chunk strands a legal submission: the client gives up before
 * the replay finishes, the park is left half-stepped, and the verdict is never
 * recorded. Both limits are shared constants for exactly this — a hand-typed
 * 100 against a 64,000-tick ceiling covered only 60,000 of the logs the worker
 * will accept.
 *
 * Stopping early is still the right call when it does happen: a log long enough
 * to exhaust this is inflated rather than slow, and an inflated log is exactly
 * what should not be replayed to the end.
 */
const MAX_CONTINUATIONS = Math.ceil(MAX_REPLAY_TICKS / CHUNK_TICKS);

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
export function writeNonce(): string {
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
  replay,
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
  /** Only read by `claim-verified`: the run's per-tick input trace. */
  replay?: VerifiedRun["replay"];
}): Promise<{ data: MinigameActionResponse; verification?: Record<string, unknown> }> {
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
      ...(replay !== undefined ? { replay } : {}),
    }),
  });

  const bodyText = await response.text();
  let envelope: {
    data?: MinigameActionResponse;
    error?: string;
    /** Present on `claim-verified` and its continuation: the anti-cheat verdict. */
    verification?: Record<string, unknown>;
  } = {};
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

  // The envelope rather than `data` alone: `claim-verified` and its
  // continuation report the anti-cheat verdict beside the data, and the
  // continuation loop cannot tell "keep going" from "finished" without it.
  // Callers that only want the data read `.data`.
  return {
    data: envelope.data,
    ...(envelope.verification !== undefined ? { verification: envelope.verification } : {}),
  };
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
    /**
     * Which champion the run was played as.
     *
     * Not cosmetic for replay: fighters differ in health and reach, so the
     * worker cannot reproduce the run without it. Checked against the engine's
     * own roster, so an unrecognised id fails the replay rather than silently
     * simulating the wrong fighter.
     */
    playerId: string;
    /**
     * Which difficulty the run was played on, by registry name.
     *
     * The single largest influence on the outcome — it sets enemy reaction
     * time, aggression, speed and health. Without it a replay would pit the
     * inputs against a differently-tuned game and disagree with nearly every
     * honest run, which would make the match rate useless. Read from the same
     * table the client played on.
     */
    difficulty: string;
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
    const { data } = await postEconomyWrite({
      token: params.token,
      intent: "claim-verified",
      actionId: params.action,
      ...params.verify,
    });
    // The verdict is deliberately not returned here. It belongs to the
    // continuation loop below, which is the only thing that needs to keep
    // driving the replay; every caller of this function wants the same thing
    // it always did — whether the write went through.
    return data;
  }

  const intent = intentForAction(params.action);
  if (!intent) {
    throw new Error(
      `This arcade has no server route for "${params.action}", so it cannot be run safely.`,
    );
  }
  const { data } = await postEconomyWrite({
    token: params.token,
    intent,
    actionId: params.action,
    ...(params.cabinet !== undefined ? { cabinet: params.cabinet } : {}),
  });
  return data;
}

/**
 * Drive a verified claim's replay to completion, one chunk per request.
 *
 * A run to the finale is ~10,000 ticks and the worker's CPU budget is 10 ms per
 * request, so the claim cannot re-simulate the whole run in one call. The first
 * claim parks the match mid-replay; this keeps calling `continue-verification`
 * until the worker says the replay is done and has recorded its verdict.
 *
 * ## Why the player never sees this
 *
 * In Stage B the replay only *records* whether it agreed — the payout rests on
 * the checkpoints, which are checked in the same request as the claim. So there
 * is nothing to wait for and nothing to report: the coin is already decided by
 * the time this starts, and all it does is let the anti-cheat finish measuring.
 * That is also why it never throws into the caller's path. A failed continuation
 * costs a delayed verdict, and a verdict that never arrives costs one row of
 * shadow-mode telemetry — neither is worth breaking a claim over.
 *
 * ## Why it is bounded
 *
 * A client that kept this loop alive forever would hold one D1 row and one
 * isolate per open replay, so the chunk budget caps the number of continuations
 * outright rather than trusting the caller to stop. The cap is generous — it
 * covers a run several times longer than any legal one — because hitting it
 * means the log was absurd, not that the player was slow.
 *
 * @returns The final verdict, or `null` if it never resolved. Never throws.
 */
export async function continueRunVerification(params: {
  token: string;
  maxContinuations?: number;
}): Promise<Record<string, unknown> | null> {
  const budget = params.maxContinuations ?? MAX_CONTINUATIONS;
  for (let sent = 0; sent < budget; sent += 1) {
    let response: { data: MinigameActionResponse; verification?: Record<string, unknown> };
    try {
      response = await postEconomyWrite({
        token: params.token,
        intent: "continue-verification",
      });
    } catch {
      return null;
    }

    const verdict = response.verification;
    if (!verdict) return null;

    // "In progress" is the only reason to send another. Anything else — a final
    // match, a mismatch, a refusal — is the replay having reached a verdict, and
    // continuing past it would be work against a park that is already gone.
    if (verdict.replayReason !== "replay in progress") return verdict;
  }

  // The worker's own cap is authoritative; this one only exists so a worker that
  // keeps saying "in progress" cannot hold the loop open indefinitely.
  return null;
}

/** Minigames `POST /action` with `type: "score.submitted"` and integer `score` ≥ 0. */
export async function submitScore(params: {
  token: string;
  score: number;
}): Promise<MinigameActionResponse> {
  const { data } = await postEconomyWrite({
    token: params.token,
    intent: "submit-score",
    score: Math.max(0, Math.floor(params.score)),
  });
  return data;
}
