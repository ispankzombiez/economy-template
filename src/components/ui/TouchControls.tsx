import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * On-screen controls for the cabinets, for playing on a phone.
 *
 * ## Why these dispatch keyboard events
 *
 * Every arcade cabinet already listens for `ArrowLeft`/`ArrowRight` and polls
 * them for held movement, or takes a direction once on keydown. Rather than
 * teach eleven games a second input path — and then keep it in step with the
 * first — a touch button *is* the key it replaces: it dispatches a real
 * `keydown` when the finger lands and a `keyup` when it lifts, on `window`,
 * which is where the cabinets listen.
 *
 * That makes the behaviour identical to the keyboard by construction. Holding
 * a pad direction moves continuously for the games that poll it, sets a
 * heading for Pac-Man, and stops on release, with no per-game code at all.
 */

/** Keys a cabinet listens for. Anything else is not ours to send. */
const isPlayableKey = (code: string) =>
  code.startsWith("Arrow") || code === "Space";

const dispatchKey = (code: string, down: boolean) => {
  window.dispatchEvent(
    new KeyboardEvent(down ? "keydown" : "keyup", {
      code,
      key: code,
      bubbles: true,
      cancelable: true,
    }),
  );
};

/**
 * Tracks which virtual keys are down and keeps them in step with reality.
 *
 * A key released by lifting the finger, by a cancelled gesture, or by the
 * component unmounting mid-press must never stay stuck down — a stuck
 * `ArrowRight` on a Breakout paddle is a cabinet the player has to close.
 */
export const useHeldKeys = () => {
  const held = useRef<Set<string>>(new Set());

  const press = useCallback((code: string) => {
    if (held.current.has(code)) return;
    held.current.add(code);
    dispatchKey(code, true);
  }, []);

  const release = useCallback((code: string) => {
    if (!held.current.delete(code)) return;
    dispatchKey(code, false);
  }, []);

  const releaseAll = useCallback(() => {
    for (const code of Array.from(held.current)) dispatchKey(code, false);
    held.current.clear();
  }, []);

  useEffect(() => releaseAll, [releaseAll]);

  return { press, release, releaseAll, held };
};

/**
 * Is this a touch-first device?
 *
 * Driven off `(pointer: coarse)` rather than `ontouchstart`, so a phone shows
 * the controls and a desktop does not. A touchscreen laptop reports coarse
 * *and* has a mouse, and gets both — which is the right answer, since the
 * controls cost nothing when ignored.
 */
export const useIsTouchDevice = (): boolean => {
  const [isTouch, setIsTouch] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    setIsTouch(query.matches);
    const onChange = () => setIsTouch(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return isTouch;
};

const CONTROL_CLASS =
  "flex items-center justify-center rounded-lg border-2 border-amber-400/50 " +
  "bg-slate-800/90 font-bold text-amber-200 select-none touch-none " +
  "active:scale-95 active:bg-slate-700/90 transition-transform";

export interface TouchButtonProps {
  /** The key to hold while pressed. */
  code: string;
  label: React.ReactNode;
  /** `ghost` for a secondary action, `accent` for the one that fires. */
  tone?: "ghost" | "accent";
  className?: string;
  onPressChange?: (down: boolean) => void;
  held: ReturnType<typeof useHeldKeys>;
}

/** One held-key button. Holds for as long as the finger stays on it. */
export const TouchButton: React.FC<TouchButtonProps> = ({
  code,
  label,
  tone = "ghost",
  className,
  onPressChange,
  held,
}) => {
  const down = useCallback(
    (pressed: boolean) => {
      if (pressed) held.press(code);
      else held.release(code);
      onPressChange?.(pressed);
    },
    [code, held, onPressChange],
  );

  return (
    <button
      type="button"
      // `capture` so a finger that slides off the button still lifts the key.
      onPointerDown={(event) => {
        event.preventDefault();
        // Capture first so a finger that slides off still lifts the key — but
        // never let it stop the press. `setPointerCapture` throws when the id
        // is not an active pointer, and an exception here would swallow the
        // `keydown` below and leave the button dead to the touch.
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // No live pointer to capture; the pointerup handler still releases.
        }
        down(true);
      }}
      onPointerUp={() => down(false)}
      onPointerCancel={() => down(false)}
      onLostPointerCapture={() => down(false)}
      onContextMenu={(event) => event.preventDefault()}
      className={`${CONTROL_CLASS} ${
        tone === "accent"
          ? "bg-amber-500/90 text-slate-900"
          : "bg-slate-800/90 text-amber-200"
      } ${className ?? ""}`}
    >
      {label}
    </button>
  );
};

