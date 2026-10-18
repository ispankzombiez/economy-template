import React, { useEffect, useRef, useState } from "react";
import { RoundButton } from "components/ui/RoundButton";
import { PIXEL_SCALE } from "lib/constants";
import { useSound } from "lib/utils/hooks/useSound";
import tradeIcon from "../assets/trade.png";
import ravenCoinIcon from "../assets/RavenCoin.webp";

/** URL for the Nightshade Arcade marketplace on the main SFL site. */
const MARKETPLACE_URL =
  "https://sunflower-land.com/play/#/marketplace/economies/Nightshade-Arcade/0";

/**
 * How long a warmed iframe keeps running when the player never clicks.
 *
 * Warming mounts the real marketplace (the whole SFL play app) hidden in the
 * background. That is deliberate — but it means a player who brushes the
 * button and walks away would leave a second game instance running behind the
 * arcade. The grace period bounds that cost: leave without clicking and the
 * frame is torn down ten seconds later; come back within the window and it is
 * still warm, so the popup opens instantly.
 *
 * Warming is strictly intent-driven (hover / touch / focus) for the same
 * reason. Warming on a timer behind the floor — tried and measured — boots a
 * second ~23 MB app while the player is walking around, and that boot and the
 * app's background work show up as lag spikes in the arcade itself. The
 * arcade's frame time wins over the marketplace's time-to-open.
 */
const WARM_GRACE_MS = 10_000;

type MarketplaceHistoryState = { nsMarketplacePopup: true };

const isMarketplaceEntry = (state: unknown): boolean =>
  typeof state === "object" &&
  state !== null &&
  (state as MarketplaceHistoryState).nsMarketplacePopup === true;

/**
 * The arcade's marketplace button.
 *
 * Opens the portal's online market (players buying RavenCoins from each other)
 * full screen over the arcade, same as the main game's own Portal embed: a
 * fixed overlay holding nothing but the iframe — no title bar, no close button
 * of our own chrome.
 *
 * ## Why opening pushes a history entry
 *
 * The marketplace's back button is `navigate(-1)` — plain `history.back()`.
 * An iframe's `history.back()` traverses the *joint* session history shared by
 * every frame on the page, not just its own entries. With no barrier below it,
 * that single back press escaped the iframe and walked the portal page
 * backwards past the arcade entirely — landing on whatever was open before it
 * (measured: the economy editor). No message is posted along the way, so
 * listening for one can never intercept it.
 *
 * So warming/opening `pushState`s a marker entry *before the iframe first
 * navigates* — ordering matters, see below. The marketplace's back now pops to
 * *that* entry: same document, so the arcade never navigates, and the
 * resulting `popstate` on our window is the signal that the player backed out —
 * which closes the popup. One dead same-URL entry is left behind per session;
 * it is detected by its marker on the next open and reused rather than
 * re-pushed, so history cannot grow one entry per visit.
 *
 * The barrier has to land in joint history *below* the iframe's entries, which
 * is why it is pushed at warm time (before the hidden iframe navigates) and
 * not at reveal time: an iframe navigation appends a new joint entry, so a
 * barrier pushed after that would sit *above* the marketplace and back would
 * pop into the marketplace's own previous entry instead of closing.
 *
 * ## Why the X on the marketplace page needs a catcher
 *
 * Measured in the deployed play bundle: the marketplace header's X is
 * `navigate(getMarketplaceReturnRoute(...), { replace: true })` — an in-iframe
 * SPA navigation to the SFL home screen. It posts no message, traverses no
 * history, and `replace` leaves joint history length untouched; the frame is
 * cross-origin, so its navigation is unobservable from here by any means.
 * (The back button is interceptable only because it traverses.) So a
 * transparent catcher sits exactly over the X's screen position — the click
 * the player aims at the X never reaches the frame, and closes the popup
 * instead. The marketplace's own X stays visible underneath; only its hit
 * area is borrowed.
 *
 * ## Why the iframe warms on pointer intent only
 *
 * The marketplace page is the entire SFL play app (a ~23 MB bundle plus game
 * assets), so a cold open always costs seconds — and the download is the
 * cheap part: the arcade runs inside the SFL portal, so the bundle is already
 * in the browser cache; what costs seconds is *booting* the app from scratch.
 * Pointer intent (hover on desktop, touch/focus on the way to a click) mounts
 * the frame hidden — a `display: none` iframe still loads and boots — so part
 * of that boot is paid before the popup is revealed. The themed loading
 * screen covers whatever warm-up time is left, and every cold open that skips
 * the intent path.
 *
 * Warming on a timer behind the floor was tried and removed: it booted the
 * second app while the player was walking around, and the boot plus the
 * hidden app's background work showed up as lag spikes in the arcade itself.
 * The arcade's frame time wins — the marketplace waits for the player's
 * intent, not the other way round.
 *
 * The `closePortal` message listener remains as a secondary path for SFL pages
 * that do post it (e.g. the game world's Travel button in portal mode), with an
 * `event.source` check so only the embedded frame can trigger it — the same
 * message the arcade sends *upward* must never close this popup.
 */
