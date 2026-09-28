import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import type { GameState, Minigame, MinigameName } from "./gameTypes";
import { isFreeRewardRunAvailableForMinigame } from "../poker/session";

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
  | { type: "arcadeMinigame.rewardRunConfirmed"; name: MinigameName }
  | { type: "arcadeMinigame.ravenCoinWon"; amount: number };

/** How a reward run is paid for.
 *
 *  - `"free"` — today's free allowance. For a non-VIP that is one arcade-wide;
 *    for VIP it is one per machine, which is why the payout also needs the
 *    cabinet's registry id.
 *  - `"ticket"` — the player burned a Play Ticket to start it, so the payout
 *    has to go through the uncapped `Mint-Raven-Coin-Ticket` action.
 */
export type RewardRunFunding = "free" | "ticket";

/** What a payout needs to know about the run that produced it. */
export type RewardWinMeta = {
  fundedBy?: RewardRunFunding;
  /** Registry id of the cabinet, so a VIP free run mints its own action. */
  machine?: string;
  /**
   * Whether the store considered this player VIP, captured at the moment of the
   * win. Which published action pays out depends on it (a VIP's free run is per
   * machine), and taking it from here keeps that decision in the one place that
   * already knows both the run and the player's status.
   */
  isVip?: boolean;
};

export type PortalSendResult =
  { ok: true; funding?: RewardRunFunding } | { ok: false; error: string };

export type PortalService = {
  send: (event: PortalEvent) => PortalSendResult;
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
  send: () => ({ ok: false, error: "Portal service is not mounted." }),
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
  private onWin: (amount: number, meta?: RewardWinMeta) => void = () => {};

  /** Burns one Play Ticket. Swapped in by the provider (see `withArcadeProps`). */
  private onSpendTicket: () => PortalSendResult = () => ({
    ok: false,
    error: "Play Tickets are not available in this session.",
  });

  /**
   * Spends the free allowance by opening the run. Swapped in by the provider.
   *
   * Called *before* the run starts, so the attempt is recorded server-side
   * whether or not the player goes on to win. Without it a lost or abandoned run
   * would cost nothing and could be restarted indefinitely.
   */
  private onStartFreeRun: () => PortalSendResult = () => ({ ok: true });

  /** Mirrors the provider's `isVip` so the funding decision lives in one place. */
  private isVip = false;

  /** How the run currently in progress is paid for; read when it pays out. */
  private runFunding: RewardRunFunding = "free";

  /**
   * Registry id of the cabinet the run in progress belongs to.
   *
   * A VIP's free run is capped *per machine*, so the payout has to know which
   * one — remembered here because the game's own win event only carries an
   * amount.
   */
  private runMachine: string | undefined;

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

  setOnWin(onWin: (amount: number, meta?: RewardWinMeta) => void) {
    this.onWin = onWin;
  }

  setOnSpendTicket(onSpendTicket: () => PortalSendResult) {
    this.onSpendTicket = onSpendTicket;
  }

  setOnStartFreeRun(onStartFreeRun: () => PortalSendResult) {
    this.onStartFreeRun = onStartFreeRun;
  }

  setIsVip(isVip: boolean) {
    if (isVip === this.isVip) return;
    this.isVip = isVip;
  }

  setBase(base: GameState) {
    const changed =
      base.balance !== this.base.balance ||
      base.playTickets !== this.base.playTickets ||
      base.bumpkin !== this.base.bumpkin ||
      base.minigames !== this.base.minigames;
    if (!changed) return;
    this.base = base;
    this.commit();
  }

  /** Today's free allowance is still open on this machine. */
  private freeRunAvailable(name: MinigameName): boolean {
    return isFreeRewardRunAvailableForMinigame({
      game: this.compose(),
      minigame: name,
      isVip: this.isVip,
    });
  }

  send = (event: PortalEvent): PortalSendResult => {
    switch (event.type) {
      case "arcadeMinigame.started": {
        const name = event.name;
        // Fallback for a run that never sent `rewardRunConfirmed`, so a win can
        // still be attributed to the right cabinet.
        this.runMachine = name;
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
        return { ok: true, funding: this.runFunding };
      }
      case "arcadeMinigame.rewardRunConfirmed": {
        // Sent from the "are you sure?" box, i.e. *before* the run begins, so
        // a player can never open a reward run they have not paid for.
        this.runMachine = event.name;

        if (this.freeRunAvailable(event.name)) {
          // Spend the allowance now, while the run is only being opened. The
          // server records it, so losing or abandoning the run does not give it
          // back — and a `dailyCap` refusal here means the run never starts.
          const opened = this.onStartFreeRun();
          if (!opened.ok) return opened;

          this.runFunding = "free";
          return { ok: true, funding: "free" };
        }

        if ((this.compose().playTickets ?? 0) <= 0) {
          return {
            ok: false,
            error: "No free reward runs left today and no Play Tickets.",
          };
        }

        const spent = this.onSpendTicket();
        if (!spent.ok) return spent;

        this.runFunding = "ticket";
        return { ok: true, funding: "ticket" };
      }
      case "arcadeMinigame.ravenCoinWon": {
        // The arcade HUD credits RavenCoins from `onWin`.
        const fundedBy = this.runFunding;
        const machine = this.runMachine;
        const isVip = this.isVip;
        this.runFunding = "free";
        this.runMachine = undefined;
        this.onWin(event.amount ?? 0, { fundedBy, machine, isVip });
        return { ok: true, funding: fundedBy };
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
  /** Session-derived GameState (FLOWER balance, Play Tickets, bumpkin, …). */
  baseState: GameState;
  isVip: boolean;
  onWin: (amount: number, meta?: RewardWinMeta) => void;
  /** Burns one Play Ticket (published as `Mint-Play-Ticket`). */
  onSpendTicket: () => PortalSendResult;
  /**
   * Spends the free allowance by opening the run (`Start-Free-Run-<Cabinet>`).
   * Optional so a caller that has not adopted run-opens still mounts.
   */
  onStartFreeRun?: () => PortalSendResult;
  children: React.ReactNode;
}> = ({ baseState, isVip, onWin, onSpendTicket, onStartFreeRun, children }) => {
  const storeRef = useRef<ArcadePortalStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current = new ArcadePortalStore(baseState);
  }
  const store = storeRef.current;

  useEffect(() => {
    store.setOnWin(onWin);
  }, [store, onWin]);

  useEffect(() => {
    store.setOnSpendTicket(onSpendTicket);
  }, [store, onSpendTicket]);

  useEffect(() => {
    if (onStartFreeRun) store.setOnStartFreeRun(onStartFreeRun);
  }, [store, onStartFreeRun]);

  useEffect(() => {
    store.setIsVip(isVip);
  }, [store, isVip]);

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
