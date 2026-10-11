/* eslint-disable react/jsx-no-literals */
import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSelector } from "../adapters/useSelector";
import { Button } from "components/ui/Button";
import { InnerPanel, OuterPanel } from "components/ui/Panel";
import {
  TouchButton,
  TouchAnalogStick,
  TouchOnly,
  useHeldKeys,
  useIsTouchDevice,
} from "components/ui/TouchControls";
import { useIsNarrowLayout } from "components/ui/useMediaQuery";
import { useVipAccess } from "../adapters/useVipAccess";
import { useRewardRun } from "../adapters/rewardRun";
import { PortalContext, PortalMachineState } from "../adapters/portal";
import { useBootstrap } from "lib/portal/BootstrapContext";
import type { VerifiedRun } from "lib/portal/api";
import { writeNonce, getEconomyWorkerUrl } from "lib/portal/api";
import { CHUNK_TICKS } from "@nightshade/shared/anticheat/replayBudget";
import { encodeInputLog, inputMask } from "@nightshade/shared/anticheat/inputLog";
import { NPCIcon } from "../adapters/NPCIcon";
import { NPC_WEARABLES } from "lib/npcs";
import { SUNNYSIDE } from "example-assets/sunnyside";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import {
  FIGHTERS,
  loadImage,
  loadSheets,
  FIGHTER_ANIMS,
  type FighterId,
  type FighterSpec,
  type Sheets,
} from "./fighters";
import {
  WAVES,
  WAVE_COUNT,
  ENEMY_SHEET_PLAN,
  enemyAnimsFor,
  getEnemySpec,
  getWaveSpec,
} from "./enemies";
import { PICKUP_ART } from "./pickups";
import { STAGE_H, STAGE_W, loadStage } from "./stage";
import {
  FIXED_STEP_MS,
  INPUT_BUFFER_MS,
  MAGIC_COST,
  MAGIC_MAX,
  MAX_LIVES,
  SPARK_KEY,
  createMatch,
  emptyInput,
  readHud,
  renderMatch,
  stepMatch,
  type HudSnapshot,
  type MatchState,
  type PlayerInput,
} from "./engine";
import {
  SUNFLOWER_BRAWLER_DIFFICULTIES,
  SUNFLOWER_BRAWLER_RAVEN_COIN_REWARD,
  getSunflowerBrawlerDifficulty,
  isSunflowerBrawlerRewardRunAvailable,
  type SunflowerBrawlerDifficulty,
  type SunflowerBrawlerMode,
} from "./session";

const _portalState = (state: PortalMachineState) => state.context.state;

/**
 * One milestone of a run, as the verifier reads it.
 *
 * Captured when a wave is **cleared** — the moment the engine has finished
 * scoring that wave (kills, the wave-clear bonus, and at wave 15 the finale
 * bonus, all applied before `finishWave` returns) but before the next fight
 * begins. That ordering is what makes `score` meaningful: each entry is the
 * highest score reachable at that point, so the worker can compare it against
 * the ceiling it computes from the same wave table.
 *
 * `wave` counts **waves cleared**, not the wave being fought — `hud.wave`
 * reports `waveIndex + 1`, which is one ahead of what has been completed, and
 * using it would make every checkpoint claim look one wave ahead of its score.
 */
type RunCheckpoint = {
  /** Ordinal index, 0-based, contiguous. */
  seq: number;
  /** Waves cleared when this checkpoint was taken. */
  wave: number;
  /** Cumulative score at this checkpoint. */
  score: number;
  /** Player health, 0..maxHp. */
  hp: number;
  /** Magic meter, 0..MAGIC_MAX. */
  magic: number;
  /** Lives remaining. */
  lives: number;
  /** Elapsed run time in ms at this checkpoint. */
  ms: number;
};

/**
 * Keys this cabinet owns.
 *
 * Captured on the way *down* so arrow keys never scroll the page under a
 * fighter mid-run — the Tetris pattern, and the reason the on-screen pad can
 * dispatch the very same codes and be handled by the very same listener.
 *
 * Two buttons only: `Space` swings and `KeyX` casts. The fighting game's
 * `KeyZ`/`KeyC` went with its ranged/smash system.
 */
const INTERCEPTED_CODES = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Space",
  "KeyX",
]);

/** Sprite height for the lobby portraits. */
const PORTRAIT_H = 68;

/**
 * Portrait height bounds, in pixels.
 *
 * The portrait is the only genuinely elastic part of the lobby: the panels around
 * it are text of a known size, so whatever height the flexbox leaves the portrait
 * box is exactly what the character can be drawn at. {@link NPCIcon} takes a pixel
 * height rather than a CSS length because it sizes a canvas backing store, so the
 * number has to come from JS — hence the bounds.
 *
 * `MIN` is where a champion stops reading as a character and starts reading as a
 * smudge; below it the card would rather clip than show nonsense. `MAX` is the
 * size the lobby is designed around, so a tall window gets generous portraits
 * rather than portraits marooned in whitespace.
 */
const PORTRAIT_MIN_H = 40;
const PORTRAIT_MAX_H = 96;

/**
 * How many waves the finite run has, shown on the wave counter.
 *
 * Derived rather than hard-coded, and deliberately **not** the ceiling of the
 * counter: past this the run is endless and the number keeps climbing. Reading
 * it as `WAVES.length` would cap the HUD at 15 while the game let a player reach
 * wave 40, which makes the deepest part of a run look like the shallowest.
 */
const WAVE_TOTAL = WAVE_COUNT;

// ── Small pieces ─────────────────────────────────────────────────────────────

const HealthBar: React.FC<{
  hp: number;
  maxHp: number;
  color: string;
}> = ({ hp, maxHp, color }) => {
  const pct = Math.max(0, Math.min(100, (hp / maxHp) * 100));
  // The bar drains through amber into red, so a champion on its last sliver is
  // readable without a number next to it.
  const fill = pct <= 25 ? "#ef4444" : pct <= 50 ? "#f59e0b" : color;

  return (
    <div className="h-3.5 w-full overflow-hidden rounded border-2 border-black/50 bg-slate-800">
      <div
        className="h-full transition-[width] duration-150 ease-out"
        style={{ width: `${pct}%`, background: fill }}
      />
    </div>
  );
};

/**
 * Lives left.
 *
 * Filled dots for the lives still in hand, hollow ones behind them, so the
 * counter reads as a *pool* rather than a number that ticked down.
 */
const LifePips: React.FC<{ lives: number; color: string }> = ({
  lives,
  color,
}) => (
  <div className="flex gap-1">
    {Array.from({ length: MAX_LIVES }, (_, index) => (
      <span
        key={index}
        className="h-2.5 w-2.5 rounded-full border border-black/50"
        style={{
          background: index < lives ? color : "transparent",
          opacity: index < lives ? 1 : 0.35,
        }}
      />
    ))}
  </div>
);

/**
 * The magic meter.
 *
 * Ticks every ten points rather than filling smoothly: the player needs to
 * know *whether they can cast*, not how close they are, and a segmented bar
 * answers that at a glance. The cast is exactly two segments.
 */
const MagicBar: React.FC<{ magic: number }> = ({ magic }) => {
  const segments = MAGIC_MAX / 10;
  const filled = Math.floor(magic / 10);
  const ready = magic >= MAGIC_COST;

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`text-[10px] font-bold leading-none ${
          ready ? "text-purple-300" : "text-slate-500"
        }`}
      >
        MAGIC
      </span>
      <div className="flex gap-0.5">
        {Array.from({ length: segments }, (_, index) => (
          <span
            key={index}
            className="h-3 w-2 rounded-[1px] border border-black/50"
            style={{
              background:
                index < filled ? (ready ? "#c084fc" : "#7c5cbf") : "#1e293b",
            }}
          />
        ))}
      </div>
    </div>
  );
};

