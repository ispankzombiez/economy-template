import mapJson from "./assets/nightshade_arcade.json";
import customTileset from "./assets/nightshade-arcade-tilesheet.png";
import stairsDown from "./assets/stairs_down.png";
import ravenCoinIcon from "./assets/RavenCoin.webp";
import type { SceneId } from "features/world/sceneIds";
import { ArcadeTiledScene } from "./ArcadeTiledScene";
import { nightshadeArcadeEvents } from "./lib/nightshadeArcadeEvents";
import { PortalNPC } from "./lib/PortalNPC";
import { getNightshadeArcadeSpawn } from "./lib/spawns";

/**
 * Ground floor of the Nightshade Arcade.
 *
 * The staircase in the top-right corner is a warp trigger (see
 * `addStairsWarp`) that drops the player into {@link NightshadeBasementScene}.
 */
export class NightshadeArcadeScene extends ArcadeTiledScene {
  sceneId: SceneId = "nightshade-arcade" as SceneId;

  constructor() {
    super({
      name: "nightshade-arcade" as any,
      map: {
        json: mapJson,
        imageKey: "nightshade-tileset",
      },
      // Fallback only. The step is chosen per-tile from the layer under the
      // player's feet (`resolveWalkStep`), so carpet, the stone floor and the
      // grass outside each get their own sound within this one scene. This
      // answers for anywhere the painted floor does not reach.
      audio: { fx: { walk_key: "wood_footstep" } },
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

  async create() {
    // Scenes are reused by Phaser when they are started again, so clear the
    // transition guard left behind by the last trip to the basement.
    this.isTransitioning = false;

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

    this.add.image(440, 47, "stairs");

    // Walking onto the staircase takes the player down to the basement. The
    // trigger is the sprite's own 32x32 footprint (x 424–456, y 31–63), so
    // standing on the landing south of the Tiled blocker (id50, y63) no longer
    // fires it — the player has to step onto the steps, which are approached
    // from the west, north of that blocker.
    this.addStairsWarp({
      id: "stairs-to-basement",
      x: 424,
      y: 31,
      width: 32,
      height: 32,
      to: "nightshade-arcade-basement",
    });

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

      // The early return skips `super.updatePlayer()`, which is the only thing
      // that tells the walk loop the player has stopped — so the footsteps
      // kept running under the machine's modal. Silence it here.
      this.walkAudioController?.stop();

      return;
    }

    super.updatePlayer();
  }
}
