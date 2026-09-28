import React, { useCallback, useMemo, useState } from "react";
import { InnerPanel } from "components/ui/Panel";
import { Label } from "components/ui/Label";
import { isFreeRewardRunAvailableForMinigame } from "../poker/session";
import type { GameState, MinigameName } from "./gameTypes";
import type { PortalService } from "./portal";

/**
 * The "are you sure?" box + the rules that decide how a reward run is paid for.
 *
 * All ten cabinets answer the same two questions, so the answer lives here
 * instead of being copied into each game:
 *
 *  - is a reward run available at all? Today's free allowance, or a Play Ticket
 *    the player is holding;
 *  - how is *this* one paid for? The store decides when the player confirms —
 *    a free run records itself, a ticket run burns one through
 *    `Mint-Play-Ticket` **before** the run starts, so a reward run can never be
 *    opened without paying.
 *
 * Usage in a game:
 *
 * ```tsx
 * const rewardRun = useRewardRun({
 *   game: portalGameState,
 *   minigame: "poker",
 *   isVip,
 *   portalService,
 *   startRewardRun: () => startGame("reward"),
 * });
 *
 * <button disabled={!rewardRun.available} onClick={rewardRun.start}>…</button>
 * {rewardRun.dialog}
 * ```
 */
export function useRewardRun({
  game,
  minigame,
  isVip,
  portalService,
  startRewardRun,
}: {
  game: GameState;
  minigame: MinigameName;
  isVip: boolean;
  portalService: PortalService;
  startRewardRun: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const freeAvailable = useMemo(
    () => isFreeRewardRunAvailableForMinigame({ game, minigame, isVip }),
    [game, minigame, isVip],
  );

  const tickets = game.playTickets ?? 0;
  const available = freeAvailable || tickets > 0;

  const confirm = useCallback(() => {
    const result = portalService.send({
      type: "arcadeMinigame.rewardRunConfirmed",
      name: minigame,
    });
    setConfirming(false);

    if (result.ok) {
      setError(null);
      startRewardRun();
      return;
    }

    setError(result.error);
  }, [minigame, portalService, startRewardRun]);

  const start = useCallback(() => {
    setError(null);

    if (freeAvailable) {
      // The confirmation is what *spends* the run: it opens the free run
      // (recording the attempt server-side) or burns a Play Ticket. Its verdict
      // has to be honoured — starting the run anyway after a refusal would open
      // a reward run that cost nothing, which is exactly the hole this call
      // exists to close.
      const result = portalService.send({
        type: "arcadeMinigame.rewardRunConfirmed",
        name: minigame,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      startRewardRun();
      return;
    }

    setConfirming(true);
  }, [freeAvailable, minigame, portalService, startRewardRun]);

  const cancel = useCallback(() => setConfirming(false), []);

  /** Ready-made confirmation box — render it anywhere in the mode screen. */
  const dialog = confirming ? (
    <InnerPanel className="bg-yellow-100 p-4 text-center">
      <Label className="block text-sm font-bold text-gray-800">
        ARE YOU SURE?
      </Label>
      <p className="mt-2 text-xs text-gray-700">
        Today&apos;s free reward run is already used. Starting another one burns
        <b> 1 Play Ticket</b>.
      </p>
      <p className="mt-1 text-xs text-gray-700">
        Play Tickets: <b>{tickets}</b>
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <button
          onClick={confirm}
          className="w-full px-4 py-3 rounded-lg font-bold text-sm bg-green-500 text-white hover:bg-green-600 active:scale-95 transition-all shadow-lg"
        >
          CONFIRM — USE 1 PLAY TICKET
        </button>
        <button
          onClick={cancel}
          className="w-full px-4 py-2 rounded-lg font-semibold text-sm bg-gray-400 text-white hover:bg-gray-500 active:scale-95 transition-all"
        >
          CLOSE
        </button>
      </div>
    </InnerPanel>
  ) : null;

  return {
    /** Is any reward run left — free, or payable with a ticket? */
    available,
    /** Is today's free allowance still open? (False ⇒ starting costs a ticket.) */
    freeAvailable,
    /** Play Tickets held, for the button subtitle. */
    tickets,
    /** Ask to start: opens the confirm box when a ticket has to be burned. */
    start,
    confirm,
    cancel,
    /** Server refusal, e.g. "Insufficient Play Ticket". */
    error,
    dialog,
  };
}
