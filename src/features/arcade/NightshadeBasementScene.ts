import mapJson from "./assets/nightshade_basement.json";
import customTileset from "./assets/nightshade-arcade-tilesheet.png";
import stairsUp from "./assets/stairs_up_flipped.png";
import ravenStatue from "./assets/raven-statue.gif";
import cultistSheet from "./assets/cultist_idle.webp";
import kohiSheet from "./assets/kohi_idle.webp";
import type { SceneId } from "features/world/sceneIds";
import { translate } from "lib/i18n/translate";
import { ArcadeTiledScene } from "./ArcadeTiledScene";
import { npcModalManager } from "./lib/npcModalManager";
import { getNightshadeBasementSpawn } from "./lib/spawns";

/**
 * Both idle sheets (cultist, Kohi) are 180x19 with a 3px transparent gutter
 * every 20px (columns 17–22, 37–42, …), so they are 9 frames of 20x19 —
 * slicing at 18 would tear each figure into two halves.
 */
const IDLE_FRAME_WIDTH = 20;
const IDLE_FRAME_HEIGHT = 19;
const IDLE_LAST_FRAME = 8;
const IDLE_FRAME_RATE = 8;
const CULTIST_IDLE = "cultist-idle";
const KOHI_IDLE = "kohi-idle";

/** Sprite sheet keys, so a figure can be built from either sheet. */
const CULTIST_SHEET = "cultist";
const KOHI_SHEET = "kohi";

/**
 * The downstairs floor of the Nightshade Arcade.
 *
 * A small ritual room rather than a second copy of the floor above: entered
 * from the top-right staircase of {@link NightshadeArcadeScene}, you arrive at
 * the foot of the staircase in the south-east corner and walk up toward the
 * raven statue, the cultists and Kohi. The way back out is those same steps.
 */
export class NightshadeBasementScene extends ArcadeTiledScene {
  sceneId: SceneId = "nightshade-arcade-basement" as SceneId;

  constructor() {
    super({
      name: "nightshade-arcade-basement" as any,
      map: {
        json: mapJson,
        imageKey: "nightshade-tileset",
      },
      // Wood rather than dirt — this floor is inside the building.
      audio: { fx: { walk_key: "wood_footstep" } },
      player: { spawn: getNightshadeBasementSpawn() },
    });
  }

  preload() {
    this.load.image("nightshade-tileset", customTileset);
    this.load.image("stairsUp", stairsUp);
    this.load.image("ravenStatue", ravenStatue);
    this.load.spritesheet(CULTIST_SHEET, cultistSheet, {
      frameWidth: IDLE_FRAME_WIDTH,
      frameHeight: IDLE_FRAME_HEIGHT,
    });
    this.load.spritesheet(KOHI_SHEET, kohiSheet, {
      frameWidth: IDLE_FRAME_WIDTH,
      frameHeight: IDLE_FRAME_HEIGHT,
    });

    super.preload();
  }

  async create() {
    // Scenes are reused by Phaser when they are started again, so clear the
    // transition guard left behind by the last trip back upstairs.
    this.isTransitioning = false;

    super.create();

    this.physics.world.drawDebug = false;
    this.cameras.main.setBackgroundColor("#130b1f");

    // The staircase sits in the south-east corner, resting on top of the south
    // wall rather than sunk into it, with its steps running out to the left
    // across the cultists' side of the room (the tall end belongs against the
    // wall). The wall's tiles only show their art from x=376, so the sprite is
    // pushed to x 344–376 to touch it with no gap.
    //
    // The mirror is baked into `stairs_up_flipped.png` rather than applied with
    // `setFlipX(true)`: this texture is 32x32 (power-of-two), so Phaser uploads
    // it with `REPEAT` wrapping, and a flipped sprite samples exactly at u=1
    // where the texel index wraps to texel 0 — painting the art's opaque left
    // column as a 1px bright seam down the sprite's edge.
    this.add.image(360, 224, "stairsUp");

    // Walking back up the staircase returns the player to the arcade floor.
    // The trigger is exactly the sprite's footprint (x 344–376, y 208–240), so
    // the player has to actually be standing on the steps.
    this.addStairsWarp({
      id: "stairs-to-arcade",
      x: 344,
      y: 208,
      width: 32,
      height: 32,
      to: "nightshade-arcade",
    });

    // Halfway up the back wall: the wall spans y 0–16 and the statue is 48x45
    // with art to the very top of its frame, so a centre of y=30.5 puts its
    // head on y=8 — the wall's midpoint.
    this.createRavenStatue(192, 30.5);

    // Two columns of three, flanking the runner. The left column looks on
    // toward the statue; the right column is turned to face back across it.
    this.createCultist(144, 108);
    this.createCultist(144, 148);
    this.createCultist(144, 188);
    this.createCultist(240, 108, true);
    this.createCultist(240, 148, true);
    this.createCultist(240, 188, true);

    // A pace in front of the statue, turned to face back across the runner as
    // he preaches to the cultists. He moves with the statue (same -8) so the
    // pair keeps the spacing it was approved with.
    this.createKohi(226, 52);
  }