export type TouchDirectionName = "up" | "down" | "left" | "right";

export interface TouchAnalogStickProps {
  /** Held through the stick's lifetime, so it shares one key set with the pad. */
  held?: ReturnType<typeof useHeldKeys>;
  /** Diameter of the base ring, in pixels. The thumb scales off this. */
  size?: number;
  className?: string;
}

/** Thumb diameter as a fraction of the base — the floor's 7-on-15. */
const STICK_THUMB_RATIO = 7 / 15;

/**
 * Deadzone as a fraction of the base's radius — the floor's `forceMin: 2` on a
 * radius-15 base, which is the same 13%.
 *
 * Without it a resting thumb reads as a direction, and the player walks off
 * before they have decided to.
 */
const STICK_DEADZONE = 2 / 15;

/**
 * An analog thumbstick, matching the one the **arcade floor** uses.
 *
 * The floor's stick is a Phaser `VirtualJoystick` (`ArcadeTiledScene`), two
 * circles and a `forceMin`. A cabinet is not a Phaser scene, so this reproduces
 * it in the DOM rather than standing a scene up to host one joystick — the
 * geometry, the deadzone and the feel are the floor's, and the output is the same
 * four arrow keys every cabinet already listens for, per the file's whole
 * premise. Nothing downstream can tell the difference.
 *
 * ## Why it beats four buttons here
 *
 * A d-pad is four separate DOM buttons, so a thumb can only reliably hold one:
 * there is no way to walk *and* step into the plane at the same time, which is
 * the single most important thing to do in a beat 'em up. A stick reads two axes
 * at once and so produces diagonals for free — which this game's `x` and `z` are
 * independent axes, so "right and into the plane" is a real move and not a
 * diagonal nobody wants.
 *
 * The thumb is moved by writing `transform` straight to the node rather than
 * through state: this fires on every `pointermove`, and a re-render per frame of
 * the cabinet's control bar is a re-render of the whole screen for a thumb that
 * has not finished being dragged yet.
 */
