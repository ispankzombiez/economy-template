import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

/**
 * Room the popup's own padding takes, plus the gap the stage keeps from the
 * screen edge.
 */
const FRAME_PADDING = 32;

/**
 * Below this the playfield is too small to aim in, so a very short window gets a
 * small board rather than a board scaled to nothing. Sized off Pac-Man's maze at
 * a 360px-wide phone: 560px of maze scaled to fit 328px is 0.59, so the floor
 * only engages on a viewport shorter than a landscape phone.
 */
const DEFAULT_MIN_SCALE = 0.4;

const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * An element's usable inner width.
 *
 * `clientWidth` already excludes the border and the scrollbar but **includes
 * padding**, and padding is exactly the chrome a board has to fit inside.
 */
const contentWidthOf = (element: HTMLElement): number => {
  const style = window.getComputedStyle(element);
  return (
    element.clientWidth -
    (parseFloat(style.paddingLeft) || 0) -
    (parseFloat(style.paddingRight) || 0)
  );
};

export interface FitStageProps {
  /** Logical playfield width. Fixed — gameplay must never be derived from it. */
  width: number;
  /** Logical playfield height. */
  height: number;
  /**
   * A floor on how far a **short window** may shrink the playfield.
   *
   * It does not apply to width — see the note at the scale computation. Width is
   * always fitted exactly, so this can never push a board off the side of its
   * container.
   */
  minScale?: number;
  /**
   * The unscaled height the stage shares the screen with — the run header, the
   * HUD, the hint line under the board.
   *
   * `FitStage` sums its own siblings to work this out, which is the shape every
   * cabinet already uses: a root holding a header, the board and a footer. Pass
   * a ref for anything that does not fit that shape.
   *
   * This is measured rather than assumed on purpose. A hardcoded reserve is
   * correct only for the one window it was guessed at, and the first thing a
   * narrower viewport does is wrap the header onto a second line — so the
   * guess is wrong precisely when it matters.
   */
  chromeRef?: React.RefObject<HTMLElement | null>;
  /** Extra unscaled height to hold back for chrome the above misses. */
  reserve?: number;
  className?: string;
  /**
   * Reports the scale, so a pointer handler can divide it back out of
   * `getBoundingClientRect` deltas.
   */
  onScale?: (scale: number) => void;
  children: React.ReactNode;
}

/**
 * Scales a fixed-size playfield down to fit the space a phone actually has.
 *
 * ## Why scale rather than reflow
 *
 * A cabinet's geometry — the maze, the brick field, the grid — is written in
 * fixed logical pixels, and the physics reads those constants every frame.
 * Re-deriving them from a measured container would mean a playfield that
 * changes size mid-run: a Pac-Man maze with a different tile count, a paddle
 * that is suddenly narrower than the ball it is trying to bounce. So the
 * playfield renders at its logical size and is *scaled* to fit, which is why
 * every pointer handler has to divide the scale back out — `getBoundingClientRect`
 * reports the scaled box, and without that division a tap is off by exactly the
 * factor the board was shrunk by.
 *
 * ## What it measures
 *
 * Width comes from the container, not from `window.innerWidth`. Inside the
 * arcade the container is the `max-w-md` popup, which is narrower than a 760px
 * arena even on a desktop monitor — measuring the window would report "it fits"
 * for a playfield that is in fact being clipped.
 */
