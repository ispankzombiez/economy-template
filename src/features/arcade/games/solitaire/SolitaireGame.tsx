/* eslint-disable react/jsx-no-literals, react/no-unescaped-entities */
import React, {
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSelector } from "../adapters/useSelector";
import { Button } from "components/ui/Button";
import { InnerPanel, OuterPanel } from "components/ui/Panel";
import { SquareIcon } from "components/ui/SquareIcon";
import { ITEM_DETAILS } from "../adapters/itemDetails";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import { startAttempt, submitScore } from "../adapters/portalUtil";
import { useVipAccess } from "../adapters/useVipAccess";
import { useRewardRun } from "../adapters/rewardRun";
import { PortalContext } from "../adapters/portal";
import { PortalMachineState } from "../adapters/portal";
import { Card, CardSuit } from "../poker/types";
import {
  getSolitaireDifficulty,
  isSolitaireRewardRunAvailable,
  SOLITAIRE_DIFFICULTIES,
  SolitaireDifficulty,
  SOLITAIRE_RAVEN_COIN_REWARD,
  SolitaireDifficultyName,
  SolitaireMode,
} from "./session";
import {
  SelectedCard,
  SolitaireState,
} from "./types";
import {
  applyAutoFoundation,
  applyDraw,
  applyMoveToFoundation,
  applyMoveToTableau,
  applySmartMove,
  createSolvableDeal,
  getFoundationsCount,
  MAX_UNDOS_PER_GAME,
  SUITS,
} from "./engine";
import {
  encodeActionLog,
  encodeSolitaireLog,
  MAX_SOLITAIRE_ACTIONS,
  SOLITAIRE_OPS,
} from "@nightshade/shared/anticheat/solitaireLog";
import type { SolitaireAction } from "@nightshade/shared/anticheat/solitaireLog";
import type { VerifiedRun } from "lib/portal/api";
import { postEconomyWrite } from "lib/portal/api";
import { useBootstrap } from "lib/portal/BootstrapContext";

const solitairePanelClassName =
  "mx-auto w-full max-w-[1200px] h-[min(95vh,900px)] overflow-hidden";

const _portalState = (state: PortalMachineState) => state.context.state;

const colorText: Record<CardSuit, string> = {
  Kale: "text-slate-900",
  Barley: "text-red-700",
  Wheat: "text-red-700",
  Radish: "text-slate-900",
};

const colorBg: Record<CardSuit, string> = {
  Kale: "bg-white",
  Barley: "bg-white",
  Wheat: "bg-white",
  Radish: "bg-white",
};

const colorBorder: Record<CardSuit, string> = {
  Kale: "border-slate-400",
  Barley: "border-red-300",
  Wheat: "border-red-300",
  Radish: "border-slate-400",
};

/**
 * How much of each stacked card stays visible, as a negative top margin.
 *
 * ## Why they are responsive
 *
 * A pile's height is `card height + (cards - 1) x reveal`, and a tableau pile
 * can legitimately hold all 13 cards, so these four numbers decide whether the
 * board fits a phone at all. Measured per role in the browser at 320x640, on a
 * 56px phone card, each negative margin leaves this much of the card showing:
 *
 * | role                          | phone class        | reveal | desktop reveal |
 * |-------------------------------|--------------------|--------|----------------|
 * | card buried under a face-down | `-mt-[50px]`       | 6px    | 28px           |
 * | first face-up on a face-down  | `-mt-[50px]`       | 6px    | 12px           |
 * | playable card of a stack      | `-mt-8`            | 24px   | 52px           |
 * | rest of a face-up run         | `-mt-[50px]`       | 6px    | 20px           |
 *
 * The phone reveal is 6px because that is what a full pile needs. Measured at
 * 320x640: the column is 578px tall, the header, stock row, action buttons and
 * hint line take 216 of it, and the seven piles share two rows of the
 * remaining 362 — 175px per pile, of which 156 is the stack area once the 14px
 * label, 8px of padding and 2px of border are taken off it. The most expensive
 * legal pile is six face-down then seven face-up, and at a 6px reveal it costs
 * 56 + 5x6 + 6 + 24 + 5x6 = 146 of the 156 available.
 *
 * At the 8px reveal this shipped first with, the same pile costs
 * 56 + 5x8 + 6 + 24 + 5x8 = 166 — ten more than the pile has — so the last two
 * cards of a full pile hung out of the bottom of their own pile, past the
 * panel's own edge, which is the one thing the layout is for. The desktop
 * figures are untouched: an 80px card with a 20px reveal reads exactly as it
 * always did.
 *
 * The cost is that a buried card is a thinner strip on a phone than on a
 * monitor — 6px shows its border and the top of its corner. Every pile's
 * playable card, the one that is actually tapped, is drawn in full.
 */
const FACE_DOWN_OVERLAP_CLASS = "-mt-[50px] md:-mt-[52px]";
const FACE_UP_AFTER_FACE_DOWN_OVERLAP_CLASS = "-mt-[50px] md:-mt-[68px]";
const FACE_UP_STACK_OVERLAP_CLASS = "-mt-[50px] md:-mt-[60px]";
const FACE_UP_TOP_CARD_OVERLAP_CLASS = "-mt-8 md:-mt-[28px]";

const suitImages: Record<CardSuit, string> = {
  Kale: ITEM_DETAILS.Kale.image,
  Barley: ITEM_DETAILS.Barley.image,
  Wheat: ITEM_DETAILS.Wheat.image,
  Radish: ITEM_DETAILS.Radish.image,
};

