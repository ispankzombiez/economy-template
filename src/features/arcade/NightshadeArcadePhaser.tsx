import React, { useEffect, useRef } from "react";
import { Game, AUTO } from "phaser";
import NinePatchPlugin from "phaser3-rex-plugins/plugins/ninepatch-plugin.js";
import VirtualJoystickPlugin from "phaser3-rex-plugins/plugins/virtualjoystick-plugin.js";

import { Preloader } from "features/world/scenes/Preloader";
import { NightshadeArcadeScene } from "./NightshadeArcadeScene";
import { useMinigameSession } from "lib/portal";

export const NightshadeArcadePhaser: React.FC = () => {
  const { farmId, farm, playerData } = useMinigameSession();
  const bumpkin = (farm as any)?.bumpkin;
  // The name tag under the bumpkin must be the player's display name. When the
  // session/JWT carries none, leave this undefined so ArcadeBaseScene renders
  // `#<farmId>` (matching the HUD's `Farmer #<farmId>`) instead of coercing a
  // bare id into the tag, which reads as a raw player number.
  const username = playerData?.resolvedProfile?.username;
  const game = useRef<Game>(undefined);

  console.log("[BumpkinDiag] farm.bumpkin raw:", JSON.stringify(farm?.bumpkin));
  console.log("[BumpkinDiag] full farm:", JSON.stringify(farm));

  const scene = "nightshade-arcade";
  const scenes: any[] = [Preloader, NightshadeArcadeScene];

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
    game.current.registry.set("gameState", { bumpkin });
    game.current.registry.set("id", farmId);
    game.current.registry.set("username", username);

    return () => {
      game.current?.destroy(true);
    };
  }, [bumpkin, farmId, username]);

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
