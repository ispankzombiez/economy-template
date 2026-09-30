type Coordinates = { x: number; y: number; facing?: "left" | "right" };
import type { SceneId } from "../sceneIds";
import { CONFIG } from "lib/config";

export type SpawnLocation = Record<
  SceneId,
  { default: Coordinates } & Partial<Record<SceneId, Coordinates>>
>;

const randomXOffset = Math.random() * 60;
const randomYOffset = Math.random() * 20;
const nightshadeArcadeRandomXOffset = Math.random() * 49;
const nightshadeArcadeRandomYOffset = Math.random() * 20;

export const SPAWNS: () => SpawnLocation = () => ({
  chicken_rescue: {
    default: {
      x: 200,
      y: 200,
    },
  },
  portal_example: {
    default: {
      x: 400 + randomXOffset,
      y: 450 - randomYOffset,
    },
  },
  goblin_house: {
    default: {
      x: 239,
      y: 436,
    },
  },
  sunflorian_house: {
    default: {
      x: 239,
      y: 432,
    },
  },
  nightshade_house: {
    default: {
      x: 240,
      y: 432,
    },
  },
  "nightshade-arcade": {
    default: {
      x: 214 + nightshadeArcadeRandomXOffset,
      y: 450 + nightshadeArcadeRandomYOffset,
    },
    // Coming back up the stairs lands you just to the left of the top-right
    // staircase, turned to face left back into the room. The body spans
    // x 407–417 against the stair warp trigger (x 424–456, y 31–63).
    "nightshade-arcade-basement": {
      x: 412,
      y: 47,
      facing: "left",
    },
  },
  "nightshade-arcade-basement": {
    // Just to the left of the south-east staircase (x 344–376, y 208–240),
    // facing left into the room. The body spans x 327–337 — 7px clear of the
    // stair warp trigger, so arriving cannot immediately send the player back
    // upstairs.
    default: {
      x: 332,
      y: 224,
      facing: "left",
    },
    "nightshade-arcade": {
      x: 332,
      y: 224,
      facing: "left",
    },
  },
  bumpkin_house: {
    default: {
      x: 240,
      y: 434,
    },
  },
  faction_house: {
    // Make sure everyone doesn't spawn in same spot
    default: {
      x: 230 + randomXOffset,
      y: 420 - randomYOffset,
    },
  },
  kingdom: {
    // Make sure everyone doesn't spawn in same spot
    default: {
      x: 235,
      y: 845,
    },
    beach: {
      x: 25,
      y: 656,
    },
    nightshade_house: {
      x: 120,
      y: 448,
    },
    sunflorian_house: {
      x: 344,
      y: 651,
    },
    goblin_house: {
      x: 122,
      y: 786,
    },
    bumpkin_house: {
      x: 376,
      y: 462,
    },
  },
  retreat: {
    // Make sure everyone doesn't spawn in same spot
    default: {
      x: 290 + randomXOffset,
      y: 420 - randomYOffset,
    },
  },
  plaza: {
    // Make sure everyone doesn't spawn in same spot
    default: {
      x: 400 + randomXOffset,
      y: 450 - randomYOffset,
    },

    kingdom: {
      x: 64,
      y: 35,
    },

    woodlands: {
      x: 850,
      y: 142,
    },
    beach: {
      x: 26,
      y: 318,
    },
  },
  crop_boom: {
    default: {
      x: 220,
      y: 422,
    },
  },
  mushroom_forest: {
    default: {
      x: 220,
      y: 422,
    },
  },
  beach: {
    default:
      CONFIG.NETWORK === "amoy"
        ? {
            // // For artefact area
            x: 256,
            y: 159,
            // x: 528,
            // y: 736,
          }
        : {
            x: 528,
            y: 736,
          },
    kingdom: {
      x: 532,
      y: 257,
    },
  },

  auction_house: {
    default: {
      x: 170,
      y: 242,
    },
  },
  clothes_shop: {
    default: {
      x: 144,
      y: 245,
    },
  },
  decorations_shop: {
    default: {
      x: 81,
      y: 215,
    },
  },
  windmill_floor: {
    default: {
      x: 80,
      y: 140,
    },
  },
  woodlands: {
    default: {
      x: 30,
      y: 290,
    },
  },
});