  /** The raven statue standing at the head of the carpet runner. */
  private createRavenStatue(x: number, y: number) {
    const statue = this.add.image(x, y, "ravenStatue");
    statue.setDepth(y);

    // Solid plinth so the player walks around it rather than through it. It
    // runs from the back wall's lower edge down to the statue's feet, not just
    // across the base — with the wall only one tile deep there is a strip
    // between the two, and at 8px tall the player fits through it and ends up
    // hidden behind the statue's head.
    const wallBottom = 16;
    this.addSolid(x - 24, wallBottom, 48, y + 22 - wallBottom);
  }

  /**
   * A hooded cultist idling in the basement.
   *
   * `faceLeft` mirrors the sheet — the right-hand column stands turned toward
   * the statue rather than away from it.
   */
  private createCultist(x: number, y: number, faceLeft = false) {
    const cultist = this.createIdler(CULTIST_SHEET, CULTIST_IDLE, x, y);

    if (faceLeft) cultist.setFlipX(true);

    return cultist;
  }

  /**
   * Kohi, the basement's resident — clickable rather than just scenery.
   *
   * He is mirrored to face left, toward the aisle, and opening his dialog goes
   * through the main game's NPC modal manager, so what appears is the
   * canonical `SpeakingModal` panel, not a bespoke one.
   */
  private createKohi(x: number, y: number) {
    const kohi = this.createIdler(KOHI_SHEET, KOHI_IDLE, x, y);
    kohi.setFlipX(true);

    kohi.setInteractive({ cursor: "pointer" }).on("pointerdown", () => {
      // A drag from the touch joystick is movement, not a conversation.
      if (this.joystick?.pointer) return;

      if (!this.checkDistanceToSprite(kohi, 50)) {
        this.currentPlayer?.speak(translate("base.iam.far.away"));
        return;
      }

      npcModalManager.open("kohi");
    });
  }

  /**
   * Draws one of the 20x19 idle sheets with a body matching the art so the
   * figure stands on the floor instead of floating over it.
   */
  private createIdler(sheet: string, animKey: string, x: number, y: number) {
    if (!this.anims.exists(animKey)) {
      this.anims.create({
        key: animKey,
        frames: this.anims.generateFrameNumbers(sheet, {
          start: 0,
          end: IDLE_LAST_FRAME,
        }),
        frameRate: IDLE_FRAME_RATE,
        repeat: -1,
      });
    }

    const sprite = this.add.sprite(x, y, sheet).play(animKey);
    sprite.setDepth(y);

    // Block their feet so they read as standing on the floor. The art sits in
    // columns 3–16 of the 20px frame, so the box matches that footprint.
    this.physics.world.enable(sprite);
    const body = sprite.body as Phaser.Physics.Arcade.Body;
    body.setImmovable(true).setSize(14, 10).setOffset(3, 9);

    this.colliders?.add(sprite);

    return sprite;
  }

  /** Adds an invisible, immovable rectangle to the scene's colliders. */
  private addSolid(x: number, y: number, width: number, height: number) {
    const solid = this.add.zone(
      x + width / 2,
      y + height / 2,
      width,
      height,
    );

    this.physics.world.enable(solid);
    (solid.body as Phaser.Physics.Arcade.Body).setImmovable(true);

    this.colliders?.add(solid);
  }
}
