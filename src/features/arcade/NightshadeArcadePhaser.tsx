import React, { useEffect, useMemo, useRef } from "react";
import { Game, AUTO } from "phaser";
import NinePatchPlugin from "phaser3-rex-plugins/plugins/ninepatch-plugin.js";
import VirtualJoystickPlugin from "phaser3-rex-plugins/plugins/virtualjoystick-plugin.js";

import { Preloader } from "features/world/scenes/Preloader";
import { NightshadeArcadeScene } from "./NightshadeArcadeScene";
import { useMinigameSession } from "lib/portal";
import type { GuestBumpkinJoin } from "lib/mmo/types";
import { tokenUriBuilder, type BumpkinParts } from "lib/utils/tokenUriBuilder";

export const NightshadeArcadePhaser: React.FC = () => {
  const { farmId, farm, playerData } = useMinigameSession();
  const username = playerData?.resolvedProfile?.username ?? undefined;
  const game = useRef<Game>(undefined);

  const scene = "nightshade-arcade";
  const scenes: any[] = [Preloader, NightshadeArcadeScene];
  const bumpkin = useMemo<GuestBumpkinJoin>(() => {
    const b = farm?.bumpkin as
      | { equipped?: Record<string, string>; experience?: number; id?: number }
      | undefined;

    const equipped = b?.equipped ?? {};

    // Only include slots that have a real item name; omit empty/missing values
    const cleanEquipped = Object.fromEntries(
      Object.entries(equipped).filter(([, v]) => !!v)
    ) as GuestBumpkinJoin["equipped"];

    const tokenParts = tokenUriBuilder(cleanEquipped as unknown as BumpkinParts);

    return {
      equipped: cleanEquipped,
      experience: b?.experience ?? 0,
      id: b?.id ?? 0,
      skills: {},
      tokenUri: tokenParts,
      achievements: {},
    };
  }, [farm?.bumpkin]);

  useEffect(() => {
    const config: Phaser.Types.Core.GameConfig = {
      type: AUTO,
      fps: {
        target: 30,
        smoothStep: true,
      },
      backgroundColor: "#000000",
      parent: "game-content",
      autoRound: true,
      pixelArt: true,
      plugins: {
        global: [
          {
            key: "rexNinePatchPlugin",
            plugin: NinePatchPlugin,
            start: true,
          },
          {
            key: "rexVirtualJoystick",
            plugin: VirtualJoystickPlugin,
            start: true,
          },
        ],
      },
      width: window.innerWidth,
      height: window.innerHeight,
      physics: {
        default: "arcade",
        arcade: {
          debug: false,
          gravity: { x: 0, y: 0 },
        },
      },
      scene: scenes,
      loader: {
        crossOrigin: "anonymous",
      },
    };

    game.current = new Game(config);

    game.current.registry.set("initialScene", scene);
    game.current.registry.set("gameState", {
      bumpkin,
      username,
    });
    game.current.registry.set("id", farmId);

    return () => {
      game.current?.destroy(true);
    };
  }, [bumpkin, farmId]);

  const ref = useRef<HTMLDivElement>(null);

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: 10,
      }}
    >
      <div
        id="game-content"
        ref={ref}
        style={{
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
};
