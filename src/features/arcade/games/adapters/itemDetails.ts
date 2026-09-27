import { CONFIG } from "lib/config";
import tomato from "../../assets/tomato.webp";

/**
 * Stand-in for `features/game/types/images` (the full SFL item table, absent
 * from this template).
 *
 * The ten games only ever read `.image` on crop items, for card suits (Kale /
 * Barley / Wheat / Radish), Tetris blocks and a couple of UI props.
 *
 * URLs mirror the original exactly: SFL resolves crop art through
 * `CROP_LIFECYCLE` → `${PROTECTED_IMAGE_URL}/crops/<name>/crop.png`
 * (`source-portal` `features/island/plots/lib/plant.ts`). Tomato is the one
 * exception — it is a fruit and was imported as a bundled webp there, and it
 * is not published on the image CDN, so the original file is shipped with the
 * arcade instead.
 */
const crop = (name: string) =>
  `${CONFIG.PROTECTED_IMAGE_URL}/crops/${name}/crop.png`;

export const ITEM_DETAILS = {
  Sunflower: { image: crop("sunflower") },
  Potato: { image: crop("potato") },
  Pumpkin: { image: crop("pumpkin") },
  Carrot: { image: crop("carrot") },
  Corn: { image: crop("corn") },
  Radish: { image: crop("radish") },
  Wheat: { image: crop("wheat") },
  Kale: { image: crop("kale") },
  Barley: { image: crop("barley") },
  Tomato: { image: tomato },
};
