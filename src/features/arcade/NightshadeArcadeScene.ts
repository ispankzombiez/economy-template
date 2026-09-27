import mapJson from "./assets/nightshade_arcade.json";
import customTileset from "./assets/nightshade-arcade-tilesheet.png";
import stairsDown from "./assets/stairs_down.png";
import ravenCoinIcon from "./assets/RavenCoin.webp";
import type { SceneId } from "features/world/sceneIds";
import { isTouchDevice } from "features/world/lib/device";
import { ArcadeBaseScene } from "./ArcadeBaseScene";
import { translate } from "lib/i18n/translate";
import VirtualJoystick from "phaser3-rex-plugins/plugins/virtualjoystick.js";
import {
  minigamesEventEmitter,
  type MinigameType,
} from "./lib/minigamesEvents";
import { getGameIdForMachine } from "./data/machineMap";
import { nightshadeArcadeEvents } from "./lib/nightshadeArcadeEvents";
import { PortalNPC } from "./lib/PortalNPC";
import { getNightshadeArcadeSpawn } from "./lib/spawns";

export class NightshadeArcadeScene extends ArcadeBaseScene {
  sceneId: SceneId = "nightshade-arcade" as SceneId;

  constructor() {
    super({
      name: "nightshade-arcade" as any,
      map: {
        json: mapJson,
        imageKey: "nightshade-tileset",
      },
      audio: { fx: { walk_key: "dirt_footstep" } },
      player: { spawn: getNightshadeArcadeSpawn() },
    });
  }

  preload() {
    // Load custom arcade tilesheet with unique key
    this.load.image("nightshade-tileset", customTileset);
    this.load.image("stairs", stairsDown);
    this.load.image("ravenCoinIcon", ravenCoinIcon);

    super.preload();
  }

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
    this.map = this.make.tilemap({ key: "nightshade-arcade" });

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

  async create() {
    super.create();

    // Disable all debug rendering
    this.physics.world.drawDebug = false;

    // Ensure bright lighting — remove any dark post-processing pipelines
    try {
      const pipelines = [...this.cameras.main.postPipelines];
      pipelines.forEach((pipeline) => {
        try {
          this.cameras.main.removePostPipeline(pipeline);
        } catch (e) {
          // Ignore removal errors
        }
      });
    } catch (e) {
      // Ignore if no pipelines exist
    }

    this.cameras.main.setBackgroundColor("#130b1f");

    const _stairs = this.add.image(440, 47, "stairs");

    // Create Raven NPC as the shop keeper with dynamic animation
    const ravenNpc = new PortalNPC(this, 60, 85, "raven");

    // Make Raven clickable to open shop
    ravenNpc.setInteractive({ cursor: "pointer" }).on("pointerdown", () => {
      if (this.checkDistanceToSprite(ravenNpc as any, 50)) {
        nightshadeArcadeEvents.emitOpenShop();
      }
    });

    // RavenCoin icon display
    this.add.image(60, 103.5, "ravenCoinIcon").setScale(1);

    // Handle clickable daily chests from the Tiled map
    const objectLayer = this.map.getObjectLayer("Collision");

    if (objectLayer) {
      objectLayer.objects.forEach((obj: any) => {
        if (obj.name && obj.name.toLowerCase() === "daily chest") {
          const chestX = obj.x + obj.width / 2;
          const chestY = obj.y + obj.height / 2;

          const chestZone = this.add.zone(
            chestX,
            chestY,
            obj.width,
            obj.height,
          );

          chestZone
            .setInteractive({ cursor: "pointer" })
            .on("pointerdown", () => {
              if (this.joystick?.pointer) return;

              if (this.checkDistanceToSprite(chestZone as any, 50)) {
                nightshadeArcadeEvents.emitChestClicked();
              }
            });
        }
      });
    }
  }

  updatePlayer(): void {
    if (nightshadeArcadeEvents.isMinigameActive) {
      const body = this.currentPlayer?.body as Phaser.Physics.Arcade.Body | undefined;
      body?.setVelocity(0, 0);
      return;
    }

    super.updatePlayer();
  }
}
