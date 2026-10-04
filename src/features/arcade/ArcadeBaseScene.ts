import Phaser, { Physics } from "phaser";

import VirtualJoystick from "phaser3-rex-plugins/plugins/virtualjoystick.js";

import { BumpkinContainer } from "features/world/containers/BumpkinContainer";
import { NPCName, NPC_WEARABLES } from "lib/npcs";
import { BumpkinParts } from "lib/utils/tokenUriBuilder";
import { SPAWNS } from "features/world/lib/spawn";
import {
  AudioController,
  WalkAudioController,
  type WalkSoundMap,
} from "features/world/lib/AudioController";
import { createErrorLogger } from "lib/errorLogger";
import { Footsteps } from "example-assets/sound-effects/soundEffects";
import {
  FOOTSTEP_BY_SURFACE,
  SURFACE_BY_LAYER,
} from "./lib/walkSurfaces";
import type { SceneId } from "features/world/sceneIds";
import type { Player, PlazaRoomState } from "features/world/types/Room";
import { translate } from "lib/i18n/translate";
import { npcModalManager } from "./lib/npcModalManager";

/** Minimal shape previously wired through xstate interpreters. */
type MMOMachineInterpreter = {
  send: (type: string, payload?: unknown) => void;
  state: { context: { previousSceneId?: SceneId } };
};

type EventObject = { type: string };

import defaultTilesetConfig from "example-assets/map/tileset.json";

import {
  AUDIO_MUTED_EVENT,
  getAudioMutedSetting,
} from "lib/utils/hooks/useIsAudioMuted";
import { patchGameState } from "lib/gameStore";

const SQUARE_WIDTH = 16;

type Coordinates = { x: number; y: number; facing?: "left" | "right" };
type FactionName = "sunflorians" | "bumpkins" | "goblins" | "nightshades";

// Stub modal managers - SFL world UI has been removed. NPC dialogs are the
// exception: they are wired up for real in `lib/npcModalManager.ts`.
const interactableModalManager = { open: (_id: string) => {} };
const playerModalManager = {
  open: (_opts: { id: number; clothing: any; experience: number }) => {},
};

export const WALKING_SPEED = 40;

export type NPCBumpkin = {
  x: number;
  y: number;
  npc: NPCName;
  direction?: "left" | "right";
  clothing?: BumpkinParts;
  onClick?: () => void;
};

// 3 Times per second send position to server
const SEND_PACKET_RATE = 10;
const NAME_TAG_OFFSET_PX = 12;

type BaseSceneOptions = {
  name: SceneId;
  map: {
    tilesetUrl?: string;
    json: any;
    padding?: [number, number];
    imageKey?: string;
    defaultTilesetConfig?: any;
  };
  mmo?: {
    enabled: boolean;
    url?: string;
    serverId?: string;
    sceneId?: string;
  };
  controls?: {
    enabled: boolean; // Default to true
  };
  audio?: {
    fx: {
      /**
       * Fallback step, used when the player is standing somewhere no ground
       * layer covers (off the edge of the painted floor, or on a ground layer
       * that has no row in `SURFACE_BY_LAYER`).
       *
       * Which sound actually plays is decided per-tile by
       * `resolveWalkStep`; this is only the "don't know" answer.
       */
      walk_key: Footsteps;
    };
  };
  player?: {
    spawn: Coordinates;
  };
};

export const FACTION_NAME_COLORS: Record<FactionName, string> = {
  sunflorians: "#fee761",
  bumpkins: "#528ec9",
  goblins: "#669c82",
  nightshades: "#a878ac",
};

export abstract class ArcadeBaseScene extends Phaser.Scene {
  abstract sceneId: SceneId;
  eventListener?: (event: EventObject) => void;

  public joystick?: VirtualJoystick;
  private switchToScene?: SceneId;
  private options: Required<BaseSceneOptions>;

  public map: Phaser.Tilemaps.Tilemap = {} as Phaser.Tilemaps.Tilemap;

  npcs: Partial<Record<NPCName, BumpkinContainer>> = {};

  currentPlayer: BumpkinContainer | undefined;
  isFacingLeft = false;
  movementAngle: number | undefined;
  serverPosition: { x: number; y: number } = { x: 0, y: 0 };
  packetSentAt = 0;
  /**
   * Scene key carried by the last position packet. A floor swap has to be
   * re-announced even when the player lands on the exact spot they left,
   * because the room only mirrors players whose `sceneId` matches the scene
   * you are looking at — this is what moves viewers between floors.
   */
  lastSentSceneId?: string;
  /**
   * Whether the room's chat/reaction listeners are attached for this run of
   * the scene. The room is joined by the React side and handed over through
   * the registry, so it can show up after `create()` has already run.
   */
  mmoListenersAttached = false;

  playerEntities: {
    [sessionId: string]: BumpkinContainer;
  } = {};

