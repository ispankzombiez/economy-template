import React from "react";
import classNames from "classnames";
import {
  pixelDarkBorderStyle,
  pixelLightBorderStyle,
} from "lib/style";
import { PIXEL_SCALE } from "lib/constants";
import { UI_IMAGES } from "lib/images";
import type { Equipped } from "features/game/types/bumpkin";

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  hasTabs?: boolean;
  tabAlignment?: "top" | "left";
  /** Accepted for parity with main-game panels (optional decoration). */
  bumpkinParts?: Partial<Equipped>;
}

export const InnerPanel: React.FC<
  React.PropsWithChildren<
    React.HTMLAttributes<HTMLDivElement> & {
      divRef?: React.RefObject<HTMLDivElement | null>;
    }
  >
> = ({ children, ...divProps }) => {
  const { className, style, divRef, ...otherDivProps } = divProps;

  return (
    <div
      className={classNames(className)}
      style={{
        ...pixelLightBorderStyle,
        padding: `${PIXEL_SCALE * 1}px`,
        background: "#e4a672",
        ...style,
      }}
      ref={divRef}
      {...otherDivProps}
    >
      {children}
    </div>
  );
};

export const OuterPanel: React.FC<React.PropsWithChildren<PanelProps>> = ({
  children,
  hasTabs,
  tabAlignment = "top",
  // Consumed here (not spread onto the div) so React does not warn about an
  // unknown `bumpkinParts` DOM attribute — callers pass it for parity with the
  // main game, where the panel renders a portrait.
  bumpkinParts: _bumpkinParts,
  ...divProps
}) => {
  const { className, style, ...otherDivProps } = divProps;

  return (
    <div
      className={classNames(className, "bg-[#c28569]")}
      style={{
        ...pixelDarkBorderStyle,
        padding: `${PIXEL_SCALE * 1}px`,
        ...(hasTabs
          ? {
              paddingTop:
                tabAlignment === "top" ? `${PIXEL_SCALE * 15}px` : undefined,
              paddingLeft:
                tabAlignment === "left" ? `${PIXEL_SCALE * 15}px` : undefined,
            }
          : {}),
        ...style,
      }}
      {...otherDivProps}
    >
      {children}
    </div>
  );
};

export const Panel: React.FC<React.PropsWithChildren<PanelProps>> = ({
  children,
  hasTabs,
  ...divProps
}) => {
  return (
    <OuterPanel hasTabs={hasTabs} {...divProps}>
      <InnerPanel>{children}</InnerPanel>
    </OuterPanel>
  );
};

type ButtonPanelProps = React.HTMLAttributes<HTMLDivElement>;

export const ButtonPanel: React.FC<
  ButtonPanelProps & { disabled?: boolean; selected?: boolean }
> = ({ children, disabled, selected, className, style, ...otherDivProps }) => {
  return (
    <div
      className={classNames(
        className,
        "hover:brightness-90 cursor-pointer relative",
        { "opacity-50": !!disabled },
      )}
      style={{
        padding: `${PIXEL_SCALE * 1}px`,
        borderImage: `url(${UI_IMAGES.primaryButton})`,
        borderStyle: "solid",
        borderWidth: "8px 8px 10px 8px",
        borderImageSlice: "3 3 4 3 fill",
        imageRendering: "pixelated",
        borderImageRepeat: "stretch",
        color: "#674544",
        ...style,
      }}
      {...otherDivProps}
    >
      {children}
      {selected && (
        <div
          className="absolute"
          style={{
            borderImage: `url(${UI_IMAGES.selectBox})`,
            borderStyle: "solid",
            borderWidth: "18px 16px 18px",
            borderImageSlice: "9 8 9 8 fill",
            imageRendering: "pixelated",
            borderImageRepeat: "stretch",
            top: `${PIXEL_SCALE * -4}px`,
            right: `${PIXEL_SCALE * -4}px`,
            left: `${PIXEL_SCALE * -4}px`,
            bottom: `${PIXEL_SCALE * -4}px`,
          }}
        />
      )}
    </div>
  );
};
