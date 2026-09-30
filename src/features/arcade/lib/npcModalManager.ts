import type { NPCName } from "lib/npcs";

/**
 * Arcade NPCs that Sunflower Land does not know about: they carry their own
 * sprite sheet instead of a bumpkin, so they have no entry in
 * `NPC_WEARABLES` and cannot join the `NPCName` union.
 */
export type ArcadeNpcName = "kohi";

export type SpokenNpc = NPCName | ArcadeNpcName;

/**
 * The NPC dialog opener, copied from the main game's
 * `features/world/ui/NPCModals.tsx` (`NpcModalManager`): one listener, one NPC
 * at a time, no queue — which is also what keeps this on the arcade's
 * "one popup at a time" rule.
 */
class NpcModalManager {
  private listener?: (npc: SpokenNpc, isOpen: boolean) => void;

  public open(npc: SpokenNpc) {
    if (this.listener) {
      this.listener(npc, true);
    }
  }

  public listen(cb: (npc: SpokenNpc, isOpen: boolean) => void) {
    this.listener = cb;
  }
}

export const npcModalManager = new NpcModalManager();