export const SolitaireGame: React.FC<{ onClose?: () => void }> = ({
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const bootstrap = useBootstrap();
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });

  const hasRewardRun = useMemo(
    () => isSolitaireRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const todaysDifficulty = useMemo(() => getSolitaireDifficulty(), []);

  const [sessionMode, setSessionMode] = useState<SolitaireMode | null>(null);
  const [gameState, setGameState] = useState<SolitaireState | null>(null);
  const [rewardGranted, setRewardGranted] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  /**
   * True while a reward run's server-issued deal seed is being fetched.
   *
   * The ticket is already burned before `startSession` runs, and the seed is
   * written only after that burn settles, so there is a real wait — a second or
   * two — between confirming and having a deal to show. This flag flips the
   * menu into a "starting" card for that wait, so the menu never sits frozen
   * under a tap that appears to have done nothing (and cannot be double-tapped
   * into opening — and paying for — a second run).
   */
  const [startingRun, setStartingRun] = useState(false);
  // True when a reward run could not read the seed the server issued for it.
  // The deal is never built from a local substitute: the claim only mints
  // against the issued seed, so playing on would be a win that pays nothing.
  const [seedError, setSeedError] = useState(false);
  const [showPracticeDifficultyPrompt, setShowPracticeDifficultyPrompt] =
    useState(false);
  const [practiceDifficultyName, setPracticeDifficultyName] =
    useState<SolitaireDifficultyName>(todaysDifficulty.name);
  const [activeDifficulty, setActiveDifficulty] =
    useState<SolitaireDifficulty>(todaysDifficulty);
  const undoHistoryRef = useRef<SolitaireState[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [undosRemaining, setUndosRemaining] = useState(MAX_UNDOS_PER_GAME);
  /**
   * Every action that changed this game, in play order — the run's proof.
   *
   * Appended by `setGameStateWithUndo` only when the applier returned a new
   * state, so the log holds exactly the moves that happened: a tap that
   * changed nothing leaves no trace, which is what lets the worker treat a
   * logged action that changes nothing during replay as tampering rather than
   * as a routine no-op. Frozen into the claim when the last card lands; the
   * worker re-applies the whole list to the same deal and pays only if its own
   * board reaches fifty-two.
   */
  const moveLogRef = useRef<SolitaireAction[]>([]);
  /**
   * The seed the deck was actually dealt from.
   *
   * `createSolvableDeal` walks up to 100 seeds forward before finding a
   * solvable one, and the claim must name the seed that produced *this* board:
   * naming the base seed instead would have the worker rebuild a different
   * deal and refuse an honest game.
   */
  const runSeedRef = useRef<number | null>(null);
  /** When the session began, for the claim's `elapsedMs` — informational only. */
  const runStartedAtRef = useRef<number>(0);

  const returnToMenu = useCallback(() => {
    setShowExitConfirm(false);
    setShowPracticeDifficultyPrompt(false);
    setSessionMode(null);
    setGameState(null);
    setStartingRun(false);
    setSeedError(false);
    undoHistoryRef.current = [];
    moveLogRef.current = [];
    runSeedRef.current = null;
    setUndoCount(0);
    setUndosRemaining(MAX_UNDOS_PER_GAME);
  }, []);

  /**
   * The one door every state-changing move goes through.
   *
   * Three jobs, in the order they matter:
   *
   *  1. Apply the applier. An applier that returns its input unchanged is an
   *     illegal or empty move — the update stops here, and *nothing else runs*,
   *     which is why `makeAction` is only consulted on a real change. The log
   *     therefore contains exactly the actions that happened, never the taps
   *     that did not.
   *  2. Record the action (`makeAction`), which is built from the *previous*
   *     state — a move's source (the selected card) exists only before the
   *     move lands on it.
   *  3. Push one undo snapshot, same as before.
   *
   * `makeAction` runs inside the state updater, matching the pattern this
   * component already relied on for `undoHistoryRef`: updaters run once per
   * `setGameState` here (no `StrictMode` in this tree), and React dispatches
   * click handlers one at a time, so a rapid second tap sees the first tap's
   * state.
   */
  const setGameStateWithUndo = useCallback(
    (
      updater: (previous: SolitaireState) => SolitaireState,
      makeAction?: (previous: SolitaireState) => SolitaireAction,
    ) => {
      setGameState((previous) => {
        if (!previous) return previous;

        const next = updater(previous);
        if (next === previous) return previous;

        if (makeAction) {
          moveLogRef.current.push(makeAction(previous));
        }

        const nextHistory = [...undoHistoryRef.current, previous];
        undoHistoryRef.current = nextHistory;
        setUndoCount(nextHistory.length);

        return next;
      });
    },
    [],
  );

  /**
   * Read the deal seed the server issued for the run that is open.
   *
   * Returns null on any error — a reward run then stops and reports it rather
   * than ever dealing from a seed the server did not issue.
   * Retries until the returned runKey is recent (within ~15s), to avoid racing
   * the server's `active_runs` row creation: the ticket burn that opens the run
   * is fire-and-forget, so this poll is usually the thing *waiting* on that
   * round-trip to settle.
   */
  const fetchRunSeed = useCallback(
    async (jwt: string | undefined): Promise<number | null> => {
      if (!jwt) return null;
      const startedAt = Date.now();
      const maxWaitMs = 10_000;
      // Tight on purpose: the seed is written after the ticket burn settles, so
      // a coarse interval would stack its own latency on top of the round trip
      // once the row lands.
      const pollIntervalMs = 150;

      while (Date.now() - startedAt < maxWaitMs) {
        try {
          const res = await postEconomyWrite({ token: jwt, intent: "run-seed" });
          const payload = res.data as { seed?: number; runKey?: number } | undefined;
          if (payload?.seed !== undefined && payload?.runKey) {
            const runAgeMs = Date.now() - payload.runKey;
            if (runAgeMs <= 15_000) return Number(payload.seed);
            // Stale runKey (an older, already-played run): wait for the new
            // one to be written before trusting the seed beside it.
          }
        } catch {
          // Transient — retry.
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      return null;
    },
    [],
  );

  /** A local seed for practice runs, which are never verified. */
  const getPracticeSeed = useCallback(() => {
    return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  }, []);

  const startSession = useCallback(
    async (
      mode: SolitaireMode,
      practiceDifficultyOverride?: SolitaireDifficultyName,
    ) => {
      if (mode === "reward" && !hasRewardRun) return;

      // From here a paid run is already being opened on the server (the confirm
      // handler burned the ticket / spent the allowance before calling in), so
      // flip the loading card immediately — before the seed round-trip below —
      // so the menu never sits frozen while we wait. Cleared once the deal
      // exists and the mode flips.
      if (mode === "reward") setStartingRun(true);
      setSeedError(false);

      const selectedPracticeDifficulty =
        SOLITAIRE_DIFFICULTIES.find(
          (d) =>
            d.name === (practiceDifficultyOverride ?? practiceDifficultyName),
        ) ?? todaysDifficulty;

      const runDifficulty =
        mode === "reward" ? todaysDifficulty : selectedPracticeDifficulty;

      // Reward run: the deal's *base* seed is issued by the server at run-open
      // and read back here; `createSolvableDeal` then walks forward from it to
      // a solvable board, and the worker accepts any seed inside that walk
      // window. No local substitute ever — the claim only mints against the
      // issued seed, so a substitute would deal a game that pays nothing.
      // Practice: a local seed, because it is never verified.
      let baseSeed: number;
      if (mode === "reward") {
        const issued = await fetchRunSeed(bootstrap?.jwt);
        if (issued === null) {
          setStartingRun(false);
          setSeedError(true);
          return;
        }
        baseSeed = issued;
      } else {
        baseSeed = getPracticeSeed();
      }

      setActiveDifficulty(runDifficulty);
      setSessionMode(mode);
      setRewardGranted(false);
      setShowExitConfirm(false);
      setShowPracticeDifficultyPrompt(false);
      undoHistoryRef.current = [];
      moveLogRef.current = [];
      setUndoCount(0);
      setUndosRemaining(MAX_UNDOS_PER_GAME);

      const deal = createSolvableDeal(
        baseSeed,
        runDifficulty.maxPasses,
        runDifficulty.drawCount,
      );
      // The *resolved* seed, not the base one: `createSolvableDeal` may have
      // walked forward before finding a solvable deal, and the claim names
      // this so the worker rebuilds this exact board with one
      // `createInitialState` instead of re-running the solver search. The
      // worker binds it to the issued base via the same walk window.
      runSeedRef.current = deal.seed;
      runStartedAtRef.current = Date.now();
      setGameState(deal.state);

      if (mode === "reward") {
        portalService.send({
          type: "arcadeMinigame.started",
          name: "solitaire" as any,
        });
        startAttempt();
      }

      // Clear the flag after the mode has flipped: the lobby only renders while
      // `sessionMode` is null, so once it flips the loading card is gone
      // regardless — but a later return-to-menu must not inherit a stale
      // "starting" state.
      setStartingRun(false);
    },
    [
      hasRewardRun,
      portalService,
      practiceDifficultyName,
      todaysDifficulty,
      bootstrap,
      fetchRunSeed,
      getPracticeSeed,
    ],
  );

  // Free run first, then 1 burned Play Ticket per attempt — with the "are you
  // sure?" box in between. `hasRewardRun` is kept as the availability check so
  // the button and the store can never disagree.
  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "solitaire",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  const drawFromStock = useCallback(() => {
    setGameStateWithUndo(
      (previous) => applyDraw(previous, activeDifficulty.drawCount),
      () => ({ op: SOLITAIRE_OPS.DRAW }),
    );
  }, [setGameStateWithUndo, activeDifficulty.drawCount]);

  const selectWaste = useCallback(() => {
    setGameState((previous) => {
      if (!previous || previous.waste.length === 0) return previous;
      return {
        ...previous,
        selected:
          previous.selected?.source === "waste" ? null : { source: "waste" },
      };
    });
  }, []);

  const selectTableauCard = useCallback(
    (pileIndex: number, cardIndex: number) => {
      setGameState((previous) => {
        if (!previous) return previous;

        const pile = previous.tableau[pileIndex];
        if (!pile || cardIndex < 0 || cardIndex >= pile.faceUp.length)
          return previous;

        const selected: SelectedCard = {
          source: "tableau",
          pileIndex,
          cardIndex,
        };

        const isSameSelection =
          previous.selected?.source === "tableau" &&
          previous.selected.pileIndex === pileIndex &&
          previous.selected.cardIndex === cardIndex;

        return {
          ...previous,
          selected: isSameSelection ? null : selected,
        };
      });
    },
    [],
  );

  const moveSelectedToTableau = useCallback(
    (targetIndex: number) => {
      setGameStateWithUndo(
        (previous) =>
          applyMoveToTableau(previous, previous.selected, targetIndex),
        // Built from the state *before* the move — `previous.selected` is the
        // source the player actually picked, which the post-move state has
        // already cleared to `null`.
        (previous) => ({
          op: SOLITAIRE_OPS.MOVE_TO_TABLEAU,
          source: previous.selected as NonNullable<SelectedCard>,
          target: targetIndex,
        }),
      );
    },
    [setGameStateWithUndo],
  );

  const moveSelectedToFoundation = useCallback(
    (targetSuit: CardSuit) => {
      setGameStateWithUndo(
        (previous) =>
          applyMoveToFoundation(previous, previous.selected, targetSuit),
        (previous) => ({
          op: SOLITAIRE_OPS.MOVE_TO_FOUNDATION,
          source: previous.selected as NonNullable<SelectedCard>,
          // The suit index of the foundation that was clicked. The engine
          // re-checks the card actually sits on that suit, so a log that names
          // a mismatched suit changes nothing and is refused as tampering.
          suit: SUITS.indexOf(targetSuit),
        }),
      );
    },
    [setGameStateWithUndo],
  );

  const autoMoveToFoundation = useCallback(() => {
    setGameStateWithUndo(
      (previous) => applyAutoFoundation(previous),
      // One action however many cards the sweep moves — the sweep is a
      // deterministic function of the state, so it replays as the same sweep
      // and one undo reverts it whole, exactly as the UI does.
      () => ({ op: SOLITAIRE_OPS.AUTO_FOUNDATION }),
    );
  }, [setGameStateWithUndo]);

  const undoMove = useCallback(() => {
    if (undosRemaining <= 0) return;

    const history = undoHistoryRef.current;
    if (history.length === 0) return;

    const previousSnapshot = history[history.length - 1];
    const nextHistory = history.slice(0, -1);

    undoHistoryRef.current = nextHistory;
    setUndoCount(nextHistory.length);
    setUndosRemaining((previous) => previous - 1);
    // Logged beside the moves it rewinds, so the worker's replay pops its own
    // history stack in lockstep and lands on this same board. The allowance
    // (`undosRemaining`) needs no encoding: a log with more than
    // `MAX_UNDOS_PER_GAME` undos could not have come from this button, and the
    // worker refuses it on the count.
    moveLogRef.current.push({ op: SOLITAIRE_OPS.UNDO });
    setGameState(previousSnapshot);
  }, [undosRemaining]);

  const smartMove = useCallback(
    (source: "waste" | { pileIndex: number; cardIndex: number }) => {
      // The UI's loose source shape (its callers predate `SelectedCard`) maps
      // onto the same shape the applier and the log codec share, so there is
      // one conversion here rather than a reinterpretation on every path.
      const selected: SelectedCard =
        source === "waste"
          ? { source: "waste" }
          : {
              source: "tableau",
              pileIndex: source.pileIndex,
              cardIndex: source.cardIndex,
            };

      setGameStateWithUndo(
        (previous) => applySmartMove(previous, selected),
        () => ({
          op: SOLITAIRE_OPS.SMART,
          source: selected,
        }),
      );
    },
    [setGameStateWithUndo],
  );

  const handleTableauCardClick = useCallback(
    (pileIndex: number, cardIndex: number) => {
      const selected = gameState?.selected;

      if (!selected) {
        selectTableauCard(pileIndex, cardIndex);
        return;
      }

      if (selected.source === "waste") {
        moveSelectedToTableau(pileIndex);
        return;
      }

      if (selected.pileIndex !== pileIndex) {
        moveSelectedToTableau(pileIndex);
        return;
      }

      selectTableauCard(pileIndex, cardIndex);
    },
    [gameState, moveSelectedToTableau, selectTableauCard],
  );

  const solved = useMemo(() => {
    if (!gameState) return false;
    return getFoundationsCount(gameState) === 52;
  }, [gameState]);

  const progressCount = useMemo(() => {
    if (!gameState) return 0;
    return getFoundationsCount(gameState);
  }, [gameState]);

  const completeRewardIfNeeded = useCallback(() => {
    if (!gameState || !solved || sessionMode !== "reward" || rewardGranted)
      return;

    // A log past the codec's ceiling could not be encoded, hence not
    // verified, hence not paid — sending it would burn the reward run for a
    // claim the worker must refuse. Reaching it also means something is
    // appending moves after the win, so the run's proof would no longer be
    // the winning game either. Unreachable in honest play (a win is a couple
    // hundred moves; the ceiling is 4096); guarded because the failure mode
    // is a silently-unpayable reward run, not a crash.
    if (moveLogRef.current.length > MAX_SOLITAIRE_ACTIONS) {
      console.error("[solitaire] action log exceeded the replay ceiling");
      return;
    }

    // The coin is paid on proof, not on assertion. The claim carries the deal
    // seed the board was actually built from and every action that changed
    // it; the worker rebuilds the deal, re-applies the actions, and mints only
    // if its own board reaches all fifty-two cards. Built here — in the same
    // tick the last card lands — so later moves cannot pad the log that gets
    // verified.
    const verify: VerifiedRun = {
      cabinet: "solitaire",
      score: progressCount,
      // No milestones and no pace floor: Solitaire is turn-based, so the
      // brawler's wave checkpoints and duration checks have nothing to check
      // here. The action log below *is* the verification — full coverage of
      // the game rather than sampled moments of it.
      checkpoints: [],
      elapsedMs: Date.now() - runStartedAtRef.current,
      replay: {
        seed: runSeedRef.current ?? 0,
        difficulty: activeDifficulty.name,
        actions: encodeSolitaireLog(encodeActionLog(moveLogRef.current)),
      },
    };

    submitScore({ score: progressCount });
    portalService.send({
      type: "arcadeMinigame.ravenCoinWon",
      amount: SOLITAIRE_RAVEN_COIN_REWARD,
      verify,
    });
    setRewardGranted(true);
  }, [
    gameState,
    solved,
    sessionMode,
    rewardGranted,
    progressCount,
    activeDifficulty,
    portalService,
  ]);

  if (solved) {
    completeRewardIfNeeded();
  }

  // ## Why the card box is two CSS variables
  //
  // A card's width and height are read in four places — the face, the back, the
  // stock/foundation buttons and the waste fan — and the pile overlap maths
  // above is derived from the height. Declaring the size once on the play area
  // (`--card-w` / `--card-h`, one pair of `md:` overrides) is what keeps the
  // fan, the pile slots and the cards from drifting apart at a third size.
  //
  // 44 x 56 on a phone rather than the desktop's 56 x 80: seven piles across a
  // 320px viewport is 37px each, so the tableau cannot be one row at *any*
  // phone card size — see the tableau's note. Within the four columns it does
  // get, 44 is exactly the floor a thumb can be relied on to find, and the
  // corner suit icons are scaled with it too - SquareIcon takes its size in
  // game pixels rather than classes, so a 0.62 transform is what stops an 18px
  // icon covering 42% of a 44px card and colliding with the rank in the middle.
  const renderCard = (card: Card, highlight = false) => {
    return (
      <div
        className={`w-[var(--card-w)] h-[var(--card-h)] border-2 ${colorBorder[card.suit]} ${colorBg[card.suit]} ${colorText[card.suit]} rounded p-1 relative shadow ${highlight ? "ring-2 ring-yellow-300" : ""}`}
      >
        <div className="absolute top-1 left-1 scale-[0.62] md:scale-100">
          <SquareIcon icon={suitImages[card.suit]} width={7} />
        </div>
        <div className="absolute bottom-1 right-1 scale-[0.62] md:scale-100 rotate-180">
          <SquareIcon icon={suitImages[card.suit]} width={7} />
        </div>
        <span className="absolute inset-0 grid place-items-center text-base md:text-xl font-bold leading-none">
          {card.rank}
        </span>
      </div>
    );
  };

  const renderCardBack = () => (
    <div className="w-[var(--card-w)] h-[var(--card-h)] border border-white/40 rounded bg-slate-700 grid place-items-center text-sm text-slate-200">
      ?
    </div>
  );

  if (!sessionMode || !gameState) {
    return (
      <OuterPanel className={solitairePanelClassName}>
        <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
          <div className="text-center space-y-2">
            <h2 className="text-4xl font-bold">SOLITAIRE</h2>
            <p className="text-sm text-gray-600">
              Klondike rules. Move all cards to the four suit foundations.
            </p>
          </div>

          <InnerPanel className="bg-yellow-100 p-4">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">
                  REWARD
                </div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-yellow-700">
                  {SOLITAIRE_RAVEN_COIN_REWARD}
                  <img
                    src={ravenCoinIcon}
                    alt="RavenCoin"
                    className="w-6 h-6"
                  />
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">TODAY</div>
                <div className="text-2xl font-bold text-yellow-700">
                  {todaysDifficulty.label}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">DRAW</div>
                <div className="text-2xl font-bold text-yellow-700">
                  {todaysDifficulty.drawCount}
                </div>
              </div>
            </div>
          </InnerPanel>

          <InnerPanel className="bg-slate-50 p-3 text-sm text-slate-700">
            <div className="font-semibold">Today's rules</div>
            <div className="mt-1">
              Draw {todaysDifficulty.drawCount} from stock. Redeals available:{" "}
              {todaysDifficulty.maxPasses}.
            </div>
            <div className="mt-1">
              Reward runs use today's difficulty. Practice lets you choose.
            </div>
          </InnerPanel>

          <button
            onClick={rewardRun.start}
            disabled={!hasRewardRun || startingRun}
            className={`w-full px-6 py-4 rounded-lg font-bold transition-all shadow-lg text-lg ${
              hasRewardRun && !startingRun
                ? "bg-green-500 text-white hover:bg-green-600 active:scale-95"
                : "bg-gray-300 text-gray-500 cursor-not-allowed"
            }`}
          >
            <div>{startingRun ? "STARTING…" : "START REWARD RUN"}</div>
            <div className="mt-2 text-xs opacity-90">
              {!hasRewardRun
                ? "No reward runs left today — buy Play Tickets in the shop."
                : startingRun
                  ? "Dealing your run…"
                  : rewardRun.freeAvailable
                    ? isVip
                      ? "VIP: reward run available for Solitaire today."
                      : "Reward run available for the arcade today."
                    : `Uses 1 Play Ticket (you have ${rewardRun.tickets}).`}
            </div>
          </button>

          <button
            onClick={() => setShowPracticeDifficultyPrompt(true)}
            disabled={startingRun}
            className={`w-full px-6 py-4 bg-blue-500 text-white font-bold rounded-lg active:scale-95 transition-all shadow-lg text-lg ${
              startingRun ? "opacity-50 cursor-not-allowed" : "hover:bg-blue-600"
            }`}
          >
            <div>START PRACTICE MODE</div>
            <div className="mt-2 text-xs font-semibold opacity-90">
              Play without spending today's reward attempt.
            </div>
          </button>

          {rewardRun.dialog}

          {rewardRun.error && (
            <p className="text-center text-xs font-semibold text-red-600">
              {rewardRun.error}
            </p>
          )}

          {onClose && (
            <button
              onClick={() => onClose()}
              className="w-full px-6 py-2 bg-gray-400 text-white font-semibold rounded-lg hover:bg-gray-500 active:scale-95 transition-all"
            >
              EXIT
            </button>
          )}

          {showExitConfirm && (
            <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-sm rounded border border-white/30 bg-slate-900 p-4 space-y-4 text-white">
                <h3 className="text-lg font-bold">Exit Solitaire?</h3>
                <p className="text-sm text-slate-200">
                  Are you sure you want to exit? Current progress will be lost.
                </p>
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setShowExitConfirm(false)}>
                    CANCEL
                  </Button>
                  <Button onClick={() => onClose?.()}>EXIT</Button>
                </div>
              </div>
            </div>
          )}

          {showPracticeDifficultyPrompt && (
            <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-md rounded border border-white/30 bg-slate-900 p-4 space-y-4 text-white">
                <h3 className="text-lg font-bold">
                  Select Practice Difficulty
                </h3>
                <p className="text-sm text-slate-200">
                  Choose a difficulty to start practice mode.
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {SOLITAIRE_DIFFICULTIES.map((difficulty) => (
                    <button
                      key={difficulty.name}
                      type="button"
                      onClick={() => {
                        setPracticeDifficultyName(difficulty.name);
                        startSession("practice", difficulty.name);
                      }}
                      className={`px-3 py-2 rounded border text-xs font-semibold ${
                        practiceDifficultyName === difficulty.name
                          ? "bg-blue-600 text-white border-blue-700"
                          : "bg-white text-slate-700 border-slate-300"
                      }`}
                    >
                      {difficulty.label}
                      <div className="mt-1 opacity-75">
                        Draw {difficulty.drawCount} · {difficulty.maxPasses}{" "}
                        redeals
                      </div>
                    </button>
                  ))}
                </div>
                <div className="text-xs text-slate-300">
                  Reward runs still use today&apos;s difficulty (
                  {todaysDifficulty.label}).
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    onClick={() => setShowPracticeDifficultyPrompt(false)}
                  >
                    CANCEL
                  </Button>
                </div>
              </div>
            </div>
          )}

          {startingRun && (
            <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-sm rounded border border-white/30 bg-slate-900 p-6 space-y-3 text-white text-center">
                <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-white" />
                <h3 className="text-lg font-bold">Starting your run…</h3>
                <p className="text-sm text-slate-300">
                  Opening a reward run on the server and dealing your board.
                  Hold tight — this only takes a moment.
                </p>
              </div>
            </div>
          )}

          {seedError && (
            <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
              <div className="w-full max-w-sm rounded border border-red-500/50 bg-slate-900 p-6 space-y-3 text-white text-center">
                <h3 className="text-lg font-bold text-red-400">
                  Couldn&apos;t start your run
                </h3>
                <p className="text-sm text-slate-300">
                  The server didn&apos;t send this run&apos;s seed, so we
                  stopped instead of starting a game that couldn&apos;t be
                  verified or paid out. Refresh the page and try again — if it
                  keeps happening, your connection may be dropping.
                </p>
                <button
                  onClick={() => window.location.reload()}
                  className="w-full px-6 py-2 bg-blue-600 text-white font-semibold rounded-lg hover:bg-blue-700 active:scale-95 transition-all"
                >
                  REFRESH THE PAGE
                </button>
              </div>
            </div>
          )}
        </div>
      </OuterPanel>
    );
  }

  const selectedCard =
    gameState.selected?.source === "waste"
      ? gameState.waste[gameState.waste.length - 1]
      : gameState.selected?.source === "tableau"
        ? gameState.tableau[gameState.selected.pileIndex]?.faceUp[
            gameState.selected.cardIndex
          ]
        : undefined;

  return (
    <OuterPanel className={solitairePanelClassName}>
      <InnerPanel className="w-full h-full p-3 md:p-4 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-white overflow-auto">
        {/* The card box, declared once. Every card face, back, stock and
            foundation reads it, so the pile overlaps above stay true. */}
        <div className="max-w-7xl mx-auto h-full flex flex-col gap-2 md:gap-3 [--card-w:44px] [--card-h:56px] md:[--card-w:56px] md:[--card-h:80px]">
          {/* Compressed on a phone for the same reason as Tetris': the five
              chips at `px-2 py-1 text-sm` wrapped to two 28px rows and the
              header alone was 100px of a 578px column. */}
          <div className="flex flex-wrap items-center justify-between gap-1 md:gap-2 text-sm">
            <div className="font-bold text-sm md:text-lg">
              SOLITAIRE - {activeDifficulty.label}
            </div>
            <div className="flex flex-wrap gap-1 md:gap-2 items-center">
              <span className="px-1 md:px-2 py-0 md:py-1 text-[10px] md:text-sm rounded bg-slate-700">
                Mode: {sessionMode}
              </span>
              <span className="px-1 md:px-2 py-0 md:py-1 text-[10px] md:text-sm rounded bg-slate-700">
                Moves: {gameState.moves}
              </span>
              <span className="px-1 md:px-2 py-0 md:py-1 text-[10px] md:text-sm rounded bg-slate-700">
                Foundation: {progressCount}/52
              </span>
              <span className="px-1 md:px-2 py-0 md:py-1 text-[10px] md:text-sm rounded bg-slate-700">
                Redeals: {gameState.passesRemaining}
              </span>
            </div>
          </div>

          {solved && (
            <div className="rounded border-2 border-green-400 bg-green-900/40 p-3 text-center">
              <div className="font-bold text-lg">Puzzle Solved!</div>
              <div className="text-sm mt-1">
                {sessionMode === "reward"
                  ? `Reward granted: ${SOLITAIRE_RAVEN_COIN_REWARD} RavenCoin.`
                  : "Practice complete."}
              </div>
            </div>
          )}

          {/* Stock, waste and the four foundations: **one** row of six from `md` up
              and on a phone too.

              ## Why the actions left this grid

              It was the seventh cell of a `grid-cols-2 md:grid-cols-7`, and on a
              phone that grid put Stock/Waste on row 1, two foundations on row 2,
              two on row 3 and the actions on row 4 — four rows, measured 502px,
              because each cell carried a card *and* a label *and*, in the
              actions cell, three stacked 50px buttons. Two thirds of that was the
              label text and the button chrome, not the game.

              Six slots across 320px is 44px each, which is exactly the 44px a
              thumb can be relied on to find, so the cards themselves do fit —
              they just have to be the only thing in the row. `md:` puts the
              actions back into the same grid as a seventh column, which is
              where they have always been on a desktop. */}
          <div className="grid grid-cols-6 md:grid-cols-7 gap-px md:gap-2 items-start">
            <div className="space-y-1">
              <div className="text-[9px] md:text-xs uppercase text-slate-300">
                Stock
              </div>
              <button
                type="button"
                onClick={drawFromStock}
                className="w-[var(--card-w)] h-[var(--card-h)] border border-white/40 rounded bg-slate-700 hover:bg-slate-600 grid place-items-center text-[10px] md:text-xs"
              >
                {gameState.stock.length > 0
                  ? `${gameState.stock.length}`
                  : gameState.passesRemaining > 0
                    ? "RESET"
                    : "EMPTY"}
              </button>
            </div>

            <div className="space-y-1">
              <div className="text-[9px] md:text-xs uppercase text-slate-300">
                Waste
              </div>
              {activeDifficulty.drawCount === 3 ? (
                /* The three-card fan is 92 x 80 today, which is wider than a
                   44px slot: at a 24px step it is 44 + 48 = 92 and would
                   overlap the foundation beside it. The step is a variable of
                   its own so it can shrink with the card rather than being a
                   second hard-coded pair of numbers. */
                <div
                  className="relative [--fan-step:0px] md:[--fan-step:32px]"
                  style={{
                    width: "calc(var(--card-w) + 2 * var(--fan-step))",
                    height: "var(--card-h)",
                  }}
                  onClick={selectWaste}
                >
                  {gameState.waste.length === 0
                    ? renderCardBack()
                    : (() => {
                        const visible = gameState.waste.slice(
                          Math.max(0, gameState.waste.length - 3),
                        );
                        return visible.map((card, i) => {
                          const isTop = i === visible.length - 1;
                          return (
                            <div
                              key={card.rank + card.suit}
                              className="absolute"
                              style={{
                                left: `calc(${i} * var(--fan-step))`,
                                top: 0,
                                pointerEvents: isTop ? "auto" : "none",
                                zIndex: i,
                              }}
                              onDoubleClick={
                                isTop ? () => smartMove("waste") : undefined
                              }
                            >
                              {renderCard(
                                card,
                                isTop && gameState.selected?.source === "waste",
                              )}
                            </div>
                          );
                        });
                      })()}
                </div>
              ) : (
                <div
                  onClick={selectWaste}
                  onDoubleClick={() => smartMove("waste")}
                >
                  {gameState.waste.length > 0
                    ? renderCard(
                        gameState.waste[gameState.waste.length - 1],
                        gameState.selected?.source === "waste",
                      )
                    : renderCardBack()}
                </div>
              )}
            </div>

            {SUITS.map((suit) => {
              const pile = gameState.foundations[suit];
              const top = pile[pile.length - 1];

              return (
                <div key={suit} className="space-y-1">
                  <div className="text-[9px] md:text-xs uppercase text-slate-300">
                    {suit}
                  </div>
                  <button
                    type="button"
                    onClick={() => moveSelectedToFoundation(suit)}
                    className="w-[var(--card-w)] h-[var(--card-h)] rounded border border-white/30 bg-slate-700/70 grid place-items-center"
                  >
                    {top ? (
                      <div>{renderCard(top)}</div>
                    ) : (
                      <SquareIcon icon={suitImages[suit]} width={9} />
                    )}
                  </button>
                </div>
              );
            })}

            {/* The desktop's copy of the three actions: the seventh column of
                this same grid, exactly where it has always been. The phone's row
                below is the other one — one element per breakpoint rather than
                two grids, so the buttons cannot drift apart. */}
            <div className="hidden md:block space-y-1">
              <div className="text-xs uppercase text-slate-300">Actions</div>
              <Button
                onClick={undoMove}
                disabled={undosRemaining === 0 || undoCount === 0}
              >
                Undo ({undosRemaining})
              </Button>
              <Button onClick={autoMoveToFoundation}>Auto Foundation</Button>
              {onClose && (
                <Button
                  onClick={() => {
                    if (solved) {
                      returnToMenu();
                      return;
                    }

                    setShowExitConfirm(true);
                  }}
                >
                  Exit
                </Button>
              )}
            </div>
          </div>

          {/* The three actions, as their own row on a phone and back inside the
              grid above from `md` up. `Button` renders `w-full` unless its
              className carries a width, so the phone row needs `flex-1 w-auto`
              to split the width three ways; `md:flex-none md:w-full` restores
              the stacked desktop column, because `flex-1` sets
              `flex-basis: 0%` and would otherwise beat `width` there too. */}
          <div className="flex flex-nowrap md:hidden gap-1.5">
            <Button
              onClick={undoMove}
              disabled={undosRemaining === 0 || undoCount === 0}
              className="flex-1 w-auto text-xs"
            >
              Undo ({undosRemaining})
            </Button>
            <Button
              onClick={autoMoveToFoundation}
              className="flex-1 w-auto text-xs"
            >
              Auto
            </Button>
            {onClose && (
              <Button
                onClick={() => {
                  if (solved) {
                    returnToMenu();
                    return;
                  }

                  setShowExitConfirm(true);
                }}
                className="flex-1 w-auto text-xs"
              >
                Exit
              </Button>
            )}
          </div>

          {/* The seven tableau piles.

              ## Why four across on a phone and not seven

              Seven piles across the 274px a 320px viewport leaves for content
              is 37px each, and the floor for a card a thumb can find is 44px —
              so a single row is not available at any card size that is legal to
              tap. `grid-cols-4` gives 64px columns for a 48px card and wraps
              into two rows of four and three, which is what every phone Klondike
              does.

              The cost is height: two pile rows at once. At 320x640 the whole
              column is 578px and the pile rows get ~330 of it between them,
              which is what sizes the reveal in the overlap constants above —
              13 cards (the most a Klondike pile can hold) at 10px of reveal is
              64 + 120 = 184px of stack in a 200px slot.

              From `lg` up this is the original `grid-cols-7`, one row, one
              280px min-height — the desktop is untouched. */}
          <div className="mt-0.5 md:mt-1 grid grid-cols-4 lg:grid-cols-7 gap-1 md:gap-2 flex-1 lg:flex-none min-h-0">
            {gameState.tableau.map((pile, pileIndex) => (
              <button
                type="button"
                key={`tableau-${pileIndex}`}
                onClick={() => moveSelectedToTableau(pileIndex)}
                className="min-h-[172px] md:min-h-[280px] rounded border border-slate-600 bg-slate-900/40 p-1 text-left flex flex-col"
              >
                <div className="text-[9px] md:text-[10px] uppercase text-slate-400 mb-0.5 md:mb-1">
                  Pile {pileIndex + 1}
                </div>
                <div className="flex flex-col items-center justify-start h-full">
                  {pile.faceDown.map((card, downIndex) => (
                    <div
                      key={`down-${card.suit}-${card.rank}-${downIndex}`}
                      className={downIndex > 0 ? FACE_DOWN_OVERLAP_CLASS : ""}
                    >
                      {renderCardBack()}
                    </div>
                  ))}
                  {pile.faceUp.map((card, upIndex) => {
                    const isSelectedFromPile =
                      gameState.selected?.source === "tableau" &&
                      gameState.selected.pileIndex === pileIndex &&
                      upIndex >= gameState.selected.cardIndex;
                    const isFirstFaceUpAfterFaceDown =
                      upIndex === 0 && pile.faceDown.length > 0;
                    const isRevealSpacingCard = upIndex === 1;

                    return (
                      <div
                        key={`up-${card.suit}-${card.rank}-${upIndex}`}
                        className={
                          isFirstFaceUpAfterFaceDown
                            ? FACE_UP_AFTER_FACE_DOWN_OVERLAP_CLASS
                            : isRevealSpacingCard
                              ? FACE_UP_TOP_CARD_OVERLAP_CLASS
                              : upIndex > 0
                                ? FACE_UP_STACK_OVERLAP_CLASS
                                : ""
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          handleTableauCardClick(pileIndex, upIndex);
                        }}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          smartMove({ pileIndex, cardIndex: upIndex });
                        }}
                      >
                        {renderCard(card, isSelectedFromPile)}
                      </div>
                    );
                  })}
                </div>
              </button>
            ))}
          </div>

          {/* One line on a phone, the full two-sentence version from `md` up. At
              `text-xs` across 274px the original wraps to three lines and eats
              48px of the vertical budget the pile rows need; what survives is
              the part that is not obvious from looking at it. */}
          <div className="text-[10px] md:text-xs text-slate-300 leading-tight">
            <span className="md:hidden">
              Tap a card, then a pile. Empty piles take Kings only.
            </span>
            <span className="hidden md:inline">
              Click a card to select it, then click a tableau pile or foundation
              to move. Empty tableau piles only accept Kings.
            </span>
            {selectedCard && (
              <span className="ml-2 text-yellow-300">
                Selected: {selectedCard.rank} of {selectedCard.suit}
              </span>
            )}
          </div>
        </div>

        {showExitConfirm && (
          <div className="fixed inset-0 z-30 bg-black/60 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded border border-white/30 bg-slate-900 p-4 space-y-4 text-white">
              <h3 className="text-lg font-bold">Exit Solitaire?</h3>
              <p className="text-sm text-slate-200">
                Are you sure you want to exit? Current progress will be lost.
              </p>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setShowExitConfirm(false)}>
                  CANCEL
                </Button>
                <Button
                  onClick={() => {
                    if (solved) {
                      returnToMenu();
                      return;
                    }

                    onClose?.();
                  }}
                >
                  EXIT
                </Button>
              </div>
            </div>
          </div>
        )}
      </InnerPanel>
    </OuterPanel>
  );
};
