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
  TouchDPad,
  TouchOnly,
  useHeldKeys,
  useIsTouchDevice,
} from "components/ui/TouchControls";
import { useVipAccess } from "../adapters/useVipAccess";
import { useRewardRun } from "../adapters/rewardRun";
import { PortalContext, PortalMachineState } from "../adapters/portal";
import { NPCIcon } from "../adapters/NPCIcon";
import { NPC_WEARABLES } from "lib/npcs";
import { SUNNYSIDE } from "example-assets/sunnyside";
import ravenCoinIcon from "../../assets/RavenCoin.webp";
import {
  FIGHTERS,
  loadImage,
  loadSheets,
  FIGHTER_ANIMS,
  ENEMY_ANIMS,
  type FighterId,
  type FighterSpec,
  type Sheets,
} from "./fighters";
import { WAVES, bigGoblinSrc, getEnemySpec } from "./enemies";
import { STAGE_H, STAGE_W, loadStage } from "./stage";
import {
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
 * How many screens the run has, shown on the wave counter.
 *
 * Derived rather than hard-coded: the level in `stage.ts` is sized from
 * `WAVES.length`, so if a wave is ever added the HUD follows without a second
 * edit.
 */
const WAVE_TOTAL = WAVES.length;

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

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-lg border-2 p-2 text-left transition-all ${
        selected
          ? "border-amber-400 bg-amber-100 shadow-lg"
          : "border-slate-300 bg-white hover:border-slate-400"
      }`}
    >
      <div style={{ height: PORTRAIT_H }} className="flex items-end justify-center">
        <NPCIcon
          parts={NPC_WEARABLES[fighter.npc as keyof typeof NPC_WEARABLES]}
          height={PORTRAIT_H}
          animation="idle"
        />
      </div>
      <div className="mt-1 text-center text-sm font-bold">{fighter.name}</div>
      <div className="text-center text-[11px] text-slate-500">
        {fighter.faction}
      </div>
      <div className="mt-1 grid gap-0.5 text-[11px]">
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
          <span className="text-slate-500">STRING</span>
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
  const [playerId, setPlayerId] = useState<FighterId>("barlow");
  const [hud, setHud] = useState<HudSnapshot | null>(null);

  const inputRef = useRef<PlayerInput>(emptyInput());
  const matchRef = useRef<MatchState | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLCanvasElement | null>(null);
  const sheetsRef = useRef<Record<string, Sheets>>({});
  const imagesRef = useRef<Record<string, HTMLImageElement>>({});
  const hudVersionRef = useRef(0);
  const rewardGrantedRef = useRef(false);

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
  // and the boss strip — are loaded here because the boss can appear with no
  // warning if a wave is ever reordered, and a 1.4 KB PNG is not worth a
  // race.
  useEffect(() => {
    let cancelled = false;

    loadStage().then((stage) => {
      if (!cancelled) stageRef.current = stage;
    });

    for (const src of [SUNNYSIDE.icons.expression_attack, bigGoblinSrc]) {
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

  const ensureSheets = useCallback(
    (npcs: readonly string[], anims: readonly string[]) => {
      for (const npc of npcs) {
        if (sheetsRef.current[npc]) continue;
        // Fire and forget: `renderMatch` draws a named coloured body for any
        // actor whose sheet is still in flight, so a slow CDN degrades to a
        // placeholder rather than to a hole.
        void loadSheets(npc, anims).then((sheets) => {
          sheetsRef.current = { ...sheetsRef.current, [npc]: sheets };
        });
      }
    },
    [],
  );

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

      matchRef.current = createMatch({
        playerId,
        difficulty: runDifficulty,
        input,
      });
      hudVersionRef.current = 0;
      setHud(readHud(matchRef.current));
      rewardGrantedRef.current = false;

      ensureSheets([playerSpec.npc], FIGHTER_ANIMS);
      // Wave one's enemies are asked for immediately; the intro banner buys
      // their load time, and the walk between waves buys every later wave's.
      const opening = WAVES[0];
      if (opening) {
        ensureSheets(
          opening.spawns
            .map((spawn) => getEnemySpec(spawn.id).npc)
            .filter((npc): npc is string => npc !== null),
          ENEMY_ANIMS,
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

  useEffect(() => {
    if (!mode) return;

    let raf = 0;
    let last = performance.now();

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = now - last;
      last = now;

      const match = matchRef.current;
      if (!match) return;

      stepMatch(match, dt);

      const ctx = canvasRef.current?.getContext("2d");
      if (ctx) {
        const bossImage = imagesRef.current[bigGoblinSrc] ?? null;
        renderMatch(
          ctx,
          match,
          sheetsRef.current,
          imagesRef.current,
          stageRef.current,
          bossImage,
        );
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
  const wave = hud?.wave ?? 1;
  useEffect(() => {
    if (!mode) return;
    const spec = WAVES[wave - 1];
    if (!spec) return;
    ensureSheets(
      spec.spawns
        .map((spawn) => getEnemySpec(spawn.id).npc)
        .filter((npc): npc is string => npc !== null),
      ENEMY_ANIMS,
    );
  }, [ensureSheets, mode, wave]);

  // ── Payout ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (
      !hud ||
      hud.result !== "victory" ||
      mode !== "reward" ||
      rewardGrantedRef.current
    ) {
      return;
    }

    rewardGrantedRef.current = true;
    portalService.send({
      type: "arcadeMinigame.ravenCoinWon",
      amount: SUNFLOWER_BRAWLER_RAVEN_COIN_REWARD,
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
        <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
          <div className="text-center space-y-1">
            <h2 className="text-3xl sm:text-4xl font-bold">
              SUNFLOWER BRAWLER
            </h2>
            <p className="text-sm text-gray-600">
              A side-scrolling street fight: five waves, a scrolling level, and
              the Big Goblin at the end of it.
            </p>
          </div>

          <InnerPanel className="bg-amber-50 p-4">
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

          <InnerPanel className="bg-slate-50 p-3">
            <div className="mb-2 text-sm font-semibold">CHOOSE YOUR CHAMPION</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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

          <InnerPanel className="bg-slate-50 p-3 text-sm text-slate-700">
            <div className="font-semibold">Controls</div>
            <div className="mt-1 grid gap-1 sm:grid-cols-2">
              <div className="flex gap-2">
                <span className="w-24 font-semibold">MOVE</span>
                <span>
                  Arrow keys, or the on-screen pad. ← → walk along the street,{" "}
                  <b>↑ ↓ step into and out of the plane</b>.
                </span>
              </div>
              <div className="flex gap-2">
                <span className="w-24 font-semibold">ATTACK</span>
                <span>
                  <b>Space</b> — a three-hit string. Press again within the
                  window for the next swing; the finisher is slower, reaches
                  further and throws much harder.
                </span>
              </div>
              <div className="flex gap-2">
                <span className="w-24 font-semibold">MAGIC</span>
                <span>
                  <b>X</b> — spends 50 magic on a blast that hits{" "}
                  <b>every</b> enemy on screen, whatever line they are on. The
                  meter fills as you deal damage.
                </span>
              </div>
              <div className="flex gap-2">
                <span className="w-24 font-semibold">DODGE</span>
                <span>
                  There is no jump and no block — <b>stepping off the line</b>{" "}
                  is the dodge. A swing is a horizontal band across the plane.
                </span>
              </div>
            </div>
            <div className="mt-2 text-xs text-slate-500">
              {MAX_LIVES} lives cover the whole run — five waves, and one Big
              Goblin at the end of them.
            </div>
            {isTouchDevice && (
              <div className="mt-1 text-xs text-slate-500">
                Touch: the pad moves in all four directions, ATTACK and MAGIC
                are on the right.
              </div>
            )}
          </InnerPanel>

          <button
            type="button"
            onClick={rewardRun.start}
            disabled={!hasRewardRun}
            className={`w-full rounded-lg px-6 py-4 text-lg font-bold transition-all shadow-lg ${
              hasRewardRun
                ? "bg-green-500 text-white hover:bg-green-600 active:scale-95"
                : "cursor-not-allowed bg-gray-300 text-gray-500"
            }`}
          >
            <div>START REWARD RUN</div>
            <div className="mt-2 text-xs opacity-90">
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
            className="w-full rounded-lg bg-blue-500 px-6 py-4 text-lg font-bold text-white transition-all shadow-lg hover:bg-blue-600 active:scale-95"
          >
            <div>START PRACTICE MODE</div>
            <div className="mt-2 text-xs font-semibold opacity-90">
              Play without spending today&apos;s reward attempt.
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
              type="button"
              onClick={() => onClose()}
              className="w-full rounded-lg bg-gray-400 px-6 py-2 font-semibold text-white transition-all hover:bg-gray-500 active:scale-95"
            >
              EXIT
            </button>
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
      <div className="flex h-full flex-col gap-2 overflow-y-auto p-4">
        {/* ── HUD ─────────────────────────────────────────────────────────── */}
        <div className="flex items-start gap-3">
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
              {activeDifficulty.label.toUpperCase()} · WAVE{" "}
              {snapshot?.wave ?? 1}/{WAVE_TOTAL}
            </div>
            <div className="text-sm font-black text-amber-800">
              {snapshot?.waveName ?? WAVES[0]?.name ?? ""}
            </div>
            <div className="text-[10px] font-semibold text-gray-500">
              {snapshot ? `${snapshot.enemiesLeft} LEFT` : ""}
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
          The slot owns the layout and the canvas just fills it. `FitStage` caps
          its scale at 1×, so the stage could only ever be 640×360 CSS px and a
          desktop cabinet ended up with a stamp in the middle of a 1100px panel.
          Letting the canvas stretch the slot and `object-fit` the bitmap gets
          the same aspect-correct, pixel-crisp letterbox on every screen — on a
          phone the slot is whatever height is left under the HUD, on a desktop
          it is whatever height is left under the HUD *and* is 1100px wide.
        */}
        <div className="relative flex min-h-[180px] flex-1 items-stretch justify-center overflow-hidden rounded border-2 border-amber-900/50 bg-black">
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
                <div className="text-3xl font-black">
                  {result === "victory" ? "STREET CLEARED" : "GAME OVER"}
                </div>
                <div className="text-sm text-slate-300">
                  {result === "victory"
                    ? "The Big Goblin is down."
                    : `You fell on wave ${snapshot.wave} of ${WAVE_TOTAL}.`}
                </div>
                <div className="text-lg font-bold tabular-nums text-amber-300">
                  {snapshot.score} POINTS
                </div>
                {mode === "reward" && result === "victory" && (
                  <div className="flex items-center justify-center gap-1 text-sm font-bold text-amber-300">
                    +{SUNFLOWER_BRAWLER_RAVEN_COIN_REWARD}
                    <img src={ravenCoinIcon} alt="" className="h-5 w-5" />
                  </div>
                )}
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

        {/* ── Controls ────────────────────────────────────────────────────── */}
        {/*
          Four directions and two buttons. The pad's `down` is what walks the
          champion *out* of the plane, which is the move the whole game is
          built around — leaving it off the pad would have left touch players
          with no way to dodge.
        */}
        <TouchOnly>
          <div className="flex items-end justify-between gap-3">
            <TouchDPad
              held={held}
              directions={["up", "down", "left", "right"]}
              className="shrink-0"
            />
            <div className="grid flex-1 grid-cols-2 gap-2 self-end">
              <TouchButton
                held={held}
                code="Space"
                tone="accent"
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

        <div className="flex items-center justify-between gap-3 text-[11px] text-gray-500">
          <span>
            ← → walk · ↑ ↓ step the plane · Space attack (3-hit string) · X
            magic
          </span>
          <div className="flex gap-2">
            <Button onClick={handleInGameExit}>Exit</Button>
          </div>
        </div>
      </div>
    </OuterPanel>
  );
};
