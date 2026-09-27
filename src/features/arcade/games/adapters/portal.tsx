import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { GameState, Minigame, MinigameName } from "./gameTypes";

/**
 * Replacement for the original arcade's xstate portal machine
 * (`source-portal` `lib/NightshadeArcadePortalProvider.tsx` + …Machine.ts).
 *
 * The ten games only ever do three things with it:
 *
 *   portalService.getSnapshot() / useSelector(...)  → read GameState
 *   portalService.send({ type: "arcadeMinigame.started", name })      → +1 attempt
 *   portalService.send({ type: "arcadeMinigame.ravenCoinWon", amount }) → credit prize
 *
 * So instead of pulling in `xstate` for two event handlers this is a tiny
 * subscribe/snapshot store with the same shape. Everything else the original
 * machine did (loading the farm from the portal API, the shop, the daily
 * claim) lives in `lib/portal` in this template.
 */

/** Same envelope xstate exposed: `state.context.state`. */
export type PortalMachineState = {
  context: { state: GameState };
};

export type PortalEvent =
  | { type: "arcadeMinigame.started"; name: MinigameName }
  | { type: "arcadeMinigame.ravenCoinWon"; amount: number };

export type PortalService = {
  send: (event: PortalEvent) => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => PortalMachineState;
};

export type PortalContextValue = {
  portalService: PortalService;
  /**
   * Whether this player counts as VIP for reward-run gating.
   *
   * This fork has no VIP source (see `useVipAccess`), so the provider passes
   * it in — the arcade treats a session-less (offline/test) boot as VIP.
   */
  isVip: boolean;
};

const todayKey = (now: Date | number = Date.now()) =>
  new Date(now).toISOString().slice(0, 10);

const EMPTY_STATE: GameState = { balance: 0, minigames: { games: {} } };
const EMPTY_SNAPSHOT: PortalMachineState = { context: { state: EMPTY_STATE } };

/** Safe default so the context is never `undefined` outside the provider. */
const noopService: PortalService = {
  send: () => {},
  subscribe: () => () => {},
  getSnapshot: () => EMPTY_SNAPSHOT,
};

export const PortalContext = createContext<PortalContextValue>({
  portalService: noopService,
  isVip: false,
});

class ArcadePortalStore implements PortalService {
  private listeners = new Set<() => void>();
  private base: GameState;
  /** Attempts earned this session; not persisted (a reload resets them). */
  private localGames: Record<MinigameName, Minigame> = {};
  private snapshot: PortalMachineState;

  /** Latest `onWin` — swapped in by the provider whenever it changes. */
  private onWin: (amount: number) => void = () => {};

  constructor(base: GameState) {
    this.base = base;
    this.snapshot = { context: { state: this.compose() } };
  }

  private compose(): GameState {
    return {
      ...this.base,
      minigames: {
        ...this.base.minigames,
        // Locally-recorded attempts layer over whatever the session reported.
        games: { ...this.base.minigames?.games, ...this.localGames },
      },
    };
  }

  private commit() {
    // New object identity on every mutation — `useSelector` reads
    // `state.context.state`, so a stable snapshot is what stops re-renders.
    this.snapshot = { context: { state: this.compose() } };
    this.listeners.forEach((listener) => listener());
  }

  setOnWin(onWin: (amount: number) => void) {
    this.onWin = onWin;
  }

  setBase(base: GameState) {
    const changed =
      base.balance !== this.base.balance ||
      base.bumpkin !== this.base.bumpkin ||
      base.minigames !== this.base.minigames;
    if (!changed) return;
    this.base = base;
    this.commit();
  }

  send = (event: PortalEvent) => {
    switch (event.type) {
      case "arcadeMinigame.started": {
        const name = event.name;
        const previous = this.localGames[name] ?? {
          history: {},
          purchases: [],
        };
        const day = todayKey();
        const daily = previous.history?.[day] ?? { attempts: 0 };

        this.localGames = {
          ...this.localGames,
          [name]: {
            ...previous,
            history: {
              ...previous.history,
              [day]: { ...daily, attempts: daily.attempts + 1 },
            },
          },
        };
        this.commit();
        return;
      }
      case "arcadeMinigame.ravenCoinWon": {
        // The arcade HUD credits RavenCoins from `onWin`.
        this.onWin(event.amount ?? 0);
        return;
      }
    }
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;
}

/**
 * Supplies `PortalContext` for one game. Mounted by `withArcadeProps`, which
 * is how every `GAME_REGISTRY` component gets its arcade wiring.
 */
export const ArcadePortalProvider: React.FC<{
  /** Session-derived GameState (FLOWER balance, bumpkin, …). */
  baseState: GameState;
  isVip: boolean;
  onWin: (amount: number) => void;
  children: React.ReactNode;
}> = ({ baseState, isVip, onWin, children }) => {
  const storeRef = useRef<ArcadePortalStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new ArcadePortalStore(baseState);
  }
  const store = storeRef.current;

  useEffect(() => {
    store.setOnWin(onWin);
  }, [store, onWin]);

  useEffect(() => {
    store.setBase(baseState);
  }, [store, baseState]);

  const value = useMemo<PortalContextValue>(
    () => ({ portalService: store, isVip }),
    [store, isVip],
  );

  return (
    <PortalContext.Provider value={value}>{children}</PortalContext.Provider>
  );
};

export function usePortalContext(): PortalContextValue {
  return useContext(PortalContext);
}
