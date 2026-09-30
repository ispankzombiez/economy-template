import VirtualJoystick from "phaser3-rex-plugins/plugins/virtualjoystick.js";

import type { SceneId } from "features/world/sceneIds";
import { isTouchDevice } from "features/world/lib/device";
import { translate } from "lib/i18n/translate";
import { ArcadeBaseScene } from "./ArcadeBaseScene";
import { getGameIdForMachine } from "./data/machineMap";
import {
  minigamesEventEmitter,
  type MinigameType,
} from "./lib/minigamesEvents";

/**
 * Shared plumbing for both floors of the Nightshade Arcade.
 *
 * Both floors are Tiled maps drawn with the arcade's own tilesheet, which uses
 * margin 0 / spacing 0 (the base scene assumes Sunnyside's margin 1 / spacing 2,
 * hence the override) and both want a touch joystick, so the wiring lives here
 * and each floor only supplies its own map JSON.
 */
export abstract class ArcadeTiledScene extends ArcadeBaseScene {
  /** Stops the stairs trigger firing twice before the fade-out starts. */
  protected isTransitioning = false;

  override initialiseControls() {
    if (isTouchDevice()) {
      const { centerX, centerY, height } = this.cameras.main;
      this.joystick = new VirtualJoystick(this, {
        x: centerX,
        y: centerY - 35 + height / this.zoom / 2,
        radius: 15,
        base: this.add.circle(0, 0, 15, 0x000000, 0.2).setDepth(1000000000),
        thumb: this.add.circle(0, 0, 7, 0xffffff, 0.2).setDepth(1000000000),
        forceMin: 2,
      });
    }

    super.initialiseControls();
  }

  // Override initialiseMap to use correct margin/spacing for custom arcade tilesheet
  initialiseMap() {
    this.map = this.make.tilemap({ key: this.scene.key });

    // Add tileset with margin:0, spacing:0 (custom arcade tilesheet settings)
    const tileset = this.map.addTilesetImage(
      "Sunnyside V3",
      "nightshade-tileset",
      16,
      16,
      0, // margin: 0
      0, // spacing: 0
    ) as Phaser.Tilemaps.Tileset;

    // Set up collider layers
    this.colliders = this.add.group();

    // `ArcadeBaseScene.renderPlayers` tests this group every frame to hide
    // players behind the club-house layer. Neither arcade map has a `Hidden`
    // object layer, so it stays an empty group — but it still has to exist.
    this.hiddenColliders = this.add.group();

    if (this.map.getObjectLayer("Collision")) {
      const collisionPolygons = this.map.createFromObjects("Collision", {
        scene: this,
      });
      collisionPolygons.forEach((polygon) => {
        this.colliders?.add(polygon);
        this.physics.world.enable(polygon);
        (polygon.body as Phaser.Physics.Arcade.Body).setImmovable(true);
      });
    }

    // Setup interactable layers
    if (this.map.getObjectLayer("Collision")) {
      const interactablesPolygons = this.map.createFromObjects("Collision", {});
      interactablesPolygons.forEach((polygon) => {
        const name = (polygon as any).name;

        // Only make machines and special objects interactive
        if (
          name?.includes("Machine") ||
          name === "daily chest" ||
          name?.includes("prize desk")
        ) {
          polygon
            .setInteractive({ cursor: "pointer" })
            .on("pointerdown", (p: Phaser.Input.Pointer) => {
              if (this.joystick?.pointer) return;

              if (p.downElement.nodeName === "CANVAS") {
                const distance = Phaser.Math.Distance.BetweenPoints(
                  this.currentPlayer as any,
                  polygon as Phaser.GameObjects.Polygon,
                );

                if (distance > 50) {
                  this.currentPlayer?.speak(translate("base.iam.far.away"));
                  return;
                }

                // Exact lookup via data/machineMap.ts — avoids the old
                // `Machine 1` vs `Machine 10` prefix trap and keeps every
                // cabinet (1–16) mapped in one editable place.
                const gameId = getGameIdForMachine(name);

                if (gameId) {
                  minigamesEventEmitter.emit({ type: gameId as MinigameType });
                }
              }
            });
        }
      });
    }

    // Create all tile layers for rendering
    this.map.layers.forEach((layerData) => {
      const layer = this.map.createLayer(layerData.name, [tileset], 0, 0);
      this.layers[layerData.name] = layer as Phaser.Tilemaps.TilemapLayer;
    });

    // Set physics world bounds to match the tilemap dimensions
    this.physics.world.setBounds(
      0,
      0,
      this.map.width * 16,
      this.map.height * 16,
    );

    this.triggerColliders = this.add.group();

    if (!this.map.getObjectLayer("Trigger")) return;

    this.map.getObjectLayer("Trigger")?.objects.forEach((trigger) => {
      const polygon = this.add.polygon(
        trigger.x as number,
        trigger.y as number,
        trigger.polygon as unknown as number[][],
        0xff0000,
        0,
      );

      polygon.data.set("name", trigger.name);

      this.triggerColliders?.add(polygon);
    });
  }

  /**
   * Registers an invisible physics zone that warps the player to another
   * arcade floor while they are walking over it (the Tiled `warp` objects in
   * the wider game are not used here — these floors ship their own map JSONs).
   */
  protected addStairsWarp(options: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    to: SceneId;
  }) {
    const { id, x, y, width, height, to } = options;

    // Zones render nothing — they only exist as a physics rectangle.
    const zone = this.add.zone(x + width / 2, y + height / 2, width, height);
    zone.setData("id", id);

    this.physics.world.enable(zone);
    (zone.body as Phaser.Physics.Arcade.Body).setImmovable(true);
    this.triggerColliders?.add(zone);

    this.onCollision[id] = () => {
      if (this.isTransitioning || !this.currentPlayer?.isWalking) return;

      this.isTransitioning = true;
      this.changeScene(to);
    };
  }
}
