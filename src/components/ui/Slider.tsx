import React, { ChangeEvent } from "react";
import classNames from "classnames";

import trackBorder from "assets/ui/input_box_border.png";

type Props = {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onValueChange: (value: number) => void;
  className?: string;
  /** Accessible name, since the control has no visible label of its own. */
  ariaLabel?: string;
  /** Dims the control without disabling it — used when it has no effect yet. */
  inactive?: boolean;
};

/**
 * Horizontal slider in the panel's pixel style.
 *
 * ## Why a real `<input type="range">` underneath
 *
 * The visible track and thumb are divs, but the element taking the pointer and
 * the keyboard is a native range input made transparent on top of them. That
 * buys drag, click-to-position, arrow keys, Home/End and screen-reader
 * semantics for free — all of which a div-and-pointer-events version has to
 * reimplement, and usually gets subtly wrong.
 *
 * `accent-color` cannot help here: it only tints a native track, and the track
 * we want is the one Phaser-style art above it.
 *
 * The native input sits at `opacity-0`, not `display: none` or
 * `visibility: hidden` — either of those would remove it from the tab order and
 * take the keyboard behaviour with it.
 */
export const Slider: React.FC<Props> = ({
  value,
  min = 0,
  max = 1,
  step = 0.01,
  onValueChange,
  className,
  ariaLabel,
  inactive = false,
}) => {
  const span = max - min;
  // `span` is guarded so a bad min/max cannot produce NaN on the fill width.
  const percent = span > 0 ? ((value - min) / span) * 100 : 0;

  return (
    <div
      className={classNames(
        "relative",
        inactive ? "opacity-50" : undefined,
        className,
      )}
      style={{ height: "26px" }}
    >
      {/* Track: the same 9-slice border the text `Input` uses, so the two sit
          together without looking borrowed. */}
      <div
        className="absolute inset-0"
        style={{
          borderStyle: "solid",
          borderImage: `url(${trackBorder})`,
          borderWidth: "10px",
          borderImageSlice: "4 fill",
          borderImageRepeat: "stretch",
          imageRendering: "pixelated",
          boxSizing: "border-box",
        }}
      />

      {/* Fill. Inset past the border so it sits inside the frame rather than
          under it. */}
      <div
        className="absolute overflow-hidden"
        style={{
          top: "10px",
          bottom: "10px",
          left: "10px",
          right: "10px",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            width: `${Math.min(Math.max(percent, 0), 100)}%`,
            height: "100%",
            background: "#4a2f3a",
          }}
        />
      </div>

      {/* Thumb, centred on the value. `translateX(-50%)` puts the middle of the
          knob on the fill edge instead of its left side. */}
      <div
        className="pointer-events-none absolute"
        style={{
          top: "50%",
          left: `${Math.min(Math.max(percent, 0), 100)}%`,
          transform: "translate(-50%, -50%)",
          width: "10px",
          height: "18px",
          background: "#f6e3c5",
          border: "2px solid #4a2f3a",
          boxSizing: "border-box",
        }}
      />

      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        onChange={(e: ChangeEvent<HTMLInputElement>) =>
          onValueChange(Number(e.target.value))
        }
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        style={{ margin: 0, padding: 0 }}
      />
    </div>
  );
};