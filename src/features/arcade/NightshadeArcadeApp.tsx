import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "components/ui/Modal";
import { getGameEntry, GAME_REGISTRY } from "./games/registry";
import { NightshadeArcadePhaser } from "./NightshadeArcadePhaser";
import { minigamesEventEmitter } from "./lib/minigamesEvents";
import { nightshadeArcadeEvents } from "./lib/nightshadeArcadeEvents";
import { useMinigameSession, useVipAccess } from "lib/portal";
import { MmoRoomProvider, useMmoBumpkinJoin } from "lib/mmo";
import { submitScore } from "lib/portal/api";
import { getMinigamesApiUrl } from "lib/portal/url";
import { getNightshadeArcadeSpawn } from "./lib/spawns";
import { chestStreak } from "./lib/chestStreak";
import {
  chestTallyConfigured,
  fetchChestTally,
  recordChestTicket,
  type ChestTally,
} from "./lib/chestApi";
import {
  classifyChestClaimRefusal,
  PLAY_TICKET_DAILY_CLAIM_ACTION,
  resolveActionAmounts,
  resolveChestClickTrackerKey,
  resolvePlayTicketTokenKey,
  resolveRavenCoinMintAction,
  resolveRavenCoinTokenKey,
  resolveRewardAttemptTokenKey,
  supportsFreeRunOpens,
} from "./lib/ravenCoin";
import type { RewardWinMeta } from "./games/adapters/portal";
import { NightshadeArcadeHud } from "./components/NightshadeArcadeHud";
import { NightshadeArcadeNotice } from "./components/NightshadeArcadeNotice";
import type { ArcadeNotice } from "./components/NightshadeArcadeNotice";
import { ArcadeChestLeaderboard } from "./components/ArcadeChestLeaderboard";
import {
  ArcadeSettingsPanel,
  type ArcadeSettingsPage,
} from "./components/ArcadeSettingsPanel";
import { NightshadeArcadeShop } from "./components/NightshadeArcadeShop";
import { NightshadeKohiDialog } from "./components/NightshadeKohiDialog";
import { npcModalManager, type SpokenNpc } from "./lib/npcModalManager";
import { useArcadeMusic } from "./lib/useArcadeMusic";

/**
 * The arcade's Colyseus `sceneId` — must match the key
 * `NightshadeArcadeScene` starts with, because the room only mirrors players
 * that carry the same one.
 */
const NIGHTSHADE_ARCADE_SCENE_ID = "nightshade-arcade";

/**
 * The chest's own copy. Quoted rather than paraphrased anywhere else, because
 * the whole feature turns on the tone: the player is told to keep it quiet, and
 * then — once the supply runs out — told, in the same breath, that people did
 * not listen. {@link ArcadeNotice} titles are ours; the bodies are the owner's.
 */
const CHEST_REWARD_NOTICE: ArcadeNotice = {
  title: "50 in a row",
  body: "Congrats your dedication paid off! Who knew if you just randomly clicked @#$% you would get something out of it. Don't tell your friends about this, or you'll regret it!",
  tone: "good",
};

const CHEST_SPENT_NOTICE: ArcadeNotice = {
  title: "The chests are empty",
  body: "Told you not to tell your friends about it, guess some people don't listen",
  tone: "bad",
};

const CHEST_ALREADY_CLAIMED_NOTICE: ArcadeNotice = {
  title: "Chest already emptied",
  body: "You've claimed today's Play Ticket. Come back tomorrow, or top up with FLOWER from the Sunflower Land menu.",
  tone: "bad",
};

const CHEST_UNAVAILABLE_NOTICE: ArcadeNotice = {
  title: "Nothing inside",
  body: "Today's Play Ticket isn't available right now. Please try again later.",
  tone: "bad",
};

