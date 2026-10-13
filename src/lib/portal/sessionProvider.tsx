import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { getMinigamesApiUrl } from "./url";
import type {
  BootstrapContext,
  MinigameSessionEconomyMeta,
  MinigameSessionResponse,
  PortalPlayerData,
} from "./types";
import {
  continueRunVerification,
  postPlayerEconomyAction,
  postPlayerEconomyGeneratorCollect,
} from "./api";
import type { VerifiedRun } from "./api";
import { PLAYER_ECONOMY_GENERATOR_COLLECTED_ACTION } from "./playerEconomyTypes";
import {
  applyOptimisticPortalAction,
  cloneMinigameSnapshot,
  mergeMinigameEconomyFromApi,
  authoritativePlayerEconomy,
  normalizeMinigameFromApi,
} from "./runtimeHelpers";
import { BootstrapProvider } from "./BootstrapContext";

/**
 * Payload the session will send on `POST /action` after an optimistic update.
 * Use `collectJobId` for generator harvest (`generator.collected`), not a fake `action` id.
 */
export type PortalEconomySyncInput =
  | {
      action: string;
      amounts?: Record<string, number>;
      /**
       * Set false to skip the local rule engine and let the server's answer be
       * the only one. Needed where a *refusal* has to be authoritative: the local
       * engine enforces `dailyCap` from `dailyMinted`, and when the session does
       * not carry that ledger it will happily allow a capped mint forever. An
       * entitlement that must not be self-issued has to come from the server.
       */
      optimistic?: boolean;
      /**
       * Anti-cheat proof for a win claim: the run's checkpoints, score and
       * duration. Present only on `Claim-Raven-Coin`, where it routes the write
       * to `claim-verified` so the worker certifies the run before minting.
       * See `VerifiedRun` in `./api`.
       */
      verify?: VerifiedRun;
      /**
       * Registry id of the cabinet a **run-open** is for. The worker fixes this
       * to the farm at open time and checks every later claim on the run against
       * it, so it cannot be supplied by the claim instead. See `./api`.
       */
      cabinet?: string;
    }
  | { collectJobId: string };

export type DispatchMinigameActionInput = PortalEconomySyncInput;

export type CommitLocalPlayerEconomyInput = PortalEconomySyncInput & {
  nextPlayerEconomy: MinigameSessionResponse["playerEconomy"];
};

function portalSyncToOptimistic(input: PortalEconomySyncInput): {
  actionId: string;
  amounts?: Record<string, number>;
  itemId?: string;
} {
  if ("collectJobId" in input) {
    return {
      actionId: PLAYER_ECONOMY_GENERATOR_COLLECTED_ACTION,
      itemId: input.collectJobId,
    };
  }
  return { actionId: input.action, amounts: input.amounts };
}

export type DispatchMinigameActionResult =
  | {
      ok: true;
      collectGrants?: { token: string; amount: number }[];
      generatorJobId?: string;
    }
  | { ok: false; error: string };

export type MinigameSessionValue = {
  farmId: number;
  jwt: string;
  portalId: string;
  /** Session metadata for building dashboard config (`items`, `descriptions`, …). */
  economyMeta: MinigameSessionEconomyMeta | undefined;
  playerData: PortalPlayerData;
  farm: MinigameSessionResponse["farm"];
  playerEconomy: MinigameSessionResponse["playerEconomy"];
  actions: Record<string, unknown>;
  dispatchAction: (
    input: DispatchMinigameActionInput,
  ) => DispatchMinigameActionResult;
  commitLocalPlayerEconomySync: (
    input: CommitLocalPlayerEconomyInput,
  ) => boolean;
  dispatchMinigameActionsSequential: (
    inputs: DispatchMinigameActionInput[],
  ) => DispatchMinigameActionResult;
  /** Apply economy from an authoritative API response without sending another POST. */
  replacePlayerEconomy: (
    next: MinigameSessionResponse["playerEconomy"],
  ) => void;
  apiError: string | null;
  clearApiError: () => void;
};

const MinigameSessionContext = createContext<MinigameSessionValue | null>(null);

export function useMinigameSession(): MinigameSessionValue {
  const v = useContext(MinigameSessionContext);
  if (!v) {
    throw new Error("useMinigameSession outside provider");
  }
  return v;
}

