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
  postPlayerEconomyAction,
  postPlayerEconomyGeneratorCollect,
} from "./api";
import { PLAYER_ECONOMY_GENERATOR_COLLECTED_ACTION } from "./playerEconomyTypes";
import {
  applyOptimisticPortalAction,
  cloneMinigameSnapshot,
  mergeMinigameEconomyFromApi,
  normalizeMinigameFromApi,
} from "./runtimeHelpers";

/**
 * Payload the session will send on `POST /action` after an optimistic update.
 * Use `collectJobId` for generator harvest (`generator.collected`), not a fake `action` id.
 */
export type PortalEconomySyncInput =
  | { action: string; amounts?: Record<string, number> }
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
  dispatchAction: (input: DispatchMinigameActionInput) => DispatchMinigameActionResult;
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
            });

      void postPromise.then(
        (res) => {
          setPlayerEconomy((prev) =>
            mergeMinigameEconomyFromApi(prev, res.playerEconomy),
          );
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
          console.warn(
            "[MinigameSession] dispatch failed",
            {
              actionId: optimistic.actionId,
              error: next.error,
              availableActions: Object.keys(bootstrap.actions ?? {}),
              apiMode: !!getMinigamesApiUrl(),
            },
          );
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
                  });
            state = mergeMinigameEconomyFromApi(state, res.playerEconomy);
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
    [bootstrap.actions, bootstrap.economyMeta?.items, bootstrap.jwt, playerEconomy],
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
      {children}
    </MinigameSessionContext.Provider>
  );
}