export const FitStage: React.FC<FitStageProps> = ({
  width,
  height,
  minScale = DEFAULT_MIN_SCALE,
  chromeRef,
  reserve = 0,
  className,
  onScale,
  children,
}) => {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  const measure = useCallback(() => {
    const frame = frameRef.current;
    if (!frame) return;

    // The width comes from the nearest box the layout sizes, walking up from
    // the frame — **not** from a constant.
    //
    // The first attempt budgeted `dialog.clientWidth - 32`, which is wrong by
    // however much chrome sits between the dialog and the board: on a 358px
    // phone the shell alone costs `p-2` plus the OuterPanel and InnerPanel
    // borders and padding, about 36px, and Raven Bubbles adds `p-4` on top for
    // 68. That under-budget cut the right-hand 12–15px off every board, which
    // `elementFromPoint` confirmed was not merely overflow but genuinely
    // unreachable. Measuring the real container instead charges for all of it.
    //
    // Inline boxes are skipped on the way up because they size themselves to
    // their content, so one of them would simply echo the frame's own width
    // back and the budget could never shrink. A block, flex or grid box is
    // sized by its parent, which makes it the first honest measurement.
    const availableWidth = (() => {
      let node: HTMLElement | null = frame.parentElement;
      while (node) {
        const display = window.getComputedStyle(node).display;
        if (
          display === "block" ||
          display === "flex" ||
          display === "grid" ||
          display === "flow-root"
        ) {
          return contentWidthOf(node);
        }
        node = node.parentElement;
      }
      return window.innerWidth - FRAME_PADDING;
    })();
    if (availableWidth <= 0) return;

    // Everything sharing the row with the stage.
    const siblings = frame.parentElement
      ? Array.from(frame.parentElement.children)
      : [];
    const siblingChrome = siblings
      .filter((child) => child !== frame)
      .reduce<number>(
        (total, node) => total + (node as HTMLElement).offsetHeight,
        0,
      );

    const chromeHeight = chromeRef?.current
      ? chromeRef.current.getBoundingClientRect().height
      : siblingChrome;

    const availableHeight =
      window.innerHeight - chromeHeight - reserve - FRAME_PADDING;
    if (availableHeight <= 0) return;

    // Width is honoured exactly; the floor guards **only** the height budget.
    //
    // Applying `minScale` to the combined minimum was a real bug: a floor is a
    // constant, but the width a board actually gets is not — it depends on every
    // border and padding between the stage and the screen edge, which on a 320px
    // phone came to 46px rather than the 32px the floor was derived from. So the
    // floor ended up demanding a scale *wider* than the container allowed and
    // pushed 9–15px of board past the edge, unreachable without a sideways
    // scroll. A floor exists to stop a short window shrinking a board to a smear,
    // which is a height problem; width is never in question, so it never gets a
    // vote.
    const widthScale = availableWidth / width;
    const heightScale = availableHeight / height;

    // `setScale` bails out on an equal value, so this is cheap to call on every
    // resize event.
    setScale(Math.min(1, widthScale, Math.max(minScale, heightScale)));
  }, [chromeRef, height, minScale, reserve, width]);

  // Measured before paint, so the first frame the player sees is already the
  // right size rather than a full-size board that snaps down a tick later.
  useIsomorphicLayoutEffect(measure, [measure]);

  useEffect(() => {
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);

    const observed = chromeRef?.current;
    const observer =
      observed && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    if (observed && observer) observer.observe(observed);

    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      observer?.disconnect();
    };
  }, [chromeRef, measure]);

  useEffect(() => {
    onScale?.(scale);
  }, [onScale, scale]);

  return (
    <div
      ref={frameRef}
      className={`mx-auto shrink-0 ${className ?? ""}`}
      // Reserves the scaled footprint, so the scaled playfield below does not
      // leave a block of dead space underneath it.
      style={{ width: width * scale, height: height * scale }}
    >
      <div
        className="relative"
        style={{
          width,
          height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          // Without this a drag across the board scrolls the page on a phone
          // instead of moving whatever the player is dragging.
          touchAction: "none",
        }}
      >
        {children}
      </div>
    </div>
  );
};

/**
 * Divides a client coordinate back into the playfield's logical pixels.
 *
 * Every pointer handler that converts a screen position into a board position
 * needs this: the stage is scaled, so the rect it measures is the scaled box
 * and the delta has to be divided back out before it means anything.
 */
export const toLogicalPoint = (
  rect: DOMRect,
  clientX: number,
  clientY: number,
  scale: number,
): { x: number; y: number } => ({
  x: (clientX - rect.left) / scale,
  y: (clientY - rect.top) / scale,
});
