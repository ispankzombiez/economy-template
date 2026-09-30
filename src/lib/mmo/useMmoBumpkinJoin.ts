import { useMemo } from "react";

import { useMinigameSession } from "lib/portal";
import { tokenUriBuilder, type BumpkinParts } from "lib/utils/tokenUriBuilder";
import { createDefaultGuestBumpkin } from "./defaultGuestBumpkin";
import type { GuestBumpkinJoin } from "./types";

/**
 * Builds the `GuestBumpkinJoin` payload the production plaza room wants in its
 * join request, from the current minigame session, so everyone else in the
 * room sees this player's real equipped parts instead of the default guest.
 *
 * Reads the same `farm.bumpkin` the Phaser scene renders the local avatar
 * from, which is what keeps the room's copy of a player in step with the one
 * on screen (the server echoes its own copy back and `updateClothing` applies
 * it only when the parts actually differ).
 *
 * Falls back to the default guest bumpkin when the session carries none —
 * local dev, or a player without a bumpkin. Mirrors the helper Tile Jump
 * keeps in `TileJumpApp.tsx`.
 */
export function useMmoBumpkinJoin(): GuestBumpkinJoin {
  const { farm } = useMinigameSession();

  return useMemo(() => {
    const bumpkin = farm.bumpkin as
      | { equipped?: Record<string, string>; experience?: number; id?: number }
      | undefined;

    const equipped = bumpkin?.equipped;

    if (!equipped) {
      return createDefaultGuestBumpkin();
    }

    // Build BumpkinParts from the equipped record so the join payload carries
    // the same token URI the avatar is rendered from.
    const parts: BumpkinParts = {
      background:
        (equipped.background || undefined) as BumpkinParts["background"],
      body: (equipped.body || undefined) as BumpkinParts["body"],
      hair: (equipped.hair || undefined) as BumpkinParts["hair"],
      shirt: (equipped.shirt || undefined) as BumpkinParts["shirt"],
      pants: (equipped.pants || undefined) as BumpkinParts["pants"],
      shoes: (equipped.shoes || undefined) as BumpkinParts["shoes"],
      tool: (equipped.tool || undefined) as BumpkinParts["tool"],
      hat: (equipped.hat || undefined) as BumpkinParts["hat"],
      necklace: (equipped.necklace || undefined) as BumpkinParts["necklace"],
      secondaryTool: (equipped.secondaryTool ||
        undefined) as BumpkinParts["secondaryTool"],
      coat: (equipped.coat || undefined) as BumpkinParts["coat"],
      onesie: (equipped.onesie || undefined) as BumpkinParts["onesie"],
      suit: (equipped.suit || undefined) as BumpkinParts["suit"],
      dress: (equipped.dress || undefined) as BumpkinParts["dress"],
      wings: (equipped.wings || undefined) as BumpkinParts["wings"],
      beard: (equipped.beard || undefined) as BumpkinParts["beard"],
      aura: (equipped.aura || undefined) as BumpkinParts["aura"],
    };

    return {
      equipped: {
        background: equipped.background ?? "",
        body: equipped.body ?? "",
        hair: equipped.hair ?? "",
        shoes: equipped.shoes ?? "",
        pants: equipped.pants ?? "",
        tool: equipped.tool ?? "",
        shirt: equipped.shirt ?? "",
        coat: equipped.coat ?? "",
        onesie: equipped.onesie ?? "",
        suit: equipped.suit ?? "",
        dress: equipped.dress ?? "",
        hat: equipped.hat ?? "",
        necklace: equipped.necklace ?? "",
        secondaryTool: equipped.secondaryTool ?? "",
        wings: equipped.wings ?? "",
        beard: equipped.beard ?? "",
        aura: equipped.aura ?? "",
      },
      experience: bumpkin?.experience ?? 0,
      id: bumpkin?.id ?? 0,
      skills: {},
      tokenUri: tokenUriBuilder(parts),
      achievements: {},
    };
  }, [farm.bumpkin]);
}