export const MarketplaceButton: React.FC = () => {
  /** The iframe exists (warming hidden, or revealed in the popup). */
  const [mounted, setMounted] = useState(false);
  const [showModal, setShowModal] = useState(false);
  /** The frame has fired its `load` event at least once this visit. */
  const [loaded, setLoaded] = useState(false);
  /** The pointer is on the button — holds off the warm-grace teardown. */
  const [hovering, setHovering] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const button = useSound("button");

  // Unmount the frame on every close path, so the next visit loads fresh
  // rather than resuming a stale browsing session. Removing the frame also
  // discards its joint-history entries, leaving the marked barrier as the
  // current entry for the next open to reuse.
  const close = () => {
    setShowModal(false);
    setMounted(false);
    setLoaded(false);
  };

  useEffect(() => {
    if (!showModal) return;

    // The player backed out of the marketplace (its own back button, or any
    // other traversal that reached below the popup). Close on any popstate:
    // the arcade cannot navigate while this overlay is up, so every popstate
    // here means "back was pressed somewhere".
    const onPopState = () => close();

    const onMessage = (event: MessageEvent) => {
      if (event.data?.event !== "closePortal") return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      close();
    };

    window.addEventListener("popstate", onPopState);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("message", onMessage);
    };
  }, [showModal]);

  // A stray browser-back while warming (frame hidden, popup not yet shown)
  // rewinds joint history to the barrier — which unloads the hidden
  // marketplace document back to about:blank. Revealing that frame would show
  // an empty popup, so the dead warm is dropped here and the next open pays
  // for a cold load instead.
  useEffect(() => {
    if (!mounted || showModal) return;

    const onPopState = () => {
      setMounted(false);
      setLoaded(false);
    };

    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [mounted, showModal]);

  // A warmed frame that was never revealed is torn down after the grace
  // period, so a stray hover cannot leave the play app running indefinitely.
  useEffect(() => {
    if (!mounted || showModal || hovering) return;

    const timer = window.setTimeout(() => {
      setMounted(false);
      setLoaded(false);
    }, WARM_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [mounted, showModal, hovering]);

  /**
   * Mount the marketplace frame hidden, pushing the history barrier first.
   *
   * Order is load-bearing: `pushState` is synchronous, the iframe's navigation
   * is not, so the barrier is guaranteed to land in joint history directly
   * below the marketplace's entries no matter when warming starts.
   */
  const warm = () => {
    if (mounted) return;

    // Barrier entry, reused if a previous close left the current entry marked.
    if (!isMarketplaceEntry(window.history.state)) {
      window.history.pushState(
        { nsMarketplacePopup: true } as MarketplaceHistoryState,
        "",
      );
    }

    setMounted(true);
  };

  const openModal = () => {
    button.play();
    // Covers the cold path (a click that somehow skipped pointer intent):
    // warm both pushes the barrier and mounts the frame before reveal.
    warm();
    setShowModal(true);
  };

  return (
    <>
      {/*
        Pointer intent starts the load early. `pointerdown` alone would fire a
        tick before every click on any device; `pointerenter` additionally gives
        desktop players the deciding time between hover and click, which is
        where most of the warm-up win lives. `focus` covers keyboard players
        tabbing to the button. No warm runs without one of these — a boot
        behind the floor shows up as lag in the arcade itself.
      */}
      <div
        className="relative"
        onPointerEnter={() => {
          setHovering(true);
          warm();
        }}
        onPointerLeave={() => setHovering(false)}
        onPointerDown={warm}
        onFocus={warm}
      >
        <RoundButton onClick={openModal}>
          <img
            alt="Marketplace"
            src={tradeIcon}
            className="absolute group-active:translate-y-[2px]"
            style={{
              top: `${PIXEL_SCALE * 2.6}px`,
              left: `${PIXEL_SCALE * 3.4}px`,
              width: `${PIXEL_SCALE * 15.5}px`,
            }}
          />
        </RoundButton>
      </div>

      {/*
        Full-screen overlay mirroring the main game's Portal embed
        (`features/world/ui/portals/Portal.tsx`): fixed inset-0, iframe edge
        to edge. While warming the same container is kept in the DOM but
        `display: none` — moving an iframe between parents would reload it,
        and a hidden iframe still loads, so the app is up by reveal time.
      */}
      {mounted && (
        <div
          className={showModal ? "fixed inset-0 z-[100]" : "hidden"}
          role={showModal ? "dialog" : undefined}
          aria-modal={showModal ? "true" : undefined}
          aria-label="Nightshade Arcade Marketplace"
        >
          <iframe
            ref={iframeRef}
            src={MARKETPLACE_URL}
            title="Nightshade Arcade Marketplace"
            onLoad={() => setLoaded(true)}
            className="absolute inset-0 h-full w-full border-0"
          />

          {/*
            Covers the multi-second boot of the play app: pure black with the
            RavenCoin mark centred — the same coin the HUD balance uses — and
            "Loading..." directly under it. The three dots are the animation:
            staggered `animate-pulse` via animationDelay, since the arcade
            ships no custom keyframes. Removed the moment the iframe fires
            `load` — from there the app paints its own shell.
          */}
          {showModal && !loaded && (
            <div className="absolute inset-0 z-[101] flex flex-col items-center justify-center space-y-4 bg-black">
              <img
                alt=""
                src={ravenCoinIcon}
                className="animate-pulse"
                style={{
                  width: `${PIXEL_SCALE * 26}px`,
                  imageRendering: "pixelated",
                }}
              />
              <div
                className="balance-text flex items-center"
                style={{ fontSize: 14 }}
              >
                <span>Loading</span>
                {[0, 160, 320].map((delay) => (
                  <span
                    key={delay}
                    className="animate-pulse"
                    style={{ animationDelay: `${delay}ms` }}
                  >
                    .
                  </span>
                ))}
              </div>
            </div>
          )}

          {/*
            The X catcher. The deployed marketplace X (top-right of its 70px
            header: `absolute right-2`, ~PIXEL_SCALE*11 square, vertically
            centred in the header) navigates the iframe itself home with
            `replace` — invisible and unactionable from this cross-origin side.
            This transparent hit area covers exactly that corner so the click
            closes the popup. Sized 44x70: the X spans ~8-37px from the right
            edge of a 70px header, so this covers it with margin while staying
            inside the header's `pr-10` right padding — clear of the balance
            display and the navigation tabs below.
          */}
          {showModal && (
            <div
              onClick={close}
              title="Back to the arcade"
              aria-label="Close marketplace"
              className="absolute z-[102] cursor-pointer"
              style={{
                top: "calc(env(safe-area-inset-top, 0px))",
                right: "calc(env(safe-area-inset-right, 0px))",
                width: "44px",
                height: "70px",
              }}
            />
          )}
        </div>
      )}
    </>
  );
};
