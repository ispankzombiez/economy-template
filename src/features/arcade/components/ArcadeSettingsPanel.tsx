import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "components/ui/Button";
import { Modal } from "components/ui/Modal";
import { Panel } from "components/ui/Panel";
import { SUNNYSIDE } from "example-assets/sunnyside";
import { useMinigameSession } from "lib/portal";
import { resolveDevAccess } from "../lib/devAccess";
import {
  fetchMyRewards,
  markRewardClaimed,
  resolvePayoutButtons,
  rewardsWorkerConfigured,
  type RewardRequest,
} from "../lib/rewardsApi";
import { NightshadeArcadeDevMint } from "./NightshadeArcadeDevMint";
import { NightshadeArcadeDevRewards } from "./NightshadeArcadeDevRewards";
import { ArcadeAudioSettings } from "./ArcadeAudioSettings";

/** Which settings page is open. */
export type ArcadeSettingsPage =
  | "main"
  | "developer"
  | "rewards"
  | "preferences";

/**
 * The row style shared by every main-page option and the Back control, so Back
 * reads as one of the options rather than as a bare underlined link.
 */
const ROW_CLASS =
  "cursor-pointer rounded border border-[#7a4b52]/30 bg-white/40 px-2 py-2 text-xs text-[#3e2731] hover:bg-white/70";

/**
 * The arcade's settings panel: one entry point in the HUD column, three sub-pages.
 *
 * Audio is always present — both of its toggles are purely local settings and
 * need no server. Rewards only appears when a worker is configured (below).
 *
 * ## The developer page is unreached, not merely hidden
 *
 * A Dev Key holder gets a `developer` row. Nobody else does, so there is no row to
 * click and no state to forge — the page is not rendered, and the component that
 * renders it is never mounted.
 *
 * That is a UI gate, and this file says so plainly. It is not the real one. The
 * real gate is two-sided and both halves are server-side:
 *
 *  - `Dev-Mint-Play-Ticket` carries a `require` on the Dev Key balance, so the
 *    rule engine refuses the mint for anyone without it (see `lib/devAccess.ts`);
 *  - the reward worker independently refuses to queue a reward for a caller who
 *    does not hold one, deciding that from Sunflower Land's answer.
 *
 * A player who edits the bundle to reveal this page gets buttons that do nothing.
 *
 * Colours throughout are dark on the light `Panel`, matching Inventory, Settings
 * and the shop. An earlier pass used amber-on-dark, which is unreadable here.
 *
 * ## Rewards are optional
 *
 * With no worker configured (`VITE_REWARDS_WORKER_URL` unset) there is no rewards
 * page at all, and the arcade behaves exactly as it did before — rather than
 * showing every player an empty inbox it cannot fill.
 */
