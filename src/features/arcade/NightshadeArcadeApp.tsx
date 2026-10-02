import React, { useEffect, useMemo, useState } from "react";
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
import {
  PLAY_TICKET_DAILY_CLAIM_ACTION,
  resolveActionAmounts,
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
import {
  ArcadeSettingsPanel,
  type ArcadeSettingsPage,
} from "./components/ArcadeSettingsPanel";
import { NightshadeArcadeShop } from "./components/NightshadeArcadeShop";
import { NightshadeKohiDialog } from "./components/NightshadeKohiDialog";
import { npcModalManager, type SpokenNpc } from "./lib/npcModalManager";

/**
 * The arcade's Colyseus `sceneId` — must match the key
 * `NightshadeArcadeScene` starts with, because the room only mirrors players
 * that carry the same one.
 */
const NIGHTSHADE_ARCADE_SCENE_ID = "nightshade-arcade";

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
  // Session first, Community API as a fallback: `farm.vip.expiresAt` is the only
  // signal. See `lib/portal/vip.ts` and `lib/portal/communityVip.ts`.
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
      for (let i = 0; i < tokens; i++) {
        dispatchAction({ action: mintAction, amounts });
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
   * The entryway chests: **one** Play Ticket per player per day.
   *
   * Both chests dispatch the same published action, whose `cooldownSeconds:
   * 86400` is what makes the pair a single daily allowance rather than two — the
   * second chest of the day is refused by the server, and the player is told so
   * instead of getting a silent nothing. (Its `dailyCap: 1` is belt-and-braces:
   * that cap counts against `dailyMinted`, which held no `Claim-Play-Ticket`
   * entry on a day the chest had already paid out, so the cooldown in
   * `rules[<actionId>].ranAt` is the rule that actually holds.)
   * Nothing here decides whether the player *may* have the ticket; the rule
   * engine does, which is why the popup reports the server's verdict rather
   * than a guess.
   *
   * FLOWER purchases stay published on the host page as a top-up for a player who
   * has already claimed today, so the refusal points at them.
   */
  useEffect(() => {
    const claimDailyPlayTicket = () => {
      if (!actions?.[PLAY_TICKET_DAILY_CLAIM_ACTION]) {
        setNotice({
          title: "Nothing inside",
          body: "Today's Play Ticket isn't available right now. Please try again later.",
          tone: "bad",
        });
        return;
      }

      const ticketKey = resolvePlayTicketTokenKey({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
      });
      const result = dispatchAction({
        action: PLAY_TICKET_DAILY_CLAIM_ACTION,
        amounts: resolveActionAmounts({
          actions,
          actionId: PLAY_TICKET_DAILY_CLAIM_ACTION,
          tokenKey: ticketKey,
          amount: 1,
        }),
      });

      setNotice(
        result.ok
          ? {
              title: "You found a Play Ticket!",
              body: "It's been added to your inventory. Spend it on any machine for one reward run.",
              tone: "good",
            }
          : {
              title: "Chest already emptied",
              body: "You've claimed today's Play Ticket. Come back tomorrow, or top up with FLOWER from the Sunflower Land menu.",
              tone: "bad",
            },
      );
    };

    nightshadeArcadeEvents.registerChestClickHandler(claimDailyPlayTicket);
    return () => {
      nightshadeArcadeEvents.registerChestClickHandler(null);
    };
  }, [actions, dispatchAction, economyMeta, playerEconomy]);

  useEffect(() => {
    const isGameOpen = Boolean(activeEntry && ActiveGameComponent);
    nightshadeArcadeEvents.setMinigameActive(isGameOpen);

    return () => {
      nightshadeArcadeEvents.setMinigameActive(false);
    };
  }, [activeEntry, ActiveGameComponent]);

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
          behind the Dev Key. */}
      <NightshadeArcadeNotice notice={notice} onClose={() => setNotice(null)} />

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