export const NightshadeArcadeApp: React.FC = () => {
  const {
    jwt,
    actions,
    playerEconomy,
    economyMeta,
    dispatchAction,
    farmId,
    playerData,
  } = useMinigameSession();
  // The session's own VIP answer: `farm.vip.isVip`, as the economies API resolves
  // it. See `lib/portal/vip.ts`.
  const isVip = useVipAccess();
  const [tokenBalance, setTokenBalance] = useState(0);
  const [activeGameId, setActiveGameId] = useState<string | null>(null);
  const [showShopModal, setShowShopModal] = useState(false);
  // NPC dialogs, opened from the world by `npcModalManager.open(...)`.
  const [npc, setNpc] = useState<SpokenNpc | undefined>(undefined);
  const [notice, setNotice] = useState<ArcadeNotice | null>(null);
  // Settings owns the developer tools now. `null` means closed; the page itself is
  // gated on the Dev Key inside `ArcadeSettingsPanel`, which is also where the
  // server-enforced reasoning lives — see `lib/devAccess.ts`.
  const [settingsPage, setSettingsPage] = useState<ArcadeSettingsPage | null>(
    null,
  );
  const activeEntry = useMemo(
    () => (activeGameId ? getGameEntry(activeGameId) : undefined),
    [activeGameId],
  );
  const ActiveGameComponent = activeEntry?.component;

  const sessionUsername = playerData?.resolvedProfile?.username;
  const bumpkinJoin = useMmoBumpkinJoin();

  /**
   * Joins the shared production plaza room so everyone on this map sees each
   * other, the same way `src/examples/tileJump` does: `lib/mmo` connects once
   * and hands the room handle to the Phaser game through
   * `MMO_SERVER_REGISTRY_KEY` (`NightshadeArcadePhaser`).
   *
   * `sceneId` is the grouping key — only clients that joined with the same
   * value are mirrored, which isolates the arcade from the plaza and the other
   * minigames. It rides along in every position packet too, so the basement
   * announces its own scene key and walking down the stairs changes who can
   * see you (see `ArcadeBaseScene.sendPositionToServer` / `syncPlayers`).
   */
  const mmoConnectOptions = useMemo(() => {
    const spawn = getNightshadeArcadeSpawn();

    return {
      sceneId: NIGHTSHADE_ARCADE_SCENE_ID,
      farmId,
      // The name tag falls back to `#<farmId>` when the session carries no
      // username, so send that same label instead of letting the room default
      // it to "Guest" — `updateUsernames` would otherwise repaint the tag.
      username: sessionUsername || `#${farmId}`,
      bumpkin: bumpkinJoin,
      spawn: { x: spawn.x, y: spawn.y },
    };
  }, [farmId, sessionUsername, bumpkinJoin]);

  const handleBack = () => {
    setActiveGameId(null);
  };

  /**
   * Pay out a win.
   *
   * Two separate things happen here and only one of them is the reward:
   *
   *  1. **The mint** — `dispatchAction({ action })` runs the published economy
   *     rule. It applies optimistically, POSTs `/action`, then merges the
   *     server's authoritative `playerEconomy` back in. That is what makes the
   *     coin survive a refresh, and what makes the server's daily cap the real
   *     limit rather than the client's say-so.
   *  2. **The score** — `submitScore` only writes the portal leaderboard. It
   *     never credits currency; it stays as a best-effort side channel.
   *
   * `tokenBalance` is deliberately *not* incremented when the mint runs:
   * `playerEconomy.balances` already carries it, and adding both would double
   * count. It is only used as the degraded path where no coin-minting action is
   * published at all, so the player still sees what they won instead of nothing.
   *
   * When the rule engine *rejects* the mint (daily cap reached, say) nothing is
   * credited: `dispatchAction`'s `{ ok: false }` is the server's own rule
   * verdict mirrored locally, and honouring it is the whole point of the cap.
   * The reason is left on `apiError` for the shop to surface.
   */
  const handleWin = (tokens: number, meta?: RewardWinMeta) => {
    if (!Number.isFinite(tokens) || tokens <= 0) return;

    const coinKey = resolveRavenCoinTokenKey({
      economyMeta,
      items: playerEconomy?.items,
      balances: playerEconomy?.balances,
    });

    // Three payouts, three published actions:
    //   ticket-funded → the uncapped one, or the free run's cap would reject it;
    //   VIP free run  → this cabinet's own action, so "one free run per machine"
    //                   is enforced *and counted* per machine (refresh-proof);
    //   non-VIP free  → the arcade-wide action, capped at one for the day.
    //
    // `meta.isVip` is the store's view at the moment of the win, which is the
    // same signal; the local `isVip` is only the fallback for a win that
    // arrives without a run context.
    const vip = meta?.isVip ?? isVip;
    const variant =
      meta?.fundedBy === "ticket" ? "ticket" : vip ? "machine" : "free";

    // A run is paid by destroying a voucher only when it was *opened* against
    // one. A ticket run always was. A free run only is once this economy
    // publishes the run-opens — and that has to be checked, because the
    // Reward Attempt item exists either way (the ticket flow mints it).
    //
    // Getting this wrong desynchronises the ledger from the gate: paying a free
    // win through `Claim-Raven-Coin` while the gate still counts
    // `Mint-Raven-Coin-<Cabinet>` means the count the gate reads never moves, so
    // the free run looks unused again after every refresh. Within one session
    // the in-session counter hides it, which is why it only showed up on reload.
    const voucherFunded =
      meta?.fundedBy === "ticket" || supportsFreeRunOpens(actions);
    const voucherKey = voucherFunded
      ? resolveRewardAttemptTokenKey({
          economyMeta,
          items: playerEconomy?.items,
          balances: playerEconomy?.balances,
        })
      : undefined;

    const mintAction = resolveRavenCoinMintAction({
      actions,
      coinKey,
      variant,
      machine: meta?.machine,
      voucherKey,
    });
    const amounts = resolveActionAmounts({
      actions,
      actionId: mintAction,
      tokenKey: coinKey,
      amount: 1,
    });

    if (!mintAction) {
      // No rule published that mints the coin — nothing can be committed, so
      // show it for this session only.
      setTokenBalance((b) => b + tokens);
    } else {
      // The rule mints a fixed amount (1) per call, so a larger payout is N
      // calls. Every game currently reports `*_RAVEN_COIN_REWARD = 1`, so this
      // is a single call in practice.
      //
      // `meta.verify` rides along only on the **first** call: it is proof of one
      // run, and resending it would ask the worker to certify the same run
      // twice — the second of which rightly fails its nonce and rolls back.
      for (let i = 0; i < tokens; i++) {
        dispatchAction({
          action: mintAction,
          amounts,
          ...(i === 0 && meta?.verify ? { verify: meta.verify } : {}),
        });
      }
    }

    if (getMinigamesApiUrl() && jwt) {
      void submitScore({ token: jwt, score: tokens }).catch(() => {
        // score submission errors are non-blocking
      });
    }
  };

  useEffect(() => {
    // Registry-driven: every entry in GAME_REGISTRY becomes launchable from a
    // cabinet (see data/machineMap.ts) without touching this file again.
    const unsubscribes = GAME_REGISTRY.map((entry) =>
      minigamesEventEmitter.subscribe(
        entry.id as Parameters<typeof minigamesEventEmitter.subscribe>[0],
        () => setActiveGameId(entry.id),
      ),
    );

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  useEffect(() => {
    const openShop = () => setShowShopModal(true);
    nightshadeArcadeEvents.registerShopHandler(openShop);

    return () => {
      nightshadeArcadeEvents.registerShopHandler(null);
    };
  }, []);

  // One listener, exactly like the main game's `NPCModals`.
  useEffect(() => {
    npcModalManager.listen((openedNpc) => setNpc(openedNpc));
  }, []);

  /**
   * How much of the chests' global supply is left, and who has taken the most.
   *
   * Read once on entry so a player who arrives after the pot is empty is told on
   * their first click rather than after fifty of them, and re-read after a
   * payout so the tally stays current for whoever arrives next.
   *
   * Advisory, like everything in `lib/chestApi.ts`. The authoritative answer is
   * the economy's refusal, which {@link claimChestTicket} still honours — so if
   * this is stale in either direction the worst case is the wrong one of the two
   * messages, never a free ticket.
   */
  const [chestTally, setChestTally] = useState<ChestTally | null>(null);

  /**
   * Latched once the pot is known to be empty, and deliberately its own boolean
   * rather than a read of `chestTally.exhausted`.
   *
   * The server's refusal is the authority, and it arrives with no tally attached
   * — in a build with no worker, or on the fetch that failed. Deriving the flag
   * from the tally instead would mean re-discovering the empty pot by clicking
   * fifty more times, every single time.
   */
  const [chestExhausted, setChestExhausted] = useState(false);

  const refreshChestTally = useCallback(() => {
    // No worker in this build: the chests keep working, they just never show a
    // leaderboard. That is the safe degradation — `chestApi` failing is
    // cosmetic, unlike the mint it would be reporting on.
    if (!jwt || !chestTallyConfigured()) return;

    void fetchChestTally(jwt).then((result) => {
      if (result.ok) setChestTally(result.value);
    });
  }, [jwt]);

  useEffect(() => {
    refreshChestTally();
  }, [refreshChestTally]);

  useEffect(() => {
    if (chestTally?.exhausted) setChestExhausted(true);
  }, [chestTally?.exhausted]);

  /**
   * The entryway chests: **50 clicks in a row**, then one Play Ticket, once a
   * day — until the arcade has handed out all 10 000 of them.
   *
   * Three things are going on and they are worth keeping apart:
   *
   *  1. **The streak** (`lib/chestStreak.ts`) is local, in memory, and gone on
   *     refresh. It decides *whether* to ask for a ticket; it never decides
   *     whether one is owed.
   *  2. **The ticket** comes from `Claim-Play-Ticket`, whose `cooldownSeconds:
   *     86400` is what makes the two chests one daily allowance rather than two.
   *     The local rule engine enforces that cooldown from
   *     `rules[<actionId>].ranAt`, so the second attempt of the day is refused
   *     synchronously and the player is told so instead of getting a silent
   *     nothing.
   *  3. **The cap** is not here either. The action mints one
   *     `chest_click_tracker` alongside the ticket, and that item's global
   *     `supply` is what runs out — server-side, atomic with the mint. This
   *     file only reacts to that refusal and to the worker's advisory tally.
   *
   * FLOWER purchases stay published on the host page as a top-up for a player who
   * has already claimed today, so the cooldown refusal points at them.
   */
  const claimChestTicket = useCallback(() => {
    if (!actions?.[PLAY_TICKET_DAILY_CLAIM_ACTION]) {
      setNotice(CHEST_UNAVAILABLE_NOTICE);
      return;
    }

    const ticketKey = resolvePlayTicketTokenKey({
      economyMeta,
      items: playerEconomy?.items,
      balances: playerEconomy?.balances,
    });
    const trackerKey = resolveChestClickTrackerKey({
      economyMeta,
      items: playerEconomy?.items,
      balances: playerEconomy?.balances,
    });

    // The action mints two tokens, and a *ranged* mint needs an explicit amount
    // per token or the server answers `400 Missing or invalid mint amount`. The
    // tracker is published fixed, so in practice only the ticket contributes —
    // but resolving both means a fork that ranges the tracker does not silently
    // fail to mint it.
    const amounts = [ticketKey, trackerKey]
      .filter((key): key is string => Boolean(key))
      .map((tokenKey) =>
        resolveActionAmounts({
          actions,
          actionId: PLAY_TICKET_DAILY_CLAIM_ACTION,
          tokenKey,
          amount: 1,
        }),
      )
      .reduce<Record<string, number>>(
        (merged, part) => Object.assign(merged, part),
        {},
      );

    const result = dispatchAction({
      action: PLAY_TICKET_DAILY_CLAIM_ACTION,
      amounts: Object.keys(amounts).length ? amounts : undefined,
    });

    if (!result.ok) {
      const refusal = classifyChestClaimRefusal(result.error);

      // The pot is the server's to say, and this is it saying no. From here the
      // chests stop being a streak and become a message.
      if (refusal === "supply") {
        setChestExhausted(true);
        setNotice(CHEST_SPENT_NOTICE);
        void refreshChestTally();
        return;
      }

      setNotice(
        refusal === "cooldown"
          ? CHEST_ALREADY_CLAIMED_NOTICE
          : CHEST_UNAVAILABLE_NOTICE,
      );
      return;
    }

    setNotice(CHEST_REWARD_NOTICE);

    // Report the payout to the worker's tally. Fire-and-forget on purpose: the
    // ticket is already minted and nothing the player won depends on this, so a
    // failure here costs a row on a leaderboard that is not shown until the pot
    // is empty anyway. See `lib/chestApi.ts`.
    if (jwt && chestTallyConfigured()) {
      void recordChestTicket(jwt).then((recorded) => {
        if (recorded.ok) refreshChestTally();
      });
    }
  }, [
    actions,
    dispatchAction,
    economyMeta,
    jwt,
    playerEconomy,
    refreshChestTally,
  ]);

  useEffect(() => {
    const onChestClick = () => {
      // The notice is modal, but Phaser is still live underneath it. A click
      // that lands on a chest *behind* the popup would otherwise swap one
      // message for another mid-read — or fire a second claim while the player
      // is still reading the result of the first. OK is the only way out of the
      // dialog; the world waits for it.
      if (notice) return;

      // Once the supply is gone there is no streak to build, so the chests say so
      // on the very next click rather than making the player earn the news.
      if (chestExhausted) {
        setNotice(CHEST_SPENT_NOTICE);
        return;
      }

      if (chestStreak.click()) {
        void claimChestTicket();
      }
    };

    // Anything that is not a chest ends the run. This is the scene telling us a
    // click landed on a machine, a prize desk or Raven — see `chestStreak.ts`.
    const onNonChestClick = () => chestStreak.miss();

    nightshadeArcadeEvents.registerChestClickHandler(onChestClick);
    nightshadeArcadeEvents.registerNonChestClickHandler(onNonChestClick);

    return () => {
      nightshadeArcadeEvents.registerChestClickHandler(null);
      nightshadeArcadeEvents.registerNonChestClickHandler(null);
    };
  }, [chestExhausted, claimChestTicket, notice]);

  const isGameOpen = Boolean(activeEntry && ActiveGameComponent);

  // Music: the open game's own track if it has one, otherwise the current
  // floor's (resolved inside the hook). Opening a cabinet sets `activeEntry`,
  // so this is the moment a game's soundtrack takes over.
  useArcadeMusic(activeEntry?.music);

  useEffect(() => {
    nightshadeArcadeEvents.setMinigameActive(isGameOpen);

    return () => {
      nightshadeArcadeEvents.setMinigameActive(false);
    };
  }, [isGameOpen]);

  // Every registry entry is "local" or "scaffolded", so the game component owns
  // its own back navigation via `onBack` — no hub-injected overlay is needed.
  return (
    <>
      <MmoRoomProvider connectOptions={mmoConnectOptions}>
        <NightshadeArcadePhaser />
      </MmoRoomProvider>
      <NightshadeArcadeHud
        extraRavenCoins={tokenBalance}
        onOpenSettings={() => setSettingsPage("main")}
      />
      {activeEntry && ActiveGameComponent ? (
        <Modal show className="justify-stretch items-stretch bg-black/55 p-0">
          <div className="relative h-full w-full overflow-hidden">
            <ActiveGameComponent
              onBack={handleBack}
              onWin={handleWin}
              tokenReward={activeEntry.tokenReward}
            />
          </div>
        </Modal>
      ) : null}
      <Modal show={showShopModal} onHide={() => setShowShopModal(false)}>
        <NightshadeArcadeShop onClose={() => setShowShopModal(false)} />
      </Modal>
      <Modal show={npc === "kohi"} onHide={() => setNpc(undefined)}>
        <NightshadeKohiDialog onClose={() => setNpc(undefined)} />
      </Modal>
      {/* The chest popup is a single-purpose dialog: one question, one button.
          It used to double as the home of the dev mint, which meant a developer
          opening a chest to check the daily ticket also got a mint form in the
          same dialog. The developer tools live under Settings → Developer now,
          behind the Dev Key. The one thing that still rides along is the chest
          leaderboard, and only for the "the pots are empty" message it belongs
          to — read-only, no second action, same question. */}
      <NightshadeArcadeNotice notice={notice} onClose={() => setNotice(null)}>
        {chestExhausted && notice === CHEST_SPENT_NOTICE && chestTally ? (
          <ArcadeChestLeaderboard
            entries={chestTally.entries}
            you={chestTally.you}
          />
        ) : null}
      </NightshadeArcadeNotice>

      {settingsPage ? (
        <ArcadeSettingsPanel
          page={settingsPage}
          onNavigate={setSettingsPage}
          onClose={() => setSettingsPage(null)}
        />
      ) : null}
    </>
  );
};
