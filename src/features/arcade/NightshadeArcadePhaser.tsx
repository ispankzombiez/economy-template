import React, { useEffect, useRef } from "react";
import { Game, AUTO } from "phaser";
import NinePatchPlugin from "phaser3-rex-plugins/plugins/ninepatch-plugin.js";
import VirtualJoystickPlugin from "phaser3-rex-plugins/plugins/virtualjoystick-plugin.js";

import { Preloader } from "features/world/scenes/Preloader";
import { NightshadeArcadeScene } from "./NightshadeArcadeScene";
import { NightshadeBasementScene } from "./NightshadeBasementScene";
import { useMinigameSession } from "lib/portal";
import { MMO_SERVER_REGISTRY_KEY, useMmoRoom } from "lib/mmo";

export const NightshadeArcadePhaser: React.FC = () => {
  const { farmId, farm, playerData } = useMinigameSession();
  // The plaza room joins on the React side — `ArcadeBaseScene` reads it from
  // the Phaser registry, which is how the other players on the map arrive.
  const { room } = useMmoRoom();
  const bumpkin = (farm as any)?.bumpkin;
  // The name tag under the bumpkin must be the player's display name. When the
  // session/JWT carries none, leave this undefined so ArcadeBaseScene renders
  // `#<farmId>` (matching the HUD's `Farmer #<farmId>`) instead of coercing a
  // bare id into the tag, which reads as a raw player number.
  const username = playerData?.resolvedProfile?.username;
  const game = useRef<Game>(undefined);
  // Latest room, readable from inside the game-creating effect so a restart
  // (session identity changing) hands over the room that is live *now*.
  const roomRef = useRef(room);
  roomRef.current = room;

  console.log("[BumpkinDiag] farm.bumpkin raw:", JSON.stringify(farm?.bumpkin));
  console.log("[BumpkinDiag] full farm:", JSON.stringify(farm));

  const scene = "nightshade-arcade";
  // The basement is a separate floor of the arcade, swapped in by the
  // top-right staircase (see ArcadeBaseScene.switchScene).
  const scenes: any[] = [Preloader, NightshadeArcadeScene, NightshadeBasementScene];

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

    // Dev-only handle: the one way to reach the live Phaser game (and its
    // scenes / registry) from the console while testing locally. `import.meta.env.DEV`
    // is false in a hosted build, so nothing is exposed once shipped.
    if (import.meta.env.DEV) {
      (window as unknown as { __nightshadeGame?: Game }).__nightshadeGame =
        game.current;
    }

    game.current.registry.set("initialScene", scene);
    game.current.registry.set("gameState", { bumpkin });
    game.current.registry.set("id", farmId);
    game.current.registry.set("username", username);

    if (roomRef.current) {
      game.current.registry.set(MMO_SERVER_REGISTRY_KEY, roomRef.current);
    }

    return () => {
      game.current?.registry.remove(MMO_SERVER_REGISTRY_KEY);
      game.current?.destroy(true);
      game.current = undefined;

      if (import.meta.env.DEV) {
        delete (window as unknown as { __nightshadeGame?: Game })
          .__nightshadeGame;
      }
    };
  }, [bumpkin, farmId, username]);

  // Hand the room over whenever it connects or reconnects. The scenes read the
  // registry on every frame, so a room that turns up after the game started
  // needs no restart — the other players simply appear.
  useEffect(() => {
    const registry = game.current?.registry;
    if (!registry) return;

    if (room) {
      registry.set(MMO_SERVER_REGISTRY_KEY, room);
    } else {
      registry.remove(MMO_SERVER_REGISTRY_KEY);
    }
  }, [room]);

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