  colliders?: Phaser.GameObjects.Group;
  triggerColliders?: Phaser.GameObjects.Group;
  hiddenColliders?: Phaser.GameObjects.Group;

  soundEffects: AudioController[] = [];
  walkAudioController?: WalkAudioController;

  cursorKeys:
    | {
        up: Phaser.Input.Keyboard.Key;
        down: Phaser.Input.Keyboard.Key;
        left: Phaser.Input.Keyboard.Key;
        right: Phaser.Input.Keyboard.Key;
        w?: Phaser.Input.Keyboard.Key;
        s?: Phaser.Input.Keyboard.Key;
        a?: Phaser.Input.Keyboard.Key;
        d?: Phaser.Input.Keyboard.Key;
      }
    | undefined;

  // Advanced server timing - not used
  elapsedTime = 0;
  fixedTimeStep = 1000 / 60;

  currentTick = 0;

  zoom = window.innerWidth < 500 ? 3 : 4;

  layers: Record<string, Phaser.Tilemaps.TilemapLayer> = {};

  onCollision: Record<
    string,
    Phaser.Types.Physics.Arcade.ArcadePhysicsCallback
  > = {};
  otherDiggers: Map<string, { x: number; y: number }> = new Map();
  /**
   * navMesh can be used to find paths between two points. The map will need to have
   * a layer of "walkable rectangles" that the player can walk on.
   * ref: https://github.com/mikewesthad/navmesh
   */
  navMesh: unknown;

  /** Injected by Phaser `PhaserNavMeshPlugin` scene mapping (see ChickenRescueGame). */
  navMeshPlugin!: {
    buildMeshFromTiled: (
      name: string,
      layer: Phaser.Tilemaps.ObjectLayer,
      tileWidth: number,
    ) => unknown;
  };

  constructor(options: BaseSceneOptions) {
    if (!options.name) {
      throw new Error("Missing name in config");
    }

    const defaultedOptions: Required<BaseSceneOptions> = {
      ...options,
      name: options.name,
      audio: options.audio ?? { fx: { walk_key: "wood_footstep" } },
      controls: options.controls ?? { enabled: true },
      mmo: options.mmo ?? { enabled: true },
      player: options.player ?? { spawn: { x: 0, y: 0 } },
    };

    super(defaultedOptions.name);

    this.options = defaultedOptions;
  }

  private onAudioMuted = (event: CustomEvent) => {
    this.sound.mute = event.detail;
  };

  preload() {
    if (this.options.map?.json) {
      const json = {
        ...this.options.map.json,
        tilesets:
          this.options.map.defaultTilesetConfig ??
          defaultTilesetConfig.tilesets,
      };
      this.load.tilemapTiledJSON(this.options.name, json);
    }
  }

  create() {
    const errorLogger = createErrorLogger("phaser_base_scene", Number(this.id));

    try {
      this.initialiseMap();
      this.initialiseSounds();

      // Tell React which floor this is. It cannot find out otherwise — the
      // floors are swapped by Phaser via `scene.start`, so nothing outside the
      // game knows. The music reads this to pick a floor's track.
      patchGameState({ activeSceneId: this.options.name });

      // set audio mute state and listen for changes
      this.sound.mute = getAudioMutedSetting();
      window.addEventListener(AUDIO_MUTED_EVENT as any, this.onAudioMuted);

      if (this.options.mmo.enabled) {
        this.initialiseMMO();
      }

      if (this.options.controls.enabled) {
        this.initialiseControls();
      }

      // The standalone arcade has no MMO service, so the scene we warped in
      // from is handed over by `scene.start(key, { from })` instead.
      const sceneData = this.scene.settings.data as
        | { from?: SceneId }
        | undefined;

      const from = (sceneData?.from ??
        this.mmoService?.state.context.previousSceneId) as SceneId;

      let spawn = this.options.player.spawn;

      if (SPAWNS()[this.sceneId]) {
        spawn = SPAWNS()[this.sceneId][from] ?? SPAWNS()[this.sceneId].default;
      }

      this.createPlayer({
        x: spawn.x ?? 0,
        y: spawn.y ?? 0,
        // Which way the player faces on arrival — the stairs spawns appear
        // turned away from the steps, back into the room.
        direction: spawn.facing,
        // gameService
        farmId: Number(this.id),
        faction: this.gameState.faction?.name,
        username: this.username,
        isCurrentPlayer: true,
        // gameService
        clothing: {
          ...(this.gameState.bumpkin?.equipped as BumpkinParts),
          updatedAt: 0,
        },
        experience: 0,
        sessionId: this.mmoServer?.sessionId ?? "",
      });

      this.initialiseCamera();

      // this.physics.world.fixedStep = false; // activates sync
      // this.physics.world.fixedStep = true; // deactivates sync (default)
    } catch (error) {
      errorLogger(JSON.stringify(error));
    }

    this.setUpNavMesh();
  }