export function MinigameSessionProvider({
  bootstrap,
  children,
}: {
  bootstrap: BootstrapContext;
  children: React.ReactNode;
}) {
  const [playerEconomy, setPlayerEconomy] = useState(() =>
    normalizeMinigameFromApi(bootstrap.playerEconomy),
  );
  const [apiError, setApiError] = useState<string | null>(null);

  const runAfterLocalEconomyCommit = useCallback(
    (
      rollback: MinigameSessionResponse["playerEconomy"],
      nextEconomy: MinigameSessionResponse["playerEconomy"],
      input: PortalEconomySyncInput,
    ) => {
      flushSync(() => {
        setPlayerEconomy(nextEconomy);
      });

      // Only synchronise when there is an API to talk to *and* a token to talk
      // with. Booting offline (dev server with no `?jwt=`) still has
      // VITE_MINIGAMES_API_URL set, so gating on the URL alone made every local
      // purchase POST with an empty bearer and roll back with a 401
      // ("Missing or invalid Authorization header"). A hosted build always has a
      // token — without one the player is stopped at the session-expired screen
      // — so this never skips a real sync.
      if (!getMinigamesApiUrl() || !bootstrap.jwt) {
        return;
      }

      const postPromise =
        "collectJobId" in input
          ? postPlayerEconomyGeneratorCollect({
              token: bootstrap.jwt as string,
              jobId: input.collectJobId,
            })
          : postPlayerEconomyAction({
              token: bootstrap.jwt as string,
              action: input.action,
              amounts: input.amounts,
              verify: input.verify,
              cabinet: input.cabinet,
            });

      // A verified claim's replay outlives the request that started it: the
      // worker cannot re-simulate ten thousand ticks inside one 10 ms CPU
      // budget, so it parks the match mid-replay and the continuation finishes
      // it. Captured inside the branch rather than read off `input` in the
      // callback below, because there `input` has narrowed to the union of both
      // variants and `verify` is no longer visible on every member of it.
      const verifiedReplay = "collectJobId" in input ? undefined : input.verify?.replay;

      void postPromise.then(
        (res) => {
          // A response that carries no economy is not one to merge. A claim whose
          // replay is merely unfinished answers 200 with a status stub — the
          // continuation is what mints — and merging that through would let a
          // normalisation default stand in for a balance the server never sent.
          const authoritative = authoritativePlayerEconomy(res);
          if (authoritative) {
            setPlayerEconomy((prev) => mergeMinigameEconomyFromApi(prev, authoritative));
          }

          // Runs *after* the economy is already settled, and is deliberately
          // fire-and-forget: in Stage B the replay only records whether it
          // agreed, so nothing the player is owed waits on it, and a failure
          // here costs one row of telemetry rather than a broken claim.
          //
          // Only a tick-log replay (`inputs`) can ever have parked — Solitaire's
          // move log replays whole inside the claim request, so there is nothing
          // for a continuation to pick up and the first call would just be
          // refused.
          if (verifiedReplay && "inputs" in verifiedReplay) {
            void continueRunVerification({
              token: bootstrap.jwt as string,
              // The continuation that reaches the end of a replay is the one that
              // mints it, so every response's economy is merged as it lands —
              // otherwise a run that verified would pay into a balance the player
              // only saw on their next reload. The intermediate ones step ticks and
              // carry no economy at all, and those must not be merged as if they
              // had: a normalisation default is not a balance the server sent.
              onSettled: (data) => {
                const authoritative = authoritativePlayerEconomy(data);
                if (!authoritative) return;
                setPlayerEconomy((prev) =>
                  mergeMinigameEconomyFromApi(prev, authoritative),
                );
              },
            });
          }
        },
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          setPlayerEconomy(rollback);
          setApiError(message);
        },
      );
    },
    [bootstrap.jwt],
  );

  const commitLocalPlayerEconomySync = useCallback(
    (input: CommitLocalPlayerEconomyInput): boolean => {
      setApiError(null);
      const rollback = cloneMinigameSnapshot(playerEconomy);
      const { nextPlayerEconomy, ...sync } = input;
      const nextEconomy = cloneMinigameSnapshot(nextPlayerEconomy);
      runAfterLocalEconomyCommit(rollback, nextEconomy, sync);
      return true;
    },
    [playerEconomy, runAfterLocalEconomyCommit],
  );

  const dispatchAction = useCallback(
    (input: DispatchMinigameActionInput): DispatchMinigameActionResult => {
      setApiError(null);
      const rollback = cloneMinigameSnapshot(playerEconomy);

      // Server-authoritative path: no local rule engine, so a local misjudgement
      // (notably an absent `dailyMinted` ledger disabling `dailyCap`) cannot
      // manufacture a balance the server never granted.
      if ("action" in input && input.optimistic === false) {
        if (!getMinigamesApiUrl() || !bootstrap.jwt) {
          return {
            ok: false,
            error: "This action needs a live session and there isn't one.",
          };
        }
        void postPlayerEconomyAction({
          token: bootstrap.jwt,
          action: input.action,
          amounts: input.amounts,
          // The proof and the run's cabinet ride along here too: this path is
          // server-authoritative, which is exactly what a verified claim wants.
          // Dropping them would silently downgrade a verified win to the
          // trusting route — or worse, send checkpoints with no cabinet and be
          // refused for a mismatch the player never caused.
          verify: input.verify,
          cabinet: input.cabinet,
        }).then(
          (res) => {
            setPlayerEconomy((prev) =>
              mergeMinigameEconomyFromApi(
                prev,
                authoritativePlayerEconomy(res),
              ),
            );
          },
          (err) => {
            const message = err instanceof Error ? err.message : String(err);
            setApiError(message);
          },
        );
        return { ok: true };
      }

      const optimistic = portalSyncToOptimistic(input);
      const next = applyOptimisticPortalAction(
        bootstrap.actions,
        playerEconomy,
        {
          actionId: optimistic.actionId,
          amounts: optimistic.amounts,
          itemId: optimistic.itemId,
        },
        bootstrap.economyMeta?.items,
      );
      if (!next.ok) {
        if (import.meta.env?.DEV) {
          // eslint-disable-next-line no-console
          console.warn("[MinigameSession] dispatch failed", {
            actionId: optimistic.actionId,
            error: next.error,
            availableActions: Object.keys(bootstrap.actions ?? {}),
            apiMode: !!getMinigamesApiUrl(),
          });
        }
        return { ok: false, error: next.error };
      }
      runAfterLocalEconomyCommit(rollback, next.playerEconomy, input);
      return {
        ok: true,
        collectGrants: next.collectGrants,
        generatorJobId: next.generatorJobId,
      };
    },
    [
      bootstrap.actions,
      bootstrap.economyMeta?.items,
      bootstrap.jwt,
      playerEconomy,
      runAfterLocalEconomyCommit,
    ],
  );

  const dispatchMinigameActionsSequential = useCallback(
    (inputs: DispatchMinigameActionInput[]): DispatchMinigameActionResult => {
      if (inputs.length === 0) {
        return { ok: true };
      }
      setApiError(null);
      const rollback = cloneMinigameSnapshot(playerEconomy);
      let current = playerEconomy;
      let applied = 0;
      let lastOk: DispatchMinigameActionResult = { ok: true };
      for (const input of inputs) {
        const optimistic = portalSyncToOptimistic(input);
        const next = applyOptimisticPortalAction(
          bootstrap.actions,
          current,
          {
            actionId: optimistic.actionId,
            amounts: optimistic.amounts,
            itemId: optimistic.itemId,
          },
          bootstrap.economyMeta?.items,
        );
        if (!next.ok) {
          lastOk = { ok: false, error: next.error };
          break;
        }
        current = next.playerEconomy;
        applied += 1;
        lastOk = {
          ok: true,
          collectGrants: next.collectGrants,
          generatorJobId: next.generatorJobId,
        };
      }
      if (applied === 0) {
        return lastOk.ok ? { ok: false, error: "No actions applied" } : lastOk;
      }
      flushSync(() => {
        setPlayerEconomy(current);
      });

      if (!getMinigamesApiUrl()) {
        return lastOk;
      }

      void (async () => {
        let state = rollback;
        for (const input of inputs) {
          const optimistic = portalSyncToOptimistic(input);
          const step = applyOptimisticPortalAction(
            bootstrap.actions,
            state,
            {
              actionId: optimistic.actionId,
              amounts: optimistic.amounts,
              itemId: optimistic.itemId,
            },
            bootstrap.economyMeta?.items,
          );
          if (!step.ok) {
            break;
          }
          try {
            const res =
              "collectJobId" in input
                ? await postPlayerEconomyGeneratorCollect({
                    token: bootstrap.jwt as string,
                    jobId: input.collectJobId,
                  })
                : await postPlayerEconomyAction({
                    token: bootstrap.jwt as string,
                    action: input.action,
                    amounts: input.amounts,
                    // Same as the single-dispatch path: proof and cabinet must
                    // survive to the worker, or a verified claim would arrive
                    // looking like an unverified one.
                    verify: input.verify,
                    cabinet: input.cabinet,
                  });
            state = mergeMinigameEconomyFromApi(
              state,
              authoritativePlayerEconomy(res),
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            setPlayerEconomy(state);
            setApiError(message);
            return;
          }
        }
        setPlayerEconomy(state);
      })();
      return lastOk;
    },
    [
      bootstrap.actions,
      bootstrap.economyMeta?.items,
      bootstrap.jwt,
      playerEconomy,
    ],
  );

  const clearApiError = useCallback(() => setApiError(null), []);

  const replacePlayerEconomy = useCallback(
    (next: MinigameSessionResponse["playerEconomy"]) => {
      setApiError(null);
      setPlayerEconomy(normalizeMinigameFromApi(next));
    },
    [],
  );

  const value = useMemo(
    (): MinigameSessionValue => ({
      farmId: bootstrap.id,
      jwt: bootstrap.jwt as string,
      portalId: bootstrap.portalId,
      economyMeta: bootstrap.economyMeta,
      playerData: bootstrap.playerData,
      farm: bootstrap.farm,
      playerEconomy,
      actions: bootstrap.actions,
      dispatchAction,
      commitLocalPlayerEconomySync,
      dispatchMinigameActionsSequential,
      replacePlayerEconomy,
      apiError,
      clearApiError,
    }),
    [
      bootstrap.id,
      bootstrap.jwt,
      bootstrap.portalId,
      bootstrap.economyMeta,
      bootstrap.playerData,
      bootstrap.farm,
      bootstrap.actions,
      playerEconomy,
      dispatchAction,
      commitLocalPlayerEconomySync,
      dispatchMinigameActionsSequential,
      replacePlayerEconomy,
      apiError,
      clearApiError,
    ],
  );

  return (
    <MinigameSessionContext.Provider value={value}>
      <BootstrapProvider bootstrap={bootstrap}>{children}</BootstrapProvider>
    </MinigameSessionContext.Provider>
  );
}