export const ArcadeSettingsPanel: React.FC<{
  page: ArcadeSettingsPage;
  onNavigate: (page: ArcadeSettingsPage) => void;
  onClose: () => void;
}> = ({ page, onNavigate, onClose }) => {
  const { jwt, actions, playerEconomy, economyMeta, dispatchAction, apiError } =
    useMinigameSession();

  const rewardsEnabled = rewardsWorkerConfigured();

  /**
   * The Dev Key, read from the balances the server returned.
   *
   * Server-derived in the only sense that matters: it mirrors a `require` the rule
   * engine has already accepted, so nothing the browser says about itself can
   * produce it.
   */
  const isDev = useMemo(
    () =>
      resolveDevAccess({
        economyMeta,
        items: playerEconomy?.items,
        balances: playerEconomy?.balances,
      }),
    [economyMeta, playerEconomy?.items, playerEconomy?.balances],
  );

  const payoutButtons = useMemo(
    () => resolvePayoutButtons({ actions, items: economyMeta?.items }),
    [actions, economyMeta?.items],
  );

  // --- rewards state ------------------------------------------------------
  const [rewards, setRewards] = useState<RewardRequest[]>([]);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "failed">(
    "idle",
  );
  const [rewardsError, setRewardsError] = useState<string | null>(null);
  const [claimingId, setClaimingId] = useState<string | null>(null);

  const loadRewards = useCallback(async () => {
    if (!jwt) return;
    setLoadState("loading");
    const result = await fetchMyRewards(jwt);
    if (!result.ok) {
      setRewardsError(result.error);
      setLoadState("failed");
      return;
    }
    // Claimed rows are history, not an inbox: filter them so a stale KV read
    // cannot present a reward the player has already taken.
    setRewards(result.value.requests.filter((entry) => !entry.claimedAt));
    setRewardsError(null);
    setLoadState("ready");
  }, [jwt]);

  useEffect(() => {
    if (page !== "rewards") return;
    void loadRewards();
  }, [page, loadRewards]);

  /**
   * Claim a reward: press the button, then tell the worker it is spent.
   *
   * The order matters, and only this way round. The button is what changes the
   * player's balance, so a failure there means the reward was **not** received —
   * ticking the worker off first would lose it. Ticking afterwards is only
   * bookkeeping, and a failure there is harmless: the row stays, and the next
   * press is refused by the button's own `requireAbsent`, which is the
   * authoritative "already claimed" answer rather than anything this file decides.
   */
  const claim = async (reward: RewardRequest) => {
    if (!jwt || claimingId) return;
    setClaimingId(reward.id);

    const result = dispatchAction({
      action: reward.actionId,
      optimistic: false,
    });
    if (!result.ok) {
      setRewardsError(result.error);
      setClaimingId(null);
      return;
    }

    const ticked = await markRewardClaimed(jwt, reward.id);
    if (!ticked.ok) {
      setRewardsError(
        `${ticked.error} The reward was granted, so reload and it will be gone from your list.`,
      );
      setClaimingId(null);
      return;
    }

    setRewards((previous) => previous.filter((entry) => entry.id !== reward.id));
    setRewardsError(null);
    setClaimingId(null);
  };

  // --- render -------------------------------------------------------------
  /**
   * Header for the audio page: title centred, X top-right.
   *
   * Deliberately not the `pageHeader` used by the other sub-pages. This one
   * matches the main game's audio panel, which is a leaf panel you dismiss
   * rather than a step you go back up from — so the X closes the whole settings
   * panel (`onClose`) instead of navigating back to `"main"`.
   *
   * `close.png` is on the CDN and resolves, unlike the audio glyphs.
   */
  const audioHeader = () => (
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="w-6" />
      <span className="text-sm font-bold text-[#3e2731]">Audio</span>
      <button
        type="button"
        aria-label="Close settings"
        title="Close settings"
        onClick={onClose}
        className="w-6 shrink-0 cursor-pointer hover:brightness-90"
      >
        <img
          alt=""
          src={SUNNYSIDE.icons.close}
          className="w-full"
          style={{ imageRendering: "pixelated" }}
        />
      </button>
    </div>
  );

  /**
   * Header for a sub-page.
   *
   * `title` is optional: the rewards page is opened to do one thing and says
   * what it is by its content, so it passes nothing and the row is just Back.
   * The title stays centred in the leftover space either way, so Back does not
   * shift between pages.
   */
  const pageHeader = (title?: string) => (
    <div className="mb-2 flex items-center gap-2">
      <button
        type="button"
        className={ROW_CLASS}
        onClick={() => onNavigate("main")}
      >
        Back
      </button>
      <span className="flex-1 text-center text-sm font-bold text-[#3e2731]">
        {title}
      </span>
    </div>
  );

  return (
    <Modal show onHide={onClose}>
      <Panel className="w-full max-w-sm">
        <div className="p-2 text-[#3e2731]">
          {page === "main" ? (
            <>
              <div className="mb-2 text-sm font-bold">Settings</div>
              <div className="space-y-2">
                <button
                  type="button"
                  className={`w-full text-left ${ROW_CLASS}`}
                  onClick={() => onNavigate("preferences")}
                >
                  Audio
                </button>

                {rewardsEnabled ? (
                  <button
                    type="button"
                    className={`w-full text-left ${ROW_CLASS}`}
                    onClick={() => onNavigate("rewards")}
                  >
                    Refresh from Chain
                  </button>
                ) : null}

                {isDev ? (
                  <button
                    type="button"
                    className="flex w-full cursor-pointer items-center gap-2 rounded border border-[#7a4b52]/40 bg-white/60 px-2 py-2 text-left text-xs text-black hover:bg-white/80"
                    onClick={() => onNavigate("developer")}
                  >
                    <img
                      alt=""
                      src={SUNNYSIDE.icons.hammer}
                      style={{ width: 18, height: 18 }}
                    />
                    Developer
                  </button>
                ) : null}
              </div>
            </>
          ) : null}

          {page === "developer" && isDev ? (
            <>
              {pageHeader("Developer")}
              <div className="max-h-[26rem] space-y-3 overflow-y-auto">
                <NightshadeArcadeDevMint />
                <NightshadeArcadeDevRewards payoutButtons={payoutButtons} />
                {apiError ? (
                  <p className="text-xs text-red-800">{apiError}</p>
                ) : null}
              </div>
            </>
          ) : null}

          {page === "rewards" ? (
            <>
              {/* No title by design: the row is opened to pull a fresh
                  balance from the chain, and says that in its content. */}
              {pageHeader()}
              {loadState === "loading" ? (
                <p className="text-xs">Checking…</p>
              ) : loadState === "failed" ? (
                <>
                  <p className="text-xs text-red-700">{rewardsError}</p>
                  <div className="mt-2">
                    <Button onClick={() => void loadRewards()}>Try again</Button>
                  </div>
                </>
              ) : rewards.length === 0 ? (
                <p className="text-xs">Nothing waiting for you right now.</p>
              ) : (
                <div className="max-h-[22rem] space-y-2 overflow-y-auto">
                  {rewards.map((reward) => (
                    <div
                      key={reward.id}
                      className="rounded border border-[#7a4b52]/25 bg-white/40 p-2"
                    >
                      <div className="text-xs font-semibold text-[#3e2731]">
                        {reward.label || "A reward for you"}
                      </div>
                      {reward.note ? (
                        <p className="mt-1 text-[11px] leading-relaxed text-[#5a4a44]">
                          {reward.note}
                        </p>
                      ) : null}
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <code className="text-[10px] text-[#7a4b52]/70">
                          {reward.actionId}
                        </code>
                        <Button
                          disabled={claimingId === reward.id}
                          onClick={() => void claim(reward)}
                        >
                          {claimingId === reward.id ? "Claiming…" : "Claim"}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {rewardsError && loadState === "ready" ? (
                <p className="mt-2 text-[11px] text-red-700">{rewardsError}</p>
              ) : null}
            </>
          ) : null}

          {page === "preferences" ? (
            <>
              {audioHeader()}
              <ArcadeAudioSettings />
            </>
          ) : null}
        </div>
      </Panel>
    </Modal>
  );
};