/** The boss's bar, full width, because it is the only enemy with a name. */
const BossBar: React.FC<{ boss: NonNullable<HudSnapshot["boss"]> }> = ({
  boss,
}) => {
  const pct = Math.max(0, Math.min(100, (boss.hp / boss.maxHp) * 100));

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-black tracking-wide text-emerald-300">
          {boss.name}
        </span>
        <span className="text-[11px] tabular-nums text-emerald-200/70">
          {boss.hp}/{boss.maxHp}
        </span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded border-2 border-black/60 bg-slate-900">
        <div
          className="h-full transition-[width] duration-150 ease-out"
          style={{
            width: `${pct}%`,
            background: pct <= 25 ? "#ef4444" : boss.color,
          }}
        />
      </div>
    </div>
  );
};

const FighterCard: React.FC<{
  fighter: FighterSpec;
  selected: boolean;
  onSelect: () => void;
}> = ({ fighter, selected, onSelect }) => {
  const combo = fighter.moves;

  /**
   * Draw the portrait at whatever height the layout left over.
   *
   * The lobby is a fixed-height flex column with no scrolling, so the champion
   * panel is the one section allowed to absorb the difference between a tall
   * window and a short one. Flexbox decides how much room that is; this reads the
   * resulting box back and hands the number to {@link NPCIcon}, which needs pixels
   * for its canvas. Measuring the element rather than computing the number from
   * the other panels' text means the portrait cannot drift out of sync with the
   * layout — there is nothing to keep in step.
   */
  const portraitRef = useRef<HTMLDivElement>(null);
  const [portraitH, setPortraitH] = useState(PORTRAIT_H);

  useEffect(() => {
    const el = portraitRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height;
      if (!height) return;
      setPortraitH(
        Math.round(
          Math.max(PORTRAIT_MIN_H, Math.min(PORTRAIT_MAX_H, height)),
        ),
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex min-h-0 flex-col justify-center rounded-lg border-2 p-2 text-left transition-all ${
        selected
          ? "border-amber-400 bg-amber-100 shadow-lg"
          : "border-slate-300 bg-white hover:border-slate-400"
      }`}
    >
      <div
        ref={portraitRef}
        className="flex min-h-0 flex-1 items-end justify-center"
        // Capped at the same {@link PORTRAIT_MAX_H} the measurement clamps to, so
        // the box and the character inside it cannot disagree. Without a cap the
        // box grows to fill a tall window and the character sits marooned at the
        // bottom of it; with one, a tall window centres a full-size portrait and a
        // short one shrinks it.
        style={{ maxHeight: PORTRAIT_MAX_H }}
      >
        <NPCIcon
          parts={NPC_WEARABLES[fighter.npc as keyof typeof NPC_WEARABLES]}
          height={portraitH}
          animation="idle"
        />
      </div>
      {/* Text below the portrait is `shrink-0` so the elastic portrait gives up
          space rather than the stats being squeezed out of legibility. */}
      <div className="mt-1 shrink-0 text-center text-sm font-bold">
        {fighter.name}
      </div>
      <div className="shrink-0 text-center text-[11px] text-slate-500">
        {fighter.faction}
      </div>
      <div className="mt-1 grid shrink-0 gap-0.5 text-[11px]">
        <div className="flex justify-between">
          <span className="text-slate-500">HP</span>
          <span className="font-bold" style={{ color: fighter.color }}>
            {fighter.maxHp}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">SPEED</span>
          <span className="font-bold">{fighter.walkSpeed}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">COMBO</span>
          <span className="font-bold">
            {combo.combo1.damage}·{combo.combo2.damage}·{combo.combo3.damage}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">SPELL</span>
          <span className="font-bold text-purple-500">
            {combo.magic.damage}
          </span>
        </div>
      </div>
    </button>
  );
};

// ── Cabinet ──────────────────────────────────────────────────────────────────

export const SunflowerBrawlerGame: React.FC<{ onClose?: () => void }> = ({
  onClose,
}) => {
  const { portalService } = useContext(PortalContext);
  const portalGameState = useSelector(portalService, _portalState);
  const isVip = useVipAccess({ game: portalGameState });
  const bootstrap = useBootstrap();

  const hasRewardRun = useMemo(
    () => isSunflowerBrawlerRewardRunAvailable({ game: portalGameState, isVip }),
    [portalGameState, isVip],
  );

  const todaysDifficulty = useMemo(() => getSunflowerBrawlerDifficulty(), []);

  const [mode, setMode] = useState<SunflowerBrawlerMode | null>(null);
  const [activeDifficulty, setActiveDifficulty] =
    useState<SunflowerBrawlerDifficulty>(todaysDifficulty);
  const [showPracticeDifficultyPrompt, setShowPracticeDifficultyPrompt] =
    useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  /**
   * The champion the run will actually use — the **committed** choice.
   *
   * Kept separate from {@link draftPlayerId} because the narrow layout picks a
   * champion in a sheet with Confirm and Cancel. Tapping a card there is not a
   * choice, it is a *proposal*: Cancel has to leave the lobby exactly as it was,
   * which is only possible if the taps so far went somewhere other than here.
   */
  const [playerId, setPlayerId] = useState<FighterId>("barlow");
  /** The proposed champion, live only while the sheet is open. */
  const [draftPlayerId, setDraftPlayerId] = useState<FighterId>("barlow");
  const [championSheetOpen, setChampionSheetOpen] = useState(false);
  const [hud, setHud] = useState<HudSnapshot | null>(null);

  /**
   * Narrow layout: the champion cards collapse to a name and a button.
   *
   * On a phone the four cards were the whole budget. Two rows of cards plus their
   * portrait, name, faction and four stat lines is ~270px of a ~640px lobby, and
   * it is the section that gets squeezed — the cards ended up with a portrait at
   * its 40px floor and stats pushed out of the card entirely. So on narrow screens
   * the cards move into a sheet and the menu keeps only the champion's **name**,
   * which is all the menu ever needed to say. It is the difference between a
   * character select you can read and one you cannot.
   *
   * Desktop keeps the cards inline: there is room, and the sheet would be a worse
   * experience than simply picking a card.
   */
  const isNarrowLayout = useIsNarrowLayout();

  /** Open the sheet, seeded with the committed choice so Cancel is a true no-op. */
  const openChampionSheet = useCallback(() => {
    setDraftPlayerId(playerId);
    setChampionSheetOpen(true);
  }, [playerId]);

  /** Confirm: the proposal becomes the choice. */
  const confirmChampion = useCallback(() => {
    setPlayerId(draftPlayerId);
    setChampionSheetOpen(false);
  }, [draftPlayerId]);

  /** Cancel: discard the proposal. `playerId` is never touched. */
  const cancelChampion = useCallback(() => setChampionSheetOpen(false), []);

  const inputRef = useRef<PlayerInput>(emptyInput());
  const matchRef = useRef<MatchState | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLCanvasElement | null>(null);
  const sheetsRef = useRef<Record<string, Sheets>>({});
  const imagesRef = useRef<Record<string, HTMLImageElement>>({});
  const hudVersionRef = useRef(0);
  const rewardGrantedRef = useRef(false);

  /**
   * Anti-cheat: the run's milestone log.
   *
   * One entry per wave cleared, captured from the live match the instant
   * `waveIndex` advances — wave reached, score, health, magic, lives and the
   * elapsed run time. On claim these go to the worker's `claim-verified`
   * intent, which re-derives what a legitimate run could have scored at each of
   * those waves and refuses anything unreachable. See
   * `shared/anticheat/verify.js` for the exact invariants.
   *
   * Kept in a ref rather than state: this is written sixty times a second from
   * the render loop and must never trigger a React render — only the count
   * matters, and only at the moment of the claim.
   */
  const checkpointsRef = useRef<RunCheckpoint[]>([]);
  /** `waveIndex` at the last capture, so a wave is logged exactly once. */
  const loggedWaveRef = useRef(0);
  /**
   * The claim, frozen at the instant the finale was cleared.
   *
   * The run does not stop there — it goes on into endless, and the loop keeps
   * running — but the *claim* is over the moment wave 15 falls. Reading the
   * live array or the live match at payout time would instead describe
   * something else: waves 16+ appended to a log the verifier rightly refuses as
   * out of range, or a restarted match whose clock has nothing to do with the
   * run being claimed. Freezing here means the player is paid for the run they
   * finished, whether or not they keep playing after it.
   */
  const frozenClaimRef = useRef<VerifiedRun | null>(null);
  /** `worldMs` when the run opened, so the claim can report its duration. */
  const runStartedAtRef = useRef(0);
  /**
   * Per-tick input log for shadow replay (Stage B).
   *
   * One byte per simulated tick: bit0 left, bit1 right, bit2 up, bit3 down,
   * bit4 attack, bit5 magic. Recorded *before* each `stepMatch`, because that
   * is the input as the simulation is about to consume it — `drain` zeroes the
   * buffers mid-step, so sampling afterwards would lose the press.
   *
   * A full byte per tick rather than the 6 bits it strictly needs: this is ~11 KB
   * for a three-minute run, and packing would save about 8 KB of that. Not worth
   * a shift-and-mask routine whose off-by-one would silently desync every replay.
   */
  const inputLogRef = useRef<number[]>([]);
  /** The seed behind `inputLogRef`, so the claim carries what replay must use. */
  const runSeedRef = useRef(0);

  /**
   * The champion and difficulty the current run was opened with.
   *
   * Frozen into the replay payload for the same reason the seed is: replay is a
   * pure function of (seed, playerId, difficulty, inputs), and two of those four
   * are chosen in the lobby rather than read off the match. Stashed here rather
   * than read from state at claim time because the lobby can be open behind a
   * running match — a player who finishes a run, opens the champion picker and
   * then sees the claim fire would otherwise have their proof rebuilt against a
   * fighter they never played.
   */
  const runConfigRef = useRef<{ playerId: FighterId; difficulty: string }>({
    playerId: "barlow",
    difficulty: "medium",
  });

  /**
   * Unique key for this run, generated at start. Binds the streamed chunks
   * together so the worker can resume the same replay across requests.
   */
  const runKeyRef = useRef(0);

  /**
   * Which chunk we're sending next (0, 1, 2...). Each chunk is CHUNK_TICKS
   * of inputs. Incremented at each wave clear.
   */
  const chunkIndexRef = useRef(0);

  const held = useHeldKeys();
  const isTouchDevice = useIsTouchDevice();

  const playerSpec = FIGHTERS.find((f) => f.id === playerId) ?? FIGHTERS[0];

  const rewardRun = useRewardRun({
    game: portalGameState,
    minigame: "sunflower-brawler",
    isVip,
    portalService,
    startRewardRun: () => startSession("reward"),
  });

  // ── Assets ─────────────────────────────────────────────────────────────────

  // The stage and the non-sheet sprites are needed by any run, so they are
  // fetched once on mount. The two that are *not* sheets — the impact spark
  // and the pickup art — are loaded here because a drop can appear the instant
  // a first enemy dies, and a mis-sized icon is not worth a race.
  useEffect(() => {
    let cancelled = false;

    loadStage().then((stage) => {
      if (!cancelled) stageRef.current = stage;
    });

    const sources = [
      SUNNYSIDE.icons.expression_attack,
      ...Object.values(PICKUP_ART),
    ];

    for (const src of sources) {
      loadImage(src).then((image) => {
        if (cancelled) return;
        imagesRef.current = { ...imagesRef.current, [src]: image };
        if (src === SUNNYSIDE.icons.expression_attack) {
          imagesRef.current = { ...imagesRef.current, [SPARK_KEY]: image };
        }
      });
    }

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Fetch the sheets a set of NPCs needs, skipping any already held.
   *
   * `anims` is **per NPC**, not one list for the batch: an enemy character's
   * cycles come from `enemyAnimsFor(npc)`, which reads that character's own
   * moves. A shared list was the bug behind seven NPCs drawing a coloured box
   * through every attack — a move named a cycle (`hammering`, `casting`,
   * `mining`) that the shared list never asked for, the image was simply absent,
   * and `renderMatch` fell back to its placeholder body. Deriving the set from
   * the moves makes that unwritable, and it is cheaper besides: a goblin no
   * longer fetches a spellcasting cycle it will never play.
   */
  const ensureSheets = useCallback(
    (npcs: readonly string[], animsFor: (npc: string) => readonly string[]) => {
      for (const npc of npcs) {
        if (sheetsRef.current[npc]) continue;
        // Fire and forget: `renderMatch` falls back to a real sheet rather than a
        // placeholder while one is in flight, so a slow CDN degrades to a pose
        // that is nearly right instead of a coloured rectangle.
        void loadSheets(npc, animsFor(npc)).then((sheets) => {
          sheetsRef.current = { ...sheetsRef.current, [npc]: sheets };
        });
      }
    },
    [],
  );

  /**
   * Say so if a character can name a cycle that will never be loaded.
   *
   * `enemyAnimsFor` makes this impossible for enemies by construction, so this
   * is the belt to that braces: it also covers the champion, whose moves are
   * checked against `FIGHTER_ANIMS` rather than derived. Cheap, dev-only, and it
   * names the exact NPC and cycle rather than leaving a coloured box to be
   * diagnosed from a screenshot.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const console_ = globalThis.console as
      | { warn?: (...args: unknown[]) => void }
      | undefined;

    for (const { npc, anims } of ENEMY_SHEET_PLAN) {
      for (const anim of anims) {
        if (!FIGHTER_ANIMS.includes(anim)) {
          console_?.warn?.(
            `[brawler] "${npc}" needs the "${anim}" cycle, which is not a known animation.`,
          );
        }
      }
    }
    for (const fighter of FIGHTERS) {
      for (const [name, mv] of Object.entries(fighter.moves)) {
        if (!mv || typeof mv !== "object" || !("anim" in mv)) continue;
        if (!FIGHTER_ANIMS.includes(mv.anim)) {
          console_?.warn?.(
            `[brawler] ${fighter.name}.${name} needs the "${mv.anim}" cycle, which will not be loaded.`,
          );
        }
      }
    }
  }, []);

  // ── Session ────────────────────────────────────────────────────────────────

  const startSession = useCallback(
    (
      nextMode: SunflowerBrawlerMode,
      difficultyName?: SunflowerBrawlerDifficulty["name"],
    ) => {
      const runDifficulty =
        nextMode === "reward"
          ? todaysDifficulty
          : (SUNFLOWER_BRAWLER_DIFFICULTIES.find(
              (entry) => entry.name === difficultyName,
            ) ?? todaysDifficulty);

      const input = inputRef.current;
      input.left = false;
      input.right = false;
      input.up = false;
      input.down = false;
      input.attackBuf = 0;
      input.magicBuf = 0;
      held.releaseAll();

      // Chosen before the match exists so the same value can be stored for the
      // claim; see the comment on `createMatch` for why it is client-side for
      // now and what has to change before replay is enforced.
      const seed = (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0;

      matchRef.current = createMatch({
        playerId,
        difficulty: runDifficulty,
        input,
        // Per-run seed for the simulation RNG.
        //
        // Deliberately chosen *here* rather than inside the engine, so the
        // engine never reads a clock during a tick — replay has to be a pure
        // function of (seed, inputs), and a wall-clock read inside the step
        // loop would make the same inputs replay to a different outcome.
        //
        // `Date.now()` supplies variety between runs; the random half stops the
        // seed being guessable from the clock alone.
        //
        // TEMPORARY — this is a **client-chosen** seed. It is reproducible
        // (which is all Stage A and B need) but it is not *binding*: a client
        // that picked its own seed could shop for a favourable one. That is
        // harmless while replay only records a match rate, because a mismatch
        // changes nothing. It stops being harmless the moment a mismatch
        // refuses payout (Stage C) — at which point the worker must issue the
        // seed at run-open and the client must use that instead.
        seed,
      });
      hudVersionRef.current = 0;
      setHud(readHud(matchRef.current));
      rewardGrantedRef.current = false;

      // A fresh run starts a fresh log. Carrying checkpoints across runs would
      // let a second attempt inherit the first one's progress, which is exactly
      // the forgery the verifier exists to reject.
      checkpointsRef.current = [];
      loggedWaveRef.current = 0;
      frozenClaimRef.current = null;
      // The input log is per-run for the same reason, and for a second one: a
      // log carried over would be replayed against a match it never drove.
      inputLogRef.current = [];
      runSeedRef.current = seed;
      runConfigRef.current = {
        playerId,
        difficulty: runDifficulty.name,
      };
      // Streaming verification: new run key, reset chunk counter.
      runKeyRef.current = Date.now() + Math.floor(Math.random() * 10000);
      chunkIndexRef.current = 0;

      ensureSheets([playerSpec.npc], () => FIGHTER_ANIMS);
      // Wave one's enemies are asked for immediately; the intro banner buys
      // their load time, and the walk between waves buys every later wave's.
      const opening = WAVES[0];
      if (opening) {
        ensureSheets(
          opening.spawns
            .map((spawn) => getEnemySpec(spawn.id).npc)
            .filter((npc): npc is string => npc !== null),
          enemyAnimsFor,
        );
      }

      setActiveDifficulty(runDifficulty);
      setShowPracticeDifficultyPrompt(false);
      setShowExitConfirm(false);
      setMode(nextMode);

      if (nextMode === "reward") {
        portalService.send({
          type: "arcadeMinigame.started",
          name: "sunflower-brawler",
        });
      }
    },
    [ensureSheets, held, playerId, playerSpec.npc, portalService, todaysDifficulty],
  );

  const returnToMenu = useCallback(() => {
    matchRef.current = null;
    hudVersionRef.current = 0;
    setHud(null);
    setShowExitConfirm(false);
    setMode(null);
  }, []);

  // ── Input ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mode) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (!INTERCEPTED_CODES.has(event.code)) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const input = inputRef.current;
      switch (event.code) {
        case "ArrowLeft":
          input.left = true;
          break;
        case "ArrowRight":
          input.right = true;
          break;
        case "ArrowUp":
          input.up = true;
          break;
        case "ArrowDown":
          input.down = true;
          break;
        case "Space":
          if (!event.repeat) input.attackBuf = INPUT_BUFFER_MS;
          break;
        case "KeyX":
          if (!event.repeat) input.magicBuf = INPUT_BUFFER_MS;
          break;
        default:
          break;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!INTERCEPTED_CODES.has(event.code)) return;
      const input = inputRef.current;
      if (event.code === "ArrowLeft") input.left = false;
      if (event.code === "ArrowRight") input.right = false;
      if (event.code === "ArrowUp") input.up = false;
      if (event.code === "ArrowDown") input.down = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      inputRef.current.left = false;
      inputRef.current.right = false;
      inputRef.current.up = false;
      inputRef.current.down = false;
    };
  }, [mode]);

  // ── Loop ───────────────────────────────────────────────────────────────────

  /**
   * The fixed-timestep loop.
   *
   * ## Why fixed
   *
   * The loop used to hand `stepMatch` whatever the browser reported — 16.67ms
   * on a healthy frame, 33ms on a stutter, whatever the tab gave it after
   * being backgrounded. That float sequence is part of the simulation's state:
   * enemy AI timers, combo windows and hitstop all integrate against it, so two
   * machines running the same inputs arrive at different scores.
   *
   * Certification needs the opposite. The worker re-derives what a run *could*
   * have scored, and a score that varies with the player's frame rate cannot be
   * bounded by a single number without either rejecting honest play on a slow
   * phone or setting the bound so loose it stops catching anything. Stepping in
   * fixed slices makes the simulation's progress a function of *simulated* time
   * alone, and `match.worldMs` — the value the checkpoints are stamped with —
   * advances identically everywhere.
   *
   * Real time is accumulated rather than discarded, so a slow machine still
   * keeps pace with the clock; it just takes more, smaller steps to do it. The
   * clamp keeps a backgrounded tab from rejoining with a delta large enough to
   * skip a whole wave in one step.
   */
  useEffect(() => {
    if (!mode) return;

    let raf = 0;
    let last = performance.now();
    let accumulator = 0;

    /**
     * Send the next chunk of inputs for streaming verification.
     *
     * Called at each wave clear. The worker verifies CHUNK_TICKS of inputs
     * and parks the replay. The final claim will only need to verify the
     * last chunk, so the player never waits at the win screen.
     */
    const sendVerificationChunk = useCallback(
      async (chunkIndex: number, isFinal: boolean) => {
        if (!bootstrap.jwt) return;
        const start = chunkIndex * CHUNK_TICKS;
        const end = isFinal ? inputLogRef.current.length : Math.min(start + CHUNK_TICKS, inputLogRef.current.length);
        if (start >= end) return; // nothing new to send
        const chunkInputs = inputLogRef.current.slice(start, end);
        if (chunkInputs.length === 0) return;

        try {
          await fetch(getEconomyWorkerUrl() + "/economy/write", {
            method: "POST",
            headers: {
              "content-type": "application/json;charset=UTF-8",
              accept: "application/json",
              Authorization: `Bearer ${bootstrap.jwt}`,
            },
            body: JSON.stringify({
              intent: "verify-chunk",
              nonce: writeNonce(),
              runKey: runKeyRef.current,
              chunkIndex,
              inputs: encodeInputLog(Uint8Array.from(chunkInputs)),
              // First chunk needs the full context; later chunks don't.
              ...(chunkIndex === 0
                ? {
                    seed: runSeedRef.current,
                    playerId: runConfigRef.current.playerId,
                    difficulty: runConfigRef.current.difficulty,
                    cabinet: "sunflower-brawler",
                  }
                : {}),
            }),
          });
        } catch {
          // Fire-and-forget: a failed chunk only delays the verdict, doesn't break the claim.
        }
      },
      [bootstrap.jwt],
    );

    /**
     * Log a checkpoint for every wave cleared since the last one, and freeze
     * the claim the moment the finale falls.
     *
     * Runs *after* the steps, against the settled match, so the score recorded
     * already contains that wave's clear bonus (and, at wave 15, the finale
     * bonus) — the engine applies both before `finishWave` returns.
     *
     * The loop rather than a single comparison because `waveIndex` can advance
     * more than once across a long catch-up: skipping one would leave a gap in
     * `seq`, and the verifier refuses a log with a gap in it.
     *
     * ## Why it stops at the finale
     *
     * Past wave 15 the run is endless and `waveIndex` keeps climbing, but the
     * claim is already complete — the coin pays on clearing the *finite* run.
     * Recording further would append waves the verifier rejects as out of
     * range, so a player who fought well into endless would be refused for
     * their own diligence. Capture and freeze together, so what is sent is
     * exactly the fifteen waves the claim is about.
     */
    const captureCheckpoints = (match: MatchState) => {
      if (frozenClaimRef.current) return;

      while (match.waveIndex > loggedWaveRef.current) {
        loggedWaveRef.current = match.waveIndex;
        checkpointsRef.current.push({
          seq: checkpointsRef.current.length,
          wave: match.waveIndex,
          score: match.score,
          hp: match.player.hp,
          magic: match.magic,
          lives: match.lives,
          ms: Math.round(match.worldMs),
        });

        // Stream a verification chunk at each wave clear (except the finale,
        // which is handled by the claim itself).
        if (match.waveIndex < WAVE_TOTAL) {
          void sendVerificationChunk(chunkIndexRef.current, false);
          chunkIndexRef.current += 1;
        }

        // The finale is wave `WAVE_COUNT`; clearing it is the win. Freeze the
        // whole claim here, in the same breath as the log that just completed,
        // so the score, the log and the duration are all read from one settled
        // state of the match rather than from a later frame.
        if (match.waveIndex >= WAVE_TOTAL) {
          // Send the final chunk (whatever remains) before freezing.
          void sendVerificationChunk(chunkIndexRef.current, true);

          frozenClaimRef.current = {
            cabinet: "sunflower-brawler",
            score: match.score,
            checkpoints: checkpointsRef.current.slice(),
            elapsedMs: Math.round(match.worldMs),
            // Frozen with the rest of the claim, from the same settled state.
            // The whole log belongs to it: the push happens *before* each step
            // and stops the moment this freeze lands, while the freeze is
            // observed only after the frame's last step — so the number of
            // logged inputs is exactly the number of steps that produced this
            // `score` and `worldMs`. Truncating to "the last tick that mattered"
            // would be a guess, and a wrong one: replaying one tick short lands
            // before the finale bonus and mismatches every honest run.
            replay: {
              seed: runSeedRef.current,
              playerId: runConfigRef.current.playerId,
              difficulty: runConfigRef.current.difficulty,
              ticks: inputLogRef.current.length,
              inputs: encodeInputLog(Uint8Array.from(inputLogRef.current)),
            },
          };
        }
      }
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const real = now - last;
      last = now;

      const match = matchRef.current;
      if (!match) return;

      accumulator += Math.min(real, 250);
      while (accumulator >= FIXED_STEP_MS) {
        // Before the step, not after: `stepMatch` drains the attack and magic
        // buffers, so sampling the input post-step would log the press as
        // already spent and the replay would never see it.
        //
        // Stopped once the claim has frozen. The run goes on into endless, and
        // nothing past the finale belongs to the claim — keeping a log of it
        // would be a steadily growing buffer that no replay will ever read.
        if (!frozenClaimRef.current) {
          inputLogRef.current.push(inputMask(match.playerInput));
        }
        stepMatch(match, FIXED_STEP_MS);
        accumulator -= FIXED_STEP_MS;
      }

      captureCheckpoints(match);

      const ctx = canvasRef.current?.getContext("2d");
      if (ctx) {
        renderMatch(ctx, match, sheetsRef.current, imagesRef.current, stageRef.current);
      }

      // The engine only bumps `hudVersion` when something the player can see
      // has changed, so the HUD re-renders a handful of times a second rather
      // than sixty.
      if (match.hudVersion !== hudVersionRef.current) {
        hudVersionRef.current = match.hudVersion;
        setHud(readHud(match));
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [mode]);

  // ── Wave preload ───────────────────────────────────────────────────────────

  // `hud.wave` flips the moment a wave is *finished*, which is to say at the
  // start of the walk that follows it — so the whole walk is the load window
  // for the wave at the end of it. The opening wave is asked for separately
  // in `startSession`, because `hud.wave` starts at 1 with nothing cached.
  // The wave being walked *towards*, which is one ahead of the wave just cleared
  // — so this is the load window for the wave at the end of the current walk.
  // `getWaveSpec` rather than an array index because past wave 15 the run is
  // endless and indexes into `WAVES` would run off the end.
  const upcoming = hud?.wave ?? 1;
  useEffect(() => {
    if (!mode) return;
    const spec = getWaveSpec(upcoming - 1);
    if (!spec) return;
    ensureSheets(
      spec.spawns.map((spawn) => getEnemySpec(spawn.id).npc),
      enemyAnimsFor,
    );

    // An ambush is fought *during* the walk that leads into this wave, and the
    // engine draws its pool from the same wave spec — so this one request
    // covers both, and a mid-walk encounter never opens on a fallback pose.
    //
    // One wave ahead is all it takes. Endless replays every wave, so `upcoming` is
    // always one of the fifteen and its NPCs are either already cached or
    // requested here — there is no index past the end of `WAVES` to guard
    // against, which is why `getWaveSpec` is safe to call directly.
  }, [ensureSheets, mode, upcoming]);

  // ── Payout ─────────────────────────────────────────────────────────────────

  // Keyed on `reachedFinale`, **not** on `result === "victory"`.
  //
  // The run no longer ends at wave 15 — it goes into endless — so there is no
  // terminal victory state to pay on. `reachedFinale` latches the moment the
  // finale is cleared and stays true, which is what makes this correct in both
  // directions: a player who quits during endless has still earned the coin,
  // and one who dies on wave 19 does not lose it for playing well. Lives are the
  // game's difficulty curve; the ending is not.
  useEffect(() => {
    if (
      !hud?.reachedFinale ||
      mode !== "reward" ||
      rewardGrantedRef.current
    ) {
      return;
    }

    rewardGrantedRef.current = true;

    // The coin is paid on proof, not on assertion. `frozenClaimRef` holds the
    // run's milestone log, score and duration, captured and closed the instant
    // the finale fell — before endless could append waves the verifier would
    // reject as out of range, and before a restart could swap the match out
    // from under it.
    //
    // Absent means the finale was reached without the log completing, which
    // cannot happen while the loop is running. It is still checked, because
    // claiming with an empty log would burn the voucher for nothing — and the
    // voucher is the player's ticket, not ours to spend.
    const claim = frozenClaimRef.current;
    if (!claim) {
      rewardGrantedRef.current = false;
      return;
    }

    portalService.send({
      type: "arcadeMinigame.ravenCoinWon",
      amount: SUNFLOWER_BRAWLER_RAVEN_COIN_REWARD,
      verify: claim,
    });
  }, [hud, mode, portalService]);

  const handleInGameExit = useCallback(() => {
    if (hud?.result) {
      returnToMenu();
      return;
    }
    setShowExitConfirm(true);
  }, [hud, returnToMenu]);

  // ── Lobby ──────────────────────────────────────────────────────────────────

  if (!mode) {
    return (
      <OuterPanel className="mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden">
        {/* A fixed-height flex column that never scrolls.
            `min-h-0` on the one flexible child is what makes that work: without it
            a flex item refuses to shrink below its content, so the column would
            overflow and the page would scroll — which is exactly what this
            replaces. The champion panel absorbs the difference between a tall
            window and a short one, up to a cap; past that the column centres
            itself rather than stretching four cards around a small character. */}
        <div className="flex h-full flex-col justify-center gap-2 overflow-hidden p-3">
          <div className="shrink-0 text-center">
            <h2 className="text-2xl sm:text-3xl font-bold">
              SUNFLOWER BRAWLER
            </h2>
          </div>

          <InnerPanel className="shrink-0 bg-amber-50 p-3">
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <div className="text-sm text-gray-700 font-semibold">REWARD</div>
                <div className="flex items-center justify-center gap-1 text-2xl font-bold text-amber-800">
                  {SUNFLOWER_BRAWLER_RAVEN_COIN_REWARD}
                  <img
                    src={ravenCoinIcon}
                    alt="RavenCoin"
                    className="h-6 w-6"
                  />
                </div>
                <div className="text-[10px] font-medium text-gray-500">
                  {/* The panel says the *when*, because it is the part a player
                      cannot work out: the run continues past wave 15, so
                      "finish it" is not an instruction anyone can follow. */}
                  for clearing wave 15
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">TODAY</div>
                <div className="text-2xl font-bold text-amber-800">
                  {todaysDifficulty.label}
                </div>
              </div>
              <div>
                <div className="text-sm text-gray-700 font-semibold">WAVES</div>
                <div className="text-2xl font-bold text-amber-800">
                  {WAVE_TOTAL}
                </div>
              </div>
            </div>
          </InnerPanel>

          {/* ── Champion ──────────────────────────────────────────────────────
              Narrow: one line — the chosen champion's name and a button. Wide:
              the cards, inline. The cards themselves are rendered once, by
              whichever branch is live, because the narrow branch needs them in a
              sheet with its own Confirm/Cancel and CSS cannot move a subtree. */}
          {isNarrowLayout ? (
            <InnerPanel className="flex shrink-0 items-center justify-between gap-3 bg-slate-50 p-3">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-slate-500">
                  CHAMPION
                </div>
                {/* Black for every champion, not `playerSpec.color`. The tint is
                    right on a *card* — it sits on white beside a portrait of that
                    character, so it reads as identity. As bare text on this panel
                    it is close to invisible: measured against the painted
                    background the four tints score **1.25, 1.15, 1.27 and 1.01**
                    to one, Reginald's `#ff9b54` being almost exactly the panel's
                    own colour. Black scores 10:1 on all four. Legible first,
                    tinted second — and the tint still carries the identity on the
                    card, the HP figure and the health bar. */}
                <div className="truncate text-base font-bold text-black">
                  {playerSpec.name}
                </div>
              </div>
              <button
                type="button"
                onClick={openChampionSheet}
                className="shrink-0 rounded-lg border-2 border-amber-400 bg-amber-100 px-4 py-2 text-sm font-bold text-slate-900 active:scale-95"
              >
                CHANGE
              </button>
            </InnerPanel>
          ) : (
            <>
              {/* The one elastic section: it grows into spare room on a tall
                  window and gives it back on a short one, so the panels below it —
                  controls and the buttons that start a run — never leave the
                  screen. Capped, because past the cap the column centres itself
                  rather than stretching four cards around a small character.

                  The rows are `minmax(min-content, 1fr)`, not `minmax(0, 1fr)`:
                  a card must never be shorter than the stats inside it. */}
              <InnerPanel className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-50 p-3 max-h-[280px]">
                <div className="mb-2 shrink-0 text-sm font-semibold">
                  CHOOSE YOUR CHAMPION
                </div>
                <div className="grid min-h-0 flex-1 grid-cols-4 grid-rows-[minmax(min-content,1fr)] gap-2">
                  {FIGHTERS.map((fighter) => (
                    <FighterCard
                      key={fighter.id}
                      fighter={fighter}
                      selected={fighter.id === playerId}
                      onSelect={() => setPlayerId(fighter.id)}
                    />
                  ))}
                </div>
              </InnerPanel>
            </>
          )}

          <InnerPanel className="shrink-0 bg-slate-50 p-3 text-sm text-slate-700">
            <div className="font-semibold">Controls</div>
            {/* Titles read down the left, descriptions down the right — a
                definition list, so the eye pairs each label with its own text
                instead of hunting across two independent columns. */}
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="font-semibold">MOVE</dt>
              <dd>
                Arrow keys, or the on-screen pad. ← → walk along the street,{" "}
                <b>↑ ↓ step into and out of the plane</b>.
              </dd>
              <dt className="font-semibold">ATTACK</dt>
              <dd>
                <b>Space</b> — a three-hit combo. Press again within the window
                for the next swing; the finisher is slower, reaches further and
                throws much harder.
              </dd>
              <dt className="font-semibold">MAGIC</dt>
              <dd>
                <b>X</b> — spends 50 magic on a blast that hits <b>every</b>{" "}
                enemy on screen, whatever line they are on. The meter fills as you
                deal damage.
              </dd>
            </dl>
            {isTouchDevice && (
              <div className="mt-2 text-xs text-slate-500">
                Touch: the pad moves in all four directions, ATTACK and MAGIC
                are on the right.
              </div>
            )}
          </InnerPanel>

          {/* Side by side rather than stacked. Two full-width buttons were the
              single largest block of fixed height in the lobby — about 130px of a
              400px non-negotiable budget — and there is 1100px of width to spend on
              them. Side by side the pair costs half, which is what buys the
              champion portraits their height on a short window. They stack again
              below `sm`, where the width is needed for the two-line subtitles. */}
          <div className="grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={rewardRun.start}
              disabled={!hasRewardRun}
              className={`w-full rounded-lg px-4 py-3 text-base font-bold transition-all shadow-lg ${
                hasRewardRun
                  ? "bg-green-500 text-white hover:bg-green-600 active:scale-95"
                  : "cursor-not-allowed bg-gray-300 text-gray-500"
              }`}
            >
              <div>START REWARD RUN</div>
              <div className="mt-1 text-xs opacity-90">
                {!hasRewardRun
                  ? "No reward runs left today — buy Play Tickets in the shop."
                  : rewardRun.freeAvailable
                    ? isVip
                      ? "VIP: reward run available for Sunflower Brawler today."
                      : "Reward run available for the arcade today."
                    : `Uses 1 Play Ticket (you have ${rewardRun.tickets}).`}
              </div>
            </button>

            <button
              type="button"
              onClick={() => setShowPracticeDifficultyPrompt(true)}
              className="w-full rounded-lg bg-blue-500 px-4 py-3 text-base font-bold text-white transition-all shadow-lg hover:bg-blue-600 active:scale-95"
            >
              <div>START PRACTICE MODE</div>
              <div className="mt-1 text-xs font-semibold opacity-90">
                Play without spending today&apos;s reward attempt.
              </div>
            </button>
          </div>

          {/* Overlaid rather than stacked. The "are you sure?" box appears *after*
              a click, and in flow its ~180px would push the buttons it is asking
              about off a short screen — the lobby has no scrollbar to rescue it.
              Absolutely positioning it inside a zero-height wrapper means the
              layout is identical whether or not it is showing. It covers EXIT
              while open, which is what a confirmation should do; its own CLOSE
              brings the lobby back. */}
          {rewardRun.dialog && (
            <div className="relative shrink-0">
              <div className="absolute inset-x-0 bottom-0 z-10">
                {rewardRun.dialog}
              </div>
            </div>
          )}

          {rewardRun.error && (
            <p className="shrink-0 text-center text-xs font-semibold text-red-600">
              {rewardRun.error}
            </p>
          )}

          {onClose && (
            <button
              type="button"
              onClick={() => onClose()}
              className="w-full shrink-0 rounded-lg bg-gray-400 px-6 py-2 font-semibold text-white transition-all hover:bg-gray-500 active:scale-95"
            >
              EXIT
            </button>
          )}

          {/* ── Champion sheet (narrow layout only) ─────────────────────────
              A modal *does* scroll, unlike the menu behind it — that rule exists
              so the menu is always whole, and a sheet the player opened on purpose
              is a different thing entirely. `max-h` plus `overflow-y-auto` means a
              short phone gets a scrollable sheet instead of a clipped one.

              Tapping a card only moves `draftPlayerId`. CONFIRM copies it into
              `playerId`; CANCEL closes and leaves the committed choice alone, which
              is why they are two pieces of state rather than one. */}
          {isNarrowLayout && championSheetOpen && (
            <div
              className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-3"
              onKeyDown={(event) => {
                if (event.key === "Escape") cancelChampion();
              }}
            >
              {/* `text-white` is on the heading, not the panel. `FighterCard` is a
                  light card that inherits its text colour, so a `text-white`
                  ancestor makes the champion's name white-on-white — invisible.
                  The grid sets `text-slate-900` explicitly so the cards read
                  correctly whatever an ancestor does. */}
              <div className="flex max-h-[92vh] w-full max-w-md flex-col gap-3 overflow-y-auto rounded border border-white/30 bg-slate-900 p-4">
                <h3 className="shrink-0 text-lg font-bold text-white">
                  Choose Your Champion
                </h3>
                {/* `flex-1` plus declared rows, for the same reason the lobby's
                    grid needs them: the portrait measures its own box with a
                    ResizeObserver, so the box has to be given real height by the
                    layout. In an auto-height grid `flex-1` collapses to zero and
                    every portrait renders at its 40px floor — which would look
                    worst in the one place the player opened specifically to look
                    at the characters. Both rows are declared because four
                    champions across two columns make two, and an implicit row is
                    sized `auto`. */}
                <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-[minmax(min-content,1fr)_minmax(min-content,1fr)] gap-2 text-slate-900">
                  {FIGHTERS.map((fighter) => (
                    <FighterCard
                      key={fighter.id}
                      fighter={fighter}
                      selected={fighter.id === draftPlayerId}
                      onSelect={() => setDraftPlayerId(fighter.id)}
                    />
                  ))}
                </div>
                {/* CANCEL left, CONFIRM right: the primary action sits under the
                    thumb that reached for it. */}
                <div className="grid shrink-0 grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={cancelChampion}
                    className="rounded-lg bg-gray-500 px-4 py-3 text-sm font-bold text-white active:scale-95"
                  >
                    CANCEL
                  </button>
                  <button
                    type="button"
                    onClick={confirmChampion}
                    className="rounded-lg bg-green-500 px-4 py-3 text-sm font-bold text-white active:scale-95"
                  >
                    CONFIRM
                  </button>
                </div>
              </div>
            </div>
          )}

          {showPracticeDifficultyPrompt && (
            <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60 p-4">
              <div className="w-full max-w-md space-y-4 rounded border border-white/30 bg-slate-900 p-4 text-white">
                <h3 className="text-lg font-bold">Select Practice Difficulty</h3>
                <p className="text-sm text-slate-200">
                  Reward runs still use today&apos;s difficulty (
                  {todaysDifficulty.label}).
                </p>
                <div className="space-y-2">
                  {SUNFLOWER_BRAWLER_DIFFICULTIES.map((difficulty) => (
                    <button
                      key={difficulty.name}
                      type="button"
                      onClick={() =>
                        startSession("practice", difficulty.name)
                      }
                      className="w-full rounded-lg bg-slate-700 px-4 py-3 text-sm font-bold text-slate-200 transition-all hover:bg-slate-600"
                    >
                      {difficulty.label} — {difficulty.reactionMs}ms ·{" "}
                      {difficulty.maxAttackers === 1
                        ? "1 attacker"
                        : `${difficulty.maxAttackers} attackers`}{" "}
                      at once
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setShowPracticeDifficultyPrompt(false)}
                  className="w-full rounded-lg bg-gray-500 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-400"
                >
                  CANCEL
                </button>
              </div>
            </div>
          )}
        </div>
      </OuterPanel>
    );
  }

  // ── Run ────────────────────────────────────────────────────────────────────

  const snapshot = hud;
  const banner = snapshot?.banner ?? null;
  const result = snapshot?.result ?? null;
  const magicReady = (snapshot?.magic ?? 0) >= MAGIC_COST;

  return (
    <OuterPanel className="mx-auto w-full max-w-[1100px] h-[min(95vh,900px)] overflow-hidden">
      {/*
        `select-none` across the whole play screen, not just the control legend:
        a long press on a phone starts selecting whatever text is under the
        finger, and during a fight that is the HUD — champion name, wave counter,
        score — with a copy/callout menu over the stage. The player needs nothing
        on this screen to be selectable, and doing it at the root means a label
        added later cannot reintroduce it.
      */}
      {/*
        `select-none` across the whole play screen, not just the control legend:
        a long press on a phone starts selecting whatever text is under the
        finger, and during a fight that is the HUD — champion name, wave counter,
        score — with a copy/callout menu over the stage. The player needs nothing
        on this screen to be selectable, and doing it at the root means a label
        added later cannot reintroduce it.

        Narrow goes **edge to edge with no padding and no scrolling**: the stage is
        the point of the screen and it should own all of it. The controls overlay
        it rather than sitting below it, which is what buys the height back — see
        the wrapper around the stage.
      */}
      <div className="flex h-full select-none flex-col gap-2 overflow-hidden p-0 sm:overflow-y-auto sm:p-4">
        {/* ── HUD ─────────────────────────────────────────────────────────── */}
        {/* Padding here rather than on the container, because the container is
            edge to edge on narrow and the HUD still needs to breathe. */}
        <div className="flex shrink-0 items-start gap-3 px-3 pt-3 sm:px-0 sm:pt-0">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span
                className="truncate text-sm font-bold"
                style={{ color: playerSpec.color }}
              >
                {playerSpec.name}
              </span>
              <span className="text-xs tabular-nums text-gray-600">
                {snapshot?.hp ?? playerSpec.maxHp}/
                {snapshot?.maxHp ?? playerSpec.maxHp}
              </span>
            </div>
            <HealthBar
              hp={snapshot?.hp ?? playerSpec.maxHp}
              maxHp={snapshot?.maxHp ?? playerSpec.maxHp}
              color={playerSpec.color}
            />
            <div className="mt-1 flex items-center gap-2">
              <LifePips
                lives={snapshot?.lives ?? MAX_LIVES}
                color={playerSpec.color}
              />
              <span className="text-[10px] font-semibold text-gray-500">
                LIVES
              </span>
            </div>
          </div>

          <div className="shrink-0 text-center">
            <div className="text-[10px] font-semibold text-gray-500">
              {activeDifficulty.label.toUpperCase()} ·{" "}
              {/*
                The counter stops meaning anything past the finite run, so it
                changes shape rather than showing "WAVE 23/15". Showing the
                loop number instead makes the position legible at a glance,
                which is the whole job of this line.
              */}
              {snapshot?.endless
                ? `ENDLESS ${Math.floor((snapshot.wave - 1) / WAVE_TOTAL)} · WAVE ${snapshot.wave}`
                : `WAVE ${snapshot?.wave ?? 1}/${WAVE_TOTAL}`}
            </div>
            <div className="text-sm font-black text-amber-800">
              {snapshot?.waveName ?? WAVES[0]?.name ?? ""}
            </div>
            <div className="text-[10px] font-semibold text-gray-500">
              {snapshot
                ? snapshot.roamers > 0
                  ? `AMBUSH — ${snapshot.roamers} LEFT`
                  : snapshot.phase === "walking"
                    ? "ON THE STREET"
                    : `${snapshot.enemiesLeft} LEFT`
                : ""}
            </div>
          </div>

          <div className="min-w-0 flex-1 text-right">
            <div className="text-sm font-black tabular-nums text-amber-700">
              {snapshot?.score ?? 0}
            </div>
            <div className="mb-1 text-[10px] font-semibold text-gray-500">
              SCORE
            </div>
            <div className="flex justify-end">
              <MagicBar magic={snapshot?.magic ?? 0} />
            </div>
            <div
              className={`mt-0.5 text-[10px] font-bold ${
                magicReady ? "text-purple-600" : "text-gray-400"
              }`}
            >
              X {magicReady ? "SPELL READY" : `+${MAGIC_COST} MAGIC`}
            </div>
          </div>
        </div>

        {snapshot?.boss && (
          <div className="px-2">
            <BossBar boss={snapshot.boss} />
          </div>
        )}

        {/* ── Stage ───────────────────────────────────────────────────────── */}
        {/*
          The wrapper exists so the controls can **overlay** the stage on narrow
          screens while still sitting below it on wide ones. One set of markup,
          positioned by `absolute` → `sm:static`.

          That is what buys the height. The stage is 960×540 — 16:9 landscape —
          and the play slot on a portrait phone is tall and narrow, so `contain`
          letterboxed the stage down to a 343×191 band and left ~164px of black
          above and below it, inside a black-bordered box. Overlaying the controls
          means they no longer subtract from the slot, so the slot becomes the
          whole area under the HUD; the 16:9 band then centres in *that*, and in
          portrait the controls come to rest on the letterbox area rather than on
          the street.

          Nothing is cropped. `cover` would fill the box completely but scales to
          923px wide to do it, showing only the middle third of the street — and
          in a side-scroller, where enemies walk in from off-screen, that is
          exactly the wrong thing to lose.
        */}
        <div className="relative flex min-h-0 flex-1 flex-col sm:gap-2">
          <div
            className="relative flex min-h-0 flex-1 items-stretch justify-center overflow-hidden sm:min-h-[180px] sm:rounded sm:border-2 sm:border-amber-900/50"
            // Nothing is cropped, so a portrait phone still has vertical slack
            // around a 16:9 stage. Left as `black` that slack reads as *broken* —
            // two bars the player never asked for. So on narrow the slot is
            // painted with the stage's own colours continuing past the canvas:
            // night sky above, grass below, meeting the bitmap exactly at its
            // top and bottom edges (the stage's horizon sits at 46% of its
            // height, and the canvas centres at 36–64% of the slot). The slack
            // then reads as a taller camera rather than as letterboxing.
            style={
              isNarrowLayout
                ? {
                    background:
                      "linear-gradient(to bottom, #0d0b22 0%, #12102c 36%, #4a8a40 64%, #3d7534 100%)",
                  }
                : { backgroundColor: "#000000" }
            }
          >
          <canvas
            ref={canvasRef}
            width={STAGE_W}
            height={STAGE_H}
            className="block h-full w-full"
            style={{ imageRendering: "pixelated", objectFit: "contain" }}
          />

          {banner && !result && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <div className="rounded border-2 border-black/60 bg-black/55 px-6 py-3 text-center">
                <div className="text-3xl font-black tracking-widest text-amber-300">
                  {banner.title}
                </div>
                <div className="text-xs font-semibold tracking-wide text-white/85">
                  {banner.subtitle}
                </div>
              </div>
            </div>
          )}

          {result && snapshot && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-4">
              <div className="w-full max-w-sm space-y-3 rounded border-2 border-amber-400/60 bg-slate-900 p-4 text-center text-white">
                <div className="text-3xl font-black">GAME OVER</div>
                {/*
                  One sentence, and it has to carry three cases without being
                  vague about any of them: cleared the finite run, died in
                  endless, or never got there. `reachedFinale` distinguishes
                  "finished the game" from "finished a run", which is not the
                  same thing now that the run continues forever.
                */}
                <div className="text-sm text-slate-300">
                  {snapshot.reachedFinale
                    ? `The street is cleared. You went on to wave ${snapshot.bestWave}.`
                    : snapshot.endless
                      ? `Endless ${snapshot.wave}. You never reached the end of the street.`
                      : `You fell on wave ${snapshot.bestWave} of ${WAVE_TOTAL}.`}
                </div>
                {/*
                  Shown whenever the finale was cleared, not only when the run
                  ended in victory — which, now that endless exists, it never
                  does. A reward run that reaches wave 15 has earned the coin
                  whether the player stopped there or pushed on, and the panel
                  has to say so or the payout looks like a mistake.
                */}
                {mode === "reward" && snapshot.reachedFinale && (
                  <div className="flex items-center justify-center gap-1 text-sm font-bold text-amber-300">
                    +{SUNFLOWER_BRAWLER_RAVEN_COIN_REWARD}
                    <img src={ravenCoinIcon} alt="" className="h-5 w-5" />
                  </div>
                )}
                <div className="text-lg font-bold tabular-nums text-amber-300">
                  {snapshot.score} POINTS
                </div>
                <Button
                  onClick={() => {
                    // Restart is practice-only. A reward run is paid for once
                    // (`rewardGrantedRef`), but `startSession` resets that
                    // one-shot guard and re-sends `arcadeMinigame.started` —
                    // so a second run in the same attempt could be won, paid
                    // for again, and counted as a second ticket. The run is
                    // over; another one has to be bought.
                    if (mode === "practice")
                      startSession("practice", activeDifficulty.name);
                    else returnToMenu();
                  }}
                >
                  {mode === "practice" ? "RUN IT AGAIN" : "BACK TO ROSTER"}
                </Button>
                {mode === "practice" && (
                  <button
                    type="button"
                    onClick={returnToMenu}
                    className="w-full rounded bg-slate-600 px-4 py-2 text-sm font-semibold hover:bg-slate-500"
                  >
                    BACK TO ROSTER
                  </button>
                )}
              </div>
            </div>
          )}

          {showExitConfirm && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 p-4">
              <div className="w-full max-w-xs space-y-3 rounded border border-white/30 bg-slate-900 p-4 text-center text-white">
                <p className="text-sm">Leave the run? The waves are forfeit.</p>
                <button
                  type="button"
                  onClick={returnToMenu}
                  className="w-full rounded bg-red-500 px-4 py-2 text-sm font-bold hover:bg-red-600"
                >
                  LEAVE
                </button>
                <button
                  type="button"
                  onClick={() => setShowExitConfirm(false)}
                  className="w-full rounded bg-slate-600 px-4 py-2 text-sm font-semibold hover:bg-slate-500"
                >
                  KEEP FIGHTING
                </button>
              </div>
            </div>
          )}
          </div>

          {/* Narrow only: EXIT floats over the stage's top corner. In flow it
              would take a full row of the screen the stage is now trying to own,
              and it would sit underneath the overlaid controls. */}
          {onClose && (
            <button
              type="button"
              onClick={handleInGameExit}
              className="absolute right-2 top-2 z-10 rounded bg-slate-800/80 px-3 py-1.5 text-xs font-bold text-amber-100 active:scale-95 sm:hidden"
            >
              EXIT
            </button>
          )}

          {/* ── Controls ──────────────────────────────────────────────────
              Overlaid on narrow, in flow from `sm` up. An analog stick and two
              buttons, matching the arcade floor: the stick replaces a d-pad here
              because a d-pad is four separate buttons and a thumb can only hold
              one, so there was no way to walk *and* step into the plane together
              — the most important move in the game. The stick reads two axes at
              once and gets diagonals for free. */}
          <TouchOnly>
            <div className="absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-3 p-2 sm:static sm:p-0">
              <TouchAnalogStick held={held} />
            {/* Both buttons render identically, so ATTACK's label is the same
                amber as MAGIC's. `tone="accent"` was the outlier and it was also
                broken: `CONTROL_CLASS` hard-codes `bg-slate-800/90`, and the
                accent tone's background loses to it on Tailwind source order
                while its `text-slate-900` wins — so ATTACK came out as dark text
                on a dark background, and the ✦ was barely visible. Dropping the
                tone fixes the contrast by making the two buttons match, which is
                also what reads better side by side at thumb size. */}
            <div className="grid flex-1 grid-cols-2 gap-2 self-end">
              <TouchButton
                held={held}
                code="Space"
                label={
                  <span className="flex flex-col items-center leading-tight">
                    <span className="text-base">✦</span>
                    <span className="text-[10px]">ATTACK</span>
                  </span>
                }
                className="h-14"
              />
              <TouchButton
                held={held}
                code="KeyX"
                label={
                  <span
                    className="flex flex-col items-center leading-tight"
                    style={{ color: magicReady ? "#c084fc" : undefined }}
                  >
                    <span className="text-base">✧</span>
                    <span className="text-[10px]">MAGIC</span>
                  </span>
                }
                className="h-14"
              />
            </div>
          </div>
          </TouchOnly>

          {/*
            Desktop only. The legend is a keyboard reference, and on narrow the
            controls are on screen and labelled — a row of text about keys the
            player cannot press is not worth the height it takes from the stage,
            nor the finger-drag text selection it invites mid-fight.
          */}
          <div className="hidden shrink-0 touch-none select-none items-center justify-between gap-3 px-2 text-[11px] text-gray-500 sm:flex">
            <span>
              ← → walk · ↑ ↓ step the plane · Space attack (3-hit combo) · X
              magic
            </span>
            <div className="flex gap-2">
              <Button onClick={handleInGameExit}>Exit</Button>
            </div>
          </div>
        </div>
      </div>
    </OuterPanel>
  );
};