export const TouchAnalogStick: React.FC<TouchAnalogStickProps> = ({
  held: providedHeld,
  size = 132,
  className,
}) => {
  const ownHeld = useHeldKeys();
  const held = providedHeld ?? ownHeld;

  const baseRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);

  const radius = size / 2;
  const thumbSize = Math.round(size * STICK_THUMB_RATIO);
  // How far the thumb's centre may travel before it pins to the rim.
  const travel = Math.max(0, radius - thumbSize / 2 - 2);

  const apply = useCallback(
    (clientX: number, clientY: number) => {
      const rect = baseRef.current?.getBoundingClientRect();
      if (!rect) return;

      const dx = clientX - (rect.left + rect.width / 2);
      const dy = clientY - (rect.top + rect.height / 2);
      const distance = Math.hypot(dx, dy);

      // Pin to the rim, so the stick cannot be dragged outside its own ring.
      const clamped =
        distance > travel && distance > 0
          ? { x: (dx / distance) * travel, y: (dy / distance) * travel }
          : { x: dx, y: dy };

      if (thumbRef.current) {
        thumbRef.current.style.transform = `translate(${clamped.x}px, ${clamped.y}px)`;
      }

      // `release` before `press` so crossing the deadzone into a new direction
      // does not leave the old one stuck down. Both are Set-guarded, so the
      // redundant calls cost nothing.
      held.release("ArrowLeft");
      held.release("ArrowRight");
      held.release("ArrowUp");
      held.release("ArrowDown");

      if (distance === 0) return;
      const nx = dx / radius;
      const ny = dy / radius;
      if (nx <= -STICK_DEADZONE) held.press("ArrowLeft");
      if (nx >= STICK_DEADZONE) held.press("ArrowRight");
      if (ny <= -STICK_DEADZONE) held.press("ArrowUp");
      if (ny >= STICK_DEADZONE) held.press("ArrowDown");
    },
    [held, radius, travel],
  );

  const reset = useCallback(() => {
    if (thumbRef.current) thumbRef.current.style.transform = "";
    held.release("ArrowLeft");
    held.release("ArrowRight");
    held.release("ArrowUp");
    held.release("ArrowDown");
  }, [held]);

  return (
    <div
      ref={baseRef}
      role="presentation"
      onPointerDown={(event) => {
        event.preventDefault();
        // See `TouchButton`: capture must never be allowed to cost the input.
        try {
          event.currentTarget.setPointerCapture?.(event.pointerId);
        } catch {
          // No live pointer to capture; pointerup still resets.
        }
        apply(event.clientX, event.clientY);
      }}
      onPointerMove={(event) => {
        // Only while a finger is down — without this the cursor drags the stick
        // on a desktop too, fighting the keyboard.
        if (event.buttons === 0) return;
        apply(event.clientX, event.clientY);
      }}
      onPointerUp={reset}
      onPointerCancel={reset}
      onLostPointerCapture={reset}
      onContextMenu={(event) => event.preventDefault()}
      className={`relative flex shrink-0 touch-none select-none items-center justify-center rounded-full border-2 border-amber-400/40 ${className ?? ""}`}
      style={{
        width: size,
        height: size,
        // The floor's own alphas, lifted: 0.2 reads over a Phaser scene and
        // disappears over a photographically busy stage.
        background: "rgba(15, 23, 42, 0.35)",
      }}
    >
      <div
        ref={thumbRef}
        className="pointer-events-none rounded-full"
        style={{
          width: thumbSize,
          height: thumbSize,
          background: "rgba(255, 255, 255, 0.55)",
          boxShadow: "0 1px 4px rgba(0,0,0,0.4)",
          // Centred by the parent's flexbox, then offset by `transform` — so the
          // resting position needs no state and cannot drift from the drag.
        }}
      />
    </div>
  );
};

export interface TouchDPadProps {
  /** Held through the pad's lifetime, so every button shares one key set. */
  held?: ReturnType<typeof useHeldKeys>;
  /**
   * Which directions to offer.
   *
   * Frogger is a one-way trip up the screen: it cannot be walked backwards, so a
   * down button there is a control that cannot do anything. Dropping it from
   * `defaults` leaves the other three in the corners they already occupy, so
   * the pad does not grow a hole in the middle of the thumb's reach.
   */
  directions?: TouchDirectionName[];
  className?: string;
}

/**
 * A directional pad for the games that take a direction: Frogger and Pac-Man.
 *
 * Laid out as a plus rather than four buttons in a row, because on a phone a
 * thumb reaches the corners far more easily than the middle, and a d-pad puts
 * every direction in a corner.
 */
