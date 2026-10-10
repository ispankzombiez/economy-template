import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "components/ui/Button";
import { Modal } from "components/ui/Modal";
import { Panel } from "components/ui/Panel";
import { SUNNYSIDE } from "example-assets/sunnyside";
import { useMinigameSession } from "lib/portal";
import { ARCADE_DEVELOPER, resolveDevAccess } from "../lib/devAccess";
import {
  bootstrapDevKey,
  fetchMyRewards,
  claimReward,
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
  | "developer-self"
  | "developer-send"
  | "rewards"
  | "preferences";

/**
 * The row style shared by every main-page option and the Back control, so Back
 * reads as one of the options rather than as a bare underlined link.
 */
const ROW_CLASS =
  "cursor-pointer rounded border border-[#7a4b52]/30 bg-white/40 px-2 py-2 text-xs text-[#3e2731] hover:bg-white/70";

/**
 * Make the panel fill the viewport, on a phone and on a desktop equally.
 *
 * Two things are needed and both are fiddly:
 *
 *  - `100dvh` rather than `100vh`. On a phone the browser chrome takes part of
 *  the viewport, and `vh` measures the *largest* possible viewport — so a `100vh`
 *  panel is taller than what the player can see, and its footer is under the URL
 *    bar. `dvh` is the viewport as it actually is right now. The `1rem` is the
 *    `Modal`'s own `p-2`.
 *  - `[&>div]`, because `Panel` puts `className` on the *outer* wrapper only and
 *    renders its own inner div. Sizing the outer alone leaves the inner panel at
 *    its natural height, so nothing actually fills. This forces the direct child to
 *    `flex-1`, which is the element the content really sits in.
 *
 * The flex chain is what makes scrolling work rather than just look right: the
 * inner panel and the scroll container both need `min-h-0`, or they refuse to
 * shrink below their content and the overflow escapes the panel.
 *
 * `max-w-none` drops the `max-w-sm` the rest of the settings uses. On a desktop a
 * phone-width column in the middle of the screen wastes the space the dev tools
 * need — the audit trail in particular is a scrolling list of records.
 */
const FILL_VIEWPORT =
  "flex h-[calc(100dvh-1rem)] w-full max-w-none flex-col [&>div]:flex [&>div]:min-h-0 [&>div]:flex-1";

/** The panel as every non-dev page has always looked: narrow, content-height. */
const COMPACT_PANEL = "w-full max-w-sm";

/**
 * One developer entry, with the hammer icon.
 *
 * Extracted so the two developer rows cannot drift apart in styling — they used to
 * be a single `Developer` row whose class string was written out inline, and
 * adding a second one is exactly when that duplication starts.
 */
const DevEntry: React.FC<{ label: string; onClick: () => void }> = ({
  label,
  onClick,
}) => (
  <button
    type="button"
    className="flex w-full cursor-pointer items-center gap-2 rounded border border-[#7a4b52]/40 bg-white/60 px-2 py-2 text-left text-xs text-black hover:bg-white/80"
    onClick={onClick}
  >
    <img alt="" src={SUNNYSIDE.icons.hammer} style={{ width: 18, height: 18 }} />
    {label}
  </button>
);

/**
 * The arcade's settings panel: one entry point in the HUD column, three sub-pages.
 *
 * Audio is always present — both of its toggles are purely local settings and
 * need no server. Rewards only appears when a worker is configured (below).
 *
 * ## The developer pages are unreached, not merely hidden
 *
 * A Dev Key holder gets one `Dev` row, and behind it a menu of `Self` and `Send`.
 * Nobody else gets the row, so there is no row to click and no state to forge —
 * the pages are not rendered, and the components that render them are never
 * mounted.
 *
 * `Self` holds the Play Ticket mint, which only ever affects the owner's own farm.
 * `Send` holds the reward queue, which moves value out to a player. Separate pages
 * because they are different audiences with different consequences, and because
 * stacking both tools plus an outstanding list plus a claimed list on one screen
 * crowded it badly enough that the audit trail was unreadable.
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
  const { jwt, farmId, actions, playerEconomy, economyMeta, dispatchAction, apiError } =
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

  // --- Dev Key restore state ----------------------------------------------
  const [restoringKey, setRestoringKey] = useState(false);
  const [restoreMessage, setRestoreMessage] = useState<{
    tone: "good" | "bad";
    text: string;
  } | null>(null);

  /**
   * Whether to offer the Dev Key restore.
   *
   * Shown only to the arcade owner's own farm, and only when they hold no key —
   * which is the situation where every dev tool is otherwise unreachable. A player
   * with a key has nothing to restore, and a player who is not the owner has
   * nothing to restore it into.
   *
   * The farm number is compared as a string rather than a number. `farmId` is `0`
   * until the session resolves it, and `String(0)` is `"0"`, which does not match —
   * so an unresolved session simply shows nothing rather than offering the action.
   *
   * This is a convenience only. The worker re-checks the same farm, the same
   * "no key held" and the same "no key exists anywhere" independently, and refuses
   * anything this got wrong.
   */
  const canRestoreDevKey =
    rewardsEnabled && !isDev && String(farmId ?? 0) === String(ARCADE_DEVELOPER.farmId);

  const restoreDevKey = async () => {
    if (!jwt || restoringKey) return;
    setRestoringKey(true);
    setRestoreMessage(null);

    const result = await bootstrapDevKey(jwt);
    if (!result.ok) {
      setRestoreMessage({ tone: "bad", text: result.error });
      setRestoringKey(false);
      return;
    }

    setRestoreMessage({
      tone: "good",
      text: "Dev Key restored. The Dev tools are in Settings now.",
    });
    setRestoringKey(false);
  };

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
   * Claim a reward.
   *
   * One call, and it does everything: the worker checks the grant belongs to this
   * farm, checks it has not been taken, records the claim, and runs the published
   * reward button itself. The client names only the grant.
   *
   * This used to press the button here and then tell the worker afterwards, which
   * meant this file chose which action to press — and the marker item's
   * `requireAbsent` was the only thing making that once-only. The worker's ledger
   * is that gate now, so "already claimed" is its answer and not one this file
   * decides.
   */
  const claim = async (reward: RewardRequest) => {
    if (!jwt || claimingId) return;
    setClaimingId(reward.id);
    setRewardsError(null);

    const result = await claimReward(jwt, reward.id);
    if (!result.ok) {
      setRewardsError(result.error);
      setClaimingId(null);
      return;
    }

    setRewards((previous) => previous.filter((entry) => entry.id !== reward.id));
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

  // Only the developer pages fill the screen.
  //
  // Everything else keeps the compact panel the player is used to: Audio, the
  // rewards refresh, and the main menu are small, phone-shaped sheets, and a
  // full-bleed desktop panel around three buttons looks broken. The dev tools are
  // the ones that carry lists and form fields, so those are what needed the room.
  const isDevPage =
    page === "developer" ||
    page === "developer-self" ||
    page === "developer-send";

  return (
    <Modal show onHide={onClose}>
      <Panel className={isDevPage ? FILL_VIEWPORT : COMPACT_PANEL}>
        <div
          className={
            isDevPage
              ? // One scroll container for the whole panel, rather than one per
                // page, so the header stays put and the content scrolls under it.
                // `min-h-0` is what lets it shrink instead of pushing the panel
                // past the screen.
                "flex min-h-0 flex-col p-2 text-[#3e2731]"
              : "p-2 text-[#3e2731]"
          }
        >
          {/* The scroll wrapper only applies on the dev pages; on the compact
              ones it is an unstyled pass-through, which keeps the JSX balanced
              without giving the small pages a scroller they cannot use. */}
          <div
            className={
              isDevPage ? "min-h-0 flex-1 overflow-y-auto" : undefined
            }
          >
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
                  <DevEntry label="Dev" onClick={() => onNavigate("developer")} />
                ) : null}
              </div>
            </>
          ) : null}

          {/*
            The Dev menu: one door into the owner's tools, two behind it.

            `Self` is what the owner does to their own farm (mint tickets). `Send`
            is what they do to somebody else's (queue a reward, and read what is
            outstanding and claimed). They are separate because they are different
            audiences with different consequences — one only ever affects you, the
            other moves value to a player — and because stacking both tools plus an
            outstanding list plus a claimed list on one screen crowded it badly
            enough that the audit trail was unreadable.
          */}
          {page === "developer" && isDev ? (
            <>
              {pageHeader("Dev")}
              <div className="space-y-2">
                <button
                  type="button"
                  className={`w-full text-left ${ROW_CLASS}`}
                  onClick={() => onNavigate("developer-self")}
                >
                  Self
                </button>
                <button
                  type="button"
                  className={`w-full text-left ${ROW_CLASS}`}
                  onClick={() => onNavigate("developer-send")}
                >
                  Send
                </button>
              </div>
            </>
          ) : null}

          {page === "developer-self" && isDev ? (
            <>
              {pageHeader("Self")}
              {/*
                No `max-h` here: the panel itself now fills the viewport and the
                wrapper above scrolls, so an inner cap would only shrink the tool
                on a tall screen and leave a gap below it on a short one.
              */}
              <div className="space-y-3">
                <NightshadeArcadeDevMint />
                {apiError ? (
                  <p className="text-xs text-red-800">{apiError}</p>
                ) : null}
              </div>
            </>
          ) : null}

          {page === "developer-send" && isDev ? (
            <>
              {pageHeader("Send")}
              <div className="space-y-3">
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
                <p className="text-xs">
                  Nothing waiting for you right now.
                  {/*
                    The restore lives here because this is the one page reachable
                    without a Dev Key — every other dev tool is behind one. Putting it
                    anywhere else would mean a farm with no key could not reach it.
                  */}
                  {canRestoreDevKey ? (
                    <span className="mt-3 block rounded border border-[#7a4b52]/40 bg-white/50 p-2 text-left">
                      <span className="block text-xs font-semibold text-black">
                        Developer key missing?
                      </span>
                      <span className="mt-1 block text-[11px] leading-relaxed text-black">
                        After an economy reset this farm holds no Dev Key, which puts
                        the Dev tools out of reach. This restores it — once, and only
                        while no Dev Key exists anywhere in the economy.
                      </span>
                      {restoreMessage ? (
                        <span
                          className={`mt-2 block text-[11px] ${
                            restoreMessage.tone === "good"
                              ? "text-green-800"
                              : "text-red-800"
                          }`}
                        >
                          {restoreMessage.text}
                        </span>
                      ) : null}
                      <span className="mt-2 block">
                        <Button
                          disabled={restoringKey}
                          onClick={() => void restoreDevKey()}
                        >
                          {restoringKey ? "Restoring…" : "Restore Dev Key"}
                        </Button>
                      </span>
                    </span>
                  ) : null}
                </p>
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
        </div>
      </Panel>
    </Modal>
  );
};