  public setUpNavMesh = () => {
    const meshLayer = this.map.getObjectLayer("NavMesh");
    if (!meshLayer) return;

    this.navMesh = this.navMeshPlugin.buildMeshFromTiled(
      "NavMesh",
      meshLayer,
      16,
    );
  };

  private roof: Phaser.Tilemaps.TilemapLayer | null = null;

  public initialiseMap() {
    this.map = this.make.tilemap({
      key: this.options.name,
    });

    const tileset = this.map.addTilesetImage(
      "Sunnyside V3",
      this.options.map.imageKey ?? "tileset",
      16,
      16,
      1,
      2,
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
        (polygon.body as Physics.Arcade.Body).setImmovable(true);
      });
    }

    // Setup interactable layers
    if (this.map.getObjectLayer("Interactable")) {
      const interactablesPolygons = this.map.createFromObjects(
        "Interactable",
        {},
      );
      interactablesPolygons.forEach((polygon) => {
        polygon
          .setInteractive({ cursor: "pointer" })
          .on("pointerdown", (p: Phaser.Input.Pointer) => {
            if (p.downElement.nodeName === "CANVAS") {
              const id = polygon.data.list.id;

              const distance = Phaser.Math.Distance.BetweenPoints(
                this.currentPlayer as BumpkinContainer,
                polygon as Phaser.GameObjects.Polygon,
              );

              if (distance > 50) {
                this.currentPlayer?.speak(translate("base.iam.far.away"));
                return;
              }

              interactableModalManager.open(id);
            }
          });
      });
    }

    this.triggerColliders = this.add.group();

    if (this.map.getObjectLayer("Trigger")) {
      const triggerPolygons = this.map.createFromObjects("Trigger", {
        scene: this,
      });

      triggerPolygons.forEach((polygon) => {
        this.triggerColliders?.add(polygon);
        this.physics.world.enable(polygon);
        (polygon.body as Physics.Arcade.Body).setImmovable(true);
      });
    }

    this.hiddenColliders = this.add.group();

    if (this.map.getObjectLayer("Hidden")) {
      const hiddenPolygons = this.map.createFromObjects("Hidden", {
        scene: this,
      });

      hiddenPolygons.forEach((polygon) => {
        this.hiddenColliders?.add(polygon);
        this.physics.world.enable(polygon);
        (polygon.body as Physics.Arcade.Body).setImmovable(true);
      });
    }

    // Debugging purposes - display colliders in pink
    this.physics.world.drawDebug = false;

    // Set up the Z layers to draw in correct order
    const TOP_LAYERS = [
      "Decorations Layer 1",
      "Decorations Foreground",
      "Decorations Layer 2",
      "Decorations Layer 3",
      "Decorations Layer 4",
      "Building Layer 2",
      "Building Layer 3",
      "Building Layer 4",
      "Club House Roof",
      "Building Layer 4",
      "Building Decorations 2",
    ];
    this.map.layers.forEach((layerData, idx) => {
      if (layerData.name === "Crows") return;

      const layer = this.map.createLayer(layerData.name, [tileset], 0, 0);
      if (TOP_LAYERS.includes(layerData.name)) {
        layer?.setDepth(1000000);
      }

      this.layers[layerData.name] = layer as Phaser.Tilemaps.TilemapLayer;
    });

    this.physics.world.setBounds(
      0,
      0,
      this.map.width * SQUARE_WIDTH,
      this.map.height * SQUARE_WIDTH,
    );
  }

  public initialiseCamera() {
    const camera = this.cameras.main;

    camera.setBounds(
      0,
      0,
      this.map.width * SQUARE_WIDTH,
      this.map.height * SQUARE_WIDTH,
    );

    camera.setZoom(this.zoom);

    // Center it on canvas
    const offsetX = (window.innerWidth - this.map.width * 4 * SQUARE_WIDTH) / 2;
    const offsetY =
      (window.innerHeight - this.map.height * 4 * SQUARE_WIDTH) / 2;
    camera.setPosition(Math.max(offsetX, 0), Math.max(offsetY, 0));

    camera.fadeIn();
  }

  public initialiseMMO() {
    if (this.mmoListenersAttached) return;

    if (this.options.mmo.url && this.options.mmo.serverId) {
      this.mmoService?.send("CONNECT", {
        url: this.options.mmo.url,
        serverId: this.options.mmo.serverId,
      });
    }

    const server = this.mmoServer;
    // No room in the registry (yet) — nothing to listen to. `updateOtherPlayers`
    // calls us again on the first frame the room turns up.
    if (!server) return;

    this.mmoListenersAttached = true;

    const removeMessageListener = server.state.messages?.onAdd?.((message) => {
      // Old message
      if (message.sentAt < Date.now() - 5000) {
        return;
      }

      if (message.sceneId !== this.options.name) {
        return;
      }

      if (!this.scene?.isActive()) {
        return;
      }

      if (this.playerEntities[message.sessionId]) {
        this.playerEntities[message.sessionId].speak(message.text);
      } else if (message.sessionId === server.sessionId) {
        this.currentPlayer?.speak(message.text);
      }
    });

    const removeReactionListener = server.state.reactions?.onAdd?.((reaction) => {
      // Old message
      if (reaction.sentAt < Date.now() - 5000) {
        return;
      }

      if (reaction.sceneId !== this.options.name) {
        return;
      }

      if (!this.scene?.isActive()) {
        return;
      }

      if (this.playerEntities[reaction.sessionId]) {
        this.playerEntities[reaction.sessionId].react(
          reaction.reaction,
          reaction.quantity,
        );
      } else if (reaction.sessionId === server.sessionId) {
        this.currentPlayer?.react(reaction.reaction, reaction.quantity);
      }
    });

    // send the scene player is in
    // this.room.send()

    // `once`, not `on`: re-entering a floor restarts the same scene instance,
    // and each run should attach its own listeners rather than stack another
    // copy on top of the last. Clearing the flag lets that next run re-attach.
    this.events.once("shutdown", () => {
      this.mmoListenersAttached = false;

      removeMessageListener?.();
      removeReactionListener?.();

      window.removeEventListener(AUDIO_MUTED_EVENT as any, this.onAudioMuted);
    });
  }

  public initialiseSounds() {
    // `create()` runs again on every visit to a floor, and the sound manager is
    // the global one, so the previous visit's loop is still playing and the next
    // `add` would stack a second copy on top of it. Release it first.
    this.walkAudioController?.destroy();
    this.walkAudioController = undefined;

    // One loop per footstep file up front, so stepping onto a new surface is
    // just a change of key rather than a load. Keyed by file, not by surface,
    // because several surfaces share a loop — `grass` and `carpet` are both
    // `dirt_footstep`, `stone` and `wood` are both `wood_footstep`.
    //
    // The scene's `walk_key` is included too, so the fallback in
    // `resolveWalkStep` always has a sound to resolve to.
    const keys = new Set<Footsteps>([
      ...Object.values(FOOTSTEP_BY_SURFACE),
      this.options.audio.fx.walk_key,
    ]);

    const sounds: WalkSoundMap = {};
    keys.forEach((key) => {
      sounds[key] = this.sound.add(key);
    });

    this.walkAudioController = new WalkAudioController(sounds);

    // Taking the stairs calls `scene.start`, which stops this scene — but that
    // does not touch the global sound manager, so the loop would follow the
    // player down and play under the next floor's own footsteps.
    //
    // This is the only shutdown hook that is always registered: the one in
    // `initialiseMMO` is MMO-only, and the arcade runs with MMO disabled.
    // `once`, matching `initialiseMMO`, so a re-entered floor attaches one
    // listener per run instead of stacking them.
    this.events.once("shutdown", () => {
      this.walkAudioController?.destroy();
      this.walkAudioController = undefined;
    });
  }

  /**
   * The footstep for whatever the player is currently standing on.
   *
   * The answer is the topmost ground layer covering the player's feet. Both
   * floors stack their floor art — a `floors` base with the `carpet*` runners
   * over it, plus `Grass`/`dirt` outside — so the draw order decides what is on
   * top, and the first layer with a tile there is the one being walked on.
   *
   * Layers absent from `SURFACE_BY_LAYER` (`walls`, `machines`, `tables`,
   * `fence`, `goldcoins`, `water`) are deliberately looked *through* rather
   * than treated as the answer: they are drawn above the floor, so returning
   * them would mean a player standing beside a cabinet footstepped on the
   * cabinet.
   *
   * Runs every frame. It is a handful of array lookups per layer, and the
   * controller ignores a repeat of the key it is already playing, so caching
   * the tile would only add state to invalidate.
   */
  protected resolveWalkStep(): Footsteps {
    const fallback = this.options.audio.fx.walk_key;

    const player = this.currentPlayer;
    const layers = this.map?.layers;

    if (!player || !layers?.length) {
      return fallback;
    }

    // `map.layers` is in Tiled's draw order, first = furthest back, so walk it
    // backwards to hit the topmost tile first.
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];

      const surface = SURFACE_BY_LAYER[layer.name];
      if (!surface) continue;

      // `getTileAtWorldXY` reads `layer.tilemapLayer`, which is only set once
      // `createLayer` has run. `initialiseMap` skips that for some entries
      // (it returns early for "Crows") and `createLayer` itself bails on a
      // tileset it cannot match, so this can legitimately be unset. Neither
      // arcade floor has such a layer today; treat it as "no tile" rather than
      // dereferencing null in a path that runs every frame.
      if (!layer.tilemapLayer) continue;

      // `map.layers` holds `LayerData`, not the rendered `TilemapLayer`, so the
      // lookup goes through the Tilemap's own method — passing `i` rather than
      // `layer.name` so it indexes straight into `map.layers` instead of
      // re-scanning it for a name match on every call.
      //
      // Null for an empty cell as well as one outside the layer, so a hole in
      // the carpet falls through to the floor beneath it.
      if (this.map.getTileAtWorldXY(player.x, player.y, false, undefined, i)) {
        return FOOTSTEP_BY_SURFACE[surface];
      }
    }

    return fallback;
  }

  public initialiseControls() {
    // Initialise Keyboard
    this.cursorKeys = this.input.keyboard?.createCursorKeys();
    if (this.cursorKeys) {
      const mmoLocalSettings = JSON.parse(
        localStorage.getItem("mmo_settings") ?? "{}",
      );
      const layout = mmoLocalSettings.layout ?? "QWERTY";

      // add WASD keys
      this.cursorKeys.w = this.input.keyboard?.addKey(
        layout === "QWERTY" ? "W" : "Z",
        false,
      );
      this.cursorKeys.a = this.input.keyboard?.addKey(
        layout === "QWERTY" ? "A" : "Q",
        false,
      );
      this.cursorKeys.s = this.input.keyboard?.addKey("S", false);
      this.cursorKeys.d = this.input.keyboard?.addKey("D", false);

      this.input.keyboard?.removeCapture("SPACE");
    }

    this.input.setTopOnly(true);
  }

  // LEGACY: Used in community islands
  public get mmoService() {
    return this.registry.get("mmoService") as MMOMachineInterpreter | undefined;
  }

  public get mmoServer() {
    return this.registry.get("mmoServer") as
      | {
          sessionId: string;
          send: (...args: unknown[]) => void;
          state: PlazaRoomState;
        }
      | undefined;
  }

  public get gameState() {
    return this.registry.get("gameState") as any;
  }

  public get id() {
    return this.registry.get("id") as number;
  }

  public get gameService() {
    return this.registry.get("gameService") as any;
  }

  public get authService() {
    return this.registry.get("authService") as any;
  }

  public get username() {
    return this.registry.get("username") as string | undefined;
  }

  public get selectedItem() {
    return this.registry.get("selectedItem");
  }

  public get shortcutItem() {
    return this.registry.get("shortcutItem");
  }

  createPlayer({
    x,
    y,
    direction,
    farmId,
    username,
    faction,
    isCurrentPlayer,
    clothing,
    npc,
    experience = 0,
    sessionId,
  }: {
    isCurrentPlayer: boolean;
    x: number;
    y: number;
    direction?: "left" | "right";
    farmId: number;
    username?: string;
    faction?: string;
    clothing: Player["clothing"];
    npc?: NPCName;
    experience?: number;
    sessionId: string;
  }): BumpkinContainer {
    const defaultClick = () => {
      const distance = Phaser.Math.Distance.BetweenPoints(
        entity,
        this.currentPlayer as BumpkinContainer,
      );

      if (distance > 50) {
        entity.speak(translate("base.far.away"));
        return;
      }

      if (npc) {
        npcModalManager.open(npc);
      } else {
        if (farmId !== this.id) {
          playerModalManager.open({
            id: farmId,
            // Always get the latest clothing
            clothing: this.playerEntities[sessionId]?.clothing ?? clothing,
            experience,
          });
        }
      }
      // TODO - open player modals
    };

    const entity = new BumpkinContainer({
      scene: this,
      x,
      y,
      direction,
      clothing,
      name: npc,
      faction,
      onClick: defaultClick,
    });

    if (!npc) {
      const color = faction
        ? (FACTION_NAME_COLORS[faction as keyof typeof FACTION_NAME_COLORS] ?? "#fff")
        : "#fff";

      const nameTag = this.createPlayerText({
        x: 0,
        y: 0,
        text: username ? username : `#${farmId}`,
        color,
      });
      nameTag.setShadow(1, 1, "#161424", 0, false, true);
      nameTag.name = "nameTag";
      entity.add(nameTag);
    }


    // Is current player
    if (isCurrentPlayer) {
      this.currentPlayer = entity;

      // (this.currentPlayer.body as Phaser.Physics.Arcade.Body).width = 10;
      (this.currentPlayer.body as Phaser.Physics.Arcade.Body)
        .setOffset(3, 10)
        .setSize(10, 8)
        .setCollideWorldBounds(true);

      (this.currentPlayer.body as Phaser.Physics.Arcade.Body).setAllowRotation(
        false,
      );

      // Follow player with camera
      this.cameras.main.startFollow(this.currentPlayer);

      // Callback to fire on collisions
      this.physics.add.collider(
        this.currentPlayer,
        this.colliders as Phaser.GameObjects.Group,
        // Read custom Tiled Properties
        async (obj1, obj2) => {
          const id = (obj2 as any).data?.list?.id;

          // See if scene has registered any callbacks to perform
          const cb = this.onCollision[id];
          if (cb) {
            cb(obj1, obj2);
          }

          // Change scenes
          const warpTo = (obj2 as any).data?.list?.warp;
          if (warpTo && this.currentPlayer?.isWalking) {
            this.changeScene(warpTo);
          }

          const interactable = (obj2 as any).data?.list?.open;
          if (interactable) {
            interactableModalManager.open(interactable);
          }
        },
      );

      this.physics.add.overlap(
        this.currentPlayer,
        this.triggerColliders as Phaser.GameObjects.Group,
        (obj1, obj2) => {
          // You can access custom properties of the trigger object here
          const id = (obj2 as any).data?.list?.id;

          // See if scene has registered any callbacks to perform
          const cb = this.onCollision[id];
          if (cb) {
            cb(obj1, obj2);
          }
        },
      );
    } else {
      (entity.body as Phaser.Physics.Arcade.Body)
        .setSize(16, 20)
        .setOffset(0, 0);
    }

    return entity;
  }

  createPlayerText({
    x,
    y,
    text,
    color,
  }: {
    x: number;
    y: number;
    text: string;
    color?: string;
  }) {
    const textObject = this.add.text(x, y + NAME_TAG_OFFSET_PX, text, {
      fontSize: "4px",
      fontFamily: "monospace",
      resolution: 4,
      padding: { x: 2, y: 2 },
      color: color ?? "#ffffff",
    });

    textObject.setOrigin(0.5);

    this.physics.add.existing(textObject);
    (textObject.body as Phaser.Physics.Arcade.Body).checkCollision.none = true;

    return textObject;
  }

  destroyPlayer(sessionId: string) {
    const entity = this.playerEntities[sessionId];
    if (entity) {
      entity.disappear();
      delete this.playerEntities[sessionId];
    }
  }

  update(): void {
    this.currentTick++;

    this.switchScene();
    this.updatePlayer();
    this.updateOtherPlayers();
    this.updateUsernames();
    this.updateFactions();
  }

  keysToAngle(
    left: boolean,
    right: boolean,
    up: boolean,
    down: boolean,
  ): number | undefined {
    // calculate the x and y components based on key states
    const x = (right ? 1 : 0) - (left ? 1 : 0);
    const y = (down ? 1 : 0) - (up ? 1 : 0);

    if (x === 0 && y === 0) {
      return undefined;
    }

    return (Math.atan2(y, x) * 180) / Math.PI;
  }

  public walkingSpeed = WALKING_SPEED;

  updatePlayer() {
    if (!this.currentPlayer?.body) {
      return;
    }

    // Update faction
    const faction = this.gameState.faction?.name;

    if (this.currentPlayer.faction !== faction) {
      this.currentPlayer.faction = faction;
      this.mmoServer?.send(0, { faction });
      this.checkAndUpdateNameColor(
        this.currentPlayer,
        faction ? (FACTION_NAME_COLORS[faction as keyof typeof FACTION_NAME_COLORS] ?? "white") : "white",
      );
    }

    // joystick is active if force is greater than zero
    this.movementAngle = this.joystick?.force
      ? this.joystick?.angle
      : undefined;

    // use keyboard control if joystick is not active
    if (this.movementAngle === undefined) {
      if (document.activeElement?.tagName === "INPUT") return;

      const left =
        (this.cursorKeys?.left.isDown || this.cursorKeys?.a?.isDown) ?? false;
      const right =
        (this.cursorKeys?.right.isDown || this.cursorKeys?.d?.isDown) ?? false;
      const up =
        (this.cursorKeys?.up.isDown || this.cursorKeys?.w?.isDown) ?? false;
      const down =
        (this.cursorKeys?.down.isDown || this.cursorKeys?.s?.isDown) ?? false;

      this.movementAngle = this.keysToAngle(left, right, up, down);
    }

    // change player direction if angle is changed from left to right or vise versa
    if (
      this.movementAngle !== undefined &&
      Math.abs(this.movementAngle) !== 90
    ) {
      this.isFacingLeft = Math.abs(this.movementAngle) > 90;
      this.isFacingLeft
        ? this.currentPlayer.faceLeft()
        : this.currentPlayer.faceRight();
    }

    // set player velocity
    const currentPlayerBody = this.currentPlayer
      .body as Phaser.Physics.Arcade.Body;
    if (this.movementAngle !== undefined) {
      currentPlayerBody.setVelocity(
        this.walkingSpeed * Math.cos((this.movementAngle * Math.PI) / 180),
        this.walkingSpeed * Math.sin((this.movementAngle * Math.PI) / 180),
      );
    } else {
      currentPlayerBody.setVelocity(0, 0);
    }

    this.sendPositionToServer();

    const isMoving =
      this.movementAngle !== undefined && this.walkingSpeed !== 0;

    if (this.soundEffects) {
      this.soundEffects.forEach((audio) =>
        audio.setVolumeAndPan(
          this.currentPlayer?.x ?? 0,
          this.currentPlayer?.y ?? 0,
        ),
      );
    } else {
      // eslint-disable-next-line no-console
      console.error("audioController is undefined");
    }

    if (this.walkAudioController) {
      this.walkAudioController.handleWalkSound(
        isMoving,
        this.resolveWalkStep(),
      );
    } else {
      // eslint-disable-next-line no-console
      console.error("walkAudioController is undefined");
    }

    if (isMoving) {
      this.currentPlayer.walk();
    } else {
      this.currentPlayer.idle();
    }

    this.currentPlayer.setDepth(Math.floor(this.currentPlayer.y));

    // this.cameras.main.setScroll(this.currentPlayer.x, this.currentPlayer.y);
  }

  sendPositionToServer() {
    const server = this.mmoServer;
    if (!server || !this.currentPlayer) {
      return;
    }

    // Which floor this packet is for: the room mirrors players per scene, so
    // this travels with the coordinates rather than being sent once on join.
    const sceneId = this.scene.key;

    // sync player position to server
    if (
      // Hasn't sent to server recently
      Date.now() - this.packetSentAt > 1000 / SEND_PACKET_RATE &&
      // Position has changed, or the floor changed while standing still —
      // walking down the stairs must move every other viewer to the basement
      // with you, even if you arrive on the very tile you left.
      (this.serverPosition.x !== this.currentPlayer.x ||
        this.serverPosition.y !== this.currentPlayer.y ||
        this.lastSentSceneId !== sceneId)
    ) {
      this.serverPosition = {
        x: this.currentPlayer.x,
        y: this.currentPlayer.y,
      };
      this.lastSentSceneId = sceneId;

      this.packetSentAt = Date.now();

      try {
        server.send(0, { ...this.serverPosition, sceneId });
      } catch {
        // The socket closed underneath us (connection dropped, or another
        // session for the same farm took over). Sync resumes on the next move
        // if it reconnects — this only stops the console filling with the
        // WebSocket's own error.
      }
    }
  }

  syncPlayers() {
    const server = this.mmoServer;
    if (!server) return;

    // Destroy any dereferenced players
    Object.keys(this.playerEntities).forEach((sessionId) => {
      if (
        !server.state.players.get(sessionId) ||
        server.state.players.get(sessionId)?.sceneId !== this.scene.key
      )
        this.destroyPlayer(sessionId);
      if (!this.playerEntities[sessionId]?.active)
        this.destroyPlayer(sessionId);
    });

    // Create new players
    server.state.players.forEach((player, sessionId) => {
      // Skip the current player
      if (sessionId === server.sessionId) return;

      if (player.sceneId !== this.scene.key) return;

      if (!this.playerEntities[sessionId]) {
        this.playerEntities[sessionId] = this.createPlayer({
          x: player.x,
          y: player.y,
          farmId: player.farmId,
          username: player.username,
          faction: player.faction,
          clothing: player.clothing,
          isCurrentPlayer: sessionId === server.sessionId,
          npc: player.npc,
          experience: player.experience,
          sessionId,
        });
      }
    });
  }

  updateClothing() {
    const server = this.mmoServer;
    if (!server) return;

    // Update clothing
    server.state.players.forEach((player, sessionId) => {
      if (this.playerEntities[sessionId]) {
        this.playerEntities[sessionId].changeClothing(player.clothing);
      } else if (sessionId === server.sessionId) {
        this.currentPlayer?.changeClothing(player.clothing);
      }
    });
  }

  updateUsernames() {
    const server = this.mmoServer;
    if (!server) return;

    server.state.players.forEach((player, sessionId) => {
      if (this.playerEntities[sessionId]) {
        const nameTag = this.playerEntities[sessionId].getByName("nameTag") as
          | Phaser.GameObjects.Text
          | undefined;

        if (nameTag && player.username && nameTag.text !== player.username) {
          nameTag.setText(player.username);
        }
      } else if (sessionId === server.sessionId) {
        const nameTag = this.currentPlayer?.getByName("nameTag") as
          | Phaser.GameObjects.Text
          | undefined;

        if (nameTag && player.username && nameTag.text !== player.username) {
          nameTag.setText(player.username);
        }
      }
    });
  }

  checkAndUpdateNameColor(entity: BumpkinContainer, color: string) {
    const nameTag = entity.getByName("nameTag") as
      | Phaser.GameObjects.Text
      | undefined;

    if (nameTag && nameTag.style.color !== color) {
      nameTag.setColor(color);
    }
  }

  updateFactions() {
    const server = this.mmoServer;
    if (!server) return;

    server.state.players.forEach((player, sessionId) => {
      if (!player.faction) return;

      if (this.playerEntities[sessionId]) {
        const faction = player.faction;
        const color = faction
          ? FACTION_NAME_COLORS[faction as keyof typeof FACTION_NAME_COLORS] ?? "#fff"
          : "#fff";

        this.checkAndUpdateNameColor(this.playerEntities[sessionId], color);
      }
    });
  }

  renderPlayers() {
    const server = this.mmoServer;
    if (!server) return;

    const playerInVIP = this.physics.world.overlap(
      this.hiddenColliders as Phaser.GameObjects.Group,
      this.currentPlayer,
    );

    // Render current players
    server.state.players.forEach((player, sessionId) => {
      if (sessionId === server.sessionId) return;

      if (this.otherDiggers.has(sessionId)) return;

      const entity = this.playerEntities[sessionId];

      // Skip if the player hasn't been set up yet
      if (!entity?.active) return;

      if (player.x > entity.x) {
        entity.faceRight();
      } else if (player.x < entity.x) {
        entity.faceLeft();
      }

      const distance = Phaser.Math.Distance.BetweenPoints(player, entity);

      if (distance < 2) {
        entity.idle();
      } else {
        entity.walk();
      }

      entity.x = Phaser.Math.Linear(entity.x, player.x, 0.05);
      entity.y = Phaser.Math.Linear(entity.y, player.y, 0.05);

      entity.setDepth(entity.y);

      // Hide if in club house
      const overlap = this.physics.world.overlap(
        this.hiddenColliders as Phaser.GameObjects.Group,
        entity,
      );

      const hidden = !playerInVIP && overlap;

      // Check if player is in area as well
      if (hidden === entity.visible) {
        entity.setVisible(!hidden);
      }
    });
  }

  switchScene() {
    if (this.switchToScene) {
      const warpTo = this.switchToScene;
      this.switchToScene = undefined;

      // This will cause a loop
      // this.registry.get("navigate")(`/world/${warpTo}`);

      // this.mmoService?.state.context.server?.send(0, { sceneId: warpTo });
      if (this.mmoService) {
        this.mmoService.send("SWITCH_SCENE", { sceneId: warpTo });
        return;
      }

      // No MMO service in this build — the arcade swaps its own Phaser
      // scenes instead (e.g. the top-right stairs to the basement).
      this.scene.start(warpTo, { from: this.sceneId });
    }
  }
  updateOtherPlayers() {
    // The room is joined by the React side and can arrive after `create()`,
    // so pick up its chat/reaction listeners on the first frame it exists.
    if (this.options.mmo.enabled && !this.mmoListenersAttached) {
      this.initialiseMMO();
    }

    const server = this.mmoServer;
    if (!server) return;

    this.syncPlayers();
    this.updateClothing();
    this.renderPlayers();
  }

  checkDistanceToSprite(
    sprite: Phaser.GameObjects.Sprite | Phaser.GameObjects.Image,
    maxDistance: number,
  ) {
    const distance = Phaser.Math.Distance.BetweenPoints(
      sprite,
      this.currentPlayer as BumpkinContainer,
    );

    if (distance > maxDistance) return false;
    return true;
  }

  initialiseNPCs(npcs: NPCBumpkin[]) {
    npcs.forEach((bumpkin) => {
      const defaultClick = () => {
        const distance = Phaser.Math.Distance.BetweenPoints(
          container,
          this.currentPlayer as BumpkinContainer,
        );

        if (distance > 50) {
          container.speak(translate("base.far.away"));
          return;
        }
        npcModalManager.open(bumpkin.npc);
      };

      const container = new BumpkinContainer({
        scene: this,
        x: bumpkin.x,
        y: bumpkin.y,
        clothing: {
          ...(bumpkin.clothing ?? NPC_WEARABLES[bumpkin.npc]),
          updatedAt: 0,
        },
        onClick: bumpkin.onClick ?? defaultClick,
        name: bumpkin.npc,
        direction: bumpkin.direction ?? "right",
      });

      container.setDepth(bumpkin.y);
      (container.body as Phaser.Physics.Arcade.Body)
        .setSize(16, 20)
        .setOffset(0, 0)
        .setImmovable(true)
        .setCollideWorldBounds(true);

      this.physics.world.enable(container);
      this.colliders?.add(container);
      this.triggerColliders?.add(container);
      this.npcs[bumpkin.npc] = container;
    });
  }

  teleportModerator(x: number, y: number, sceneId: SceneId) {
    if (sceneId === this.sceneId) {
      this.currentPlayer?.setPosition(x, y);
    } else {
      this.switchToScene = sceneId;
    }
  }

  /**
   * Changes the scene to the desired scene.
   * @param {SceneId} scene The desired scene.
   */
  protected changeScene = (scene: SceneId) => {
    const originalWalkingSpeed = this.walkingSpeed;
    this.walkingSpeed = 0;

    this.currentPlayer?.stopSpeaking();
    this.cameras.main.fadeOut(1000);

    this.cameras.main.on(
      "camerafadeoutcomplete",
      () => {
        this.switchToScene = scene;
        this.walkingSpeed = originalWalkingSpeed;
      },
      this,
    );
  };
}