export const TouchDPad: React.FC<TouchDPadProps> = ({
  held: providedHeld,
  directions = ["up", "down", "left", "right"],
  className,
}) => {
  const ownHeld = useHeldKeys();
  const held = providedHeld ?? ownHeld;
  const has = (name: TouchDirectionName) => directions.includes(name);

  const ARROWS: Record<TouchDirectionName, string> = {
    up: "▲",
    down: "▼",
    left: "◀",
    right: "▶",
  };
  const CODES: Record<TouchDirectionName, string> = {
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
  };

  const cell = (
    name: TouchDirectionName,
    placement: string,
  ) =>
    has(name) ? (
      <div className={placement}>
        <TouchButton
          held={held}
          code={CODES[name]}
          label={ARROWS[name]}
          className="h-full w-full text-xl"
        />
      </div>
    ) : null;

  return (
    <div
      className={`grid grid-cols-3 grid-rows-3 gap-1 ${className ?? ""}`}
      style={{ width: 168, height: 168 }}
    >
      {cell("up", "col-start-2 row-start-1")}
      {cell("left", "col-start-1 row-start-2")}
      {/* Only drawn when something is missing, so the centre reads as a nub on a
          full pad rather than an empty hole on a partial one. */}
      {has("down") && (
        <div className="col-start-2 row-start-2 flex items-center justify-center">
          <div className="h-2 w-2 rounded-full bg-amber-400/40" />
        </div>
      )}
      {cell("right", "col-start-3 row-start-2")}
      {cell("down", "col-start-2 row-start-3")}
    </div>
  );
};

export interface TouchMoveBarProps {
  /**
   * The finger's absolute position across the bar, 0 (left) to 1 (right).
   *
   * Absolute rather than a nudge-per-frame, because a paddle that creeps
   * sideways at a fixed rate is a paddle that is always behind the ball. The
   * paddle goes where the finger is instead, which is how every phone Breakout
   * works.
   */
  onScrub: (ratio: number) => void;
  /** Fired on press and on release — launch the ball. */
  onFire?: () => void;
  fireLabel?: string;
  className?: string;
}

/**
 * A scrub strip for the paddle games: Barley Breaker and Goblin Invaders.
 *
 * The strip spans the width of the stage, so the ratio maps straight onto the
 * player's horizontal range.
 */
export const TouchMoveBar: React.FC<TouchMoveBarProps> = ({
  onScrub,
  onFire,
  fireLabel = "LAUNCH",
  className,
}) => {
  const stripRef = useRef<HTMLDivElement>(null);
  const ratioFrom = useCallback(
    (clientX: number) => {
      const rect = stripRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return 0;
      // Un-scaled, so this stays correct however far the stage was shrunk.
      const raw = (clientX - rect.left) / rect.width;
      return Math.min(1, Math.max(0, raw));
    },
    [],
  );

  return (
    <div className={`flex items-stretch gap-2 ${className ?? ""}`}>
      {/* `min-h-[56px]`, not the intrinsic height: a strip with no height of its
          own measured 20px tall on a phone, which is a fifth of the 44px a
          thumb can be relied on to find — and a paddle bar is held, not
          tapped, so it has to be easy to keep a thumb on. */}
      <div
        ref={stripRef}
        role="presentation"
        onPointerDown={(event) => {
          event.preventDefault();
          try {
            event.currentTarget.setPointerCapture?.(event.pointerId);
          } catch {
            // See `TouchButton`: capture failing must not cost the input.
          }
          onScrub(ratioFrom(event.clientX));
        }}
        onPointerMove={(event) => {
          // Only while a finger is down: without the capture check this tracks
          // the cursor on a desktop too, which would fight the keyboard.
          if (event.buttons === 0) return;
          onScrub(ratioFrom(event.clientX));
        }}
        className={`${CONTROL_CLASS} min-h-[56px] flex-1 select-none touch-none text-xs`}
        style={{ background: "rgba(15, 23, 42, 0.6)" }}
      >
        <span className="text-amber-200/60">◀ drag to move ▶</span>
      </div>
      {onFire && (
        <button
          type="button"
          onPointerDown={(event) => {
            event.preventDefault();
            onFire();
          }}
          onContextMenu={(event) => event.preventDefault()}
          className={`${CONTROL_CLASS} min-h-[56px] bg-amber-500/90 px-4 text-xs text-slate-900`}
        >
          {fireLabel}
        </button>
      )}
    </div>
  );
};

/**
 * Renders `controls` only on a touch device.
 *
 * Keeps the phone layout complete without putting an on-screen pad in front of
 * every desktop player, who has a real keyboard.
 */
export const TouchOnly: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const isTouch = useIsTouchDevice();
  if (!isTouch) return null;
  return <>{children}</>;
};
