import { atom } from "nanostores";
import { $gameState } from "lib/gameStore";

import mainArcade1 from "../assets/main_arcade.mp3";
import mainArcade2 from "../assets/main_arcade_2.mp3";
import mainArcade3 from "../assets/main_arcade_3.mp3";
import mainArcade4 from "../assets/main_arcade_4.mp3";
import mainArcade5 from "../assets/main_arcade_5.mp3";
import basementTrack from "../assets/basement.mp3";

/** One playable track, with a label for the audio settings' now-playing line. */
export type ArcadeTrack = {
  /** Vite asset import. */
  src: string;
  /** Shown in the audio panel. Placeholder — see the note on `ARCADE_FLOOR_TRACKS`. */
  name: string;
};

/** A floor's music: an ordered list the player can cycle through. */
export type ArcadeFloorMusic = {
  name: string;
  tracks: ArcadeTrack[];
};

/**
 * Per-floor music for the Nightshade Arcade.
 *
 * Keyed by the Phaser scene key the floor publishes as
 * `$gameState.activeSceneId` — `nightshade-arcade` and
 * `nightshade-arcade-basement`. A floor with no entry is silent.
 *
 * Each floor is a *list*, not a single file. A floor with one track behaves
 * exactly as before; a floor with several cycles through them, and the skip
 * controls in the audio panel appear only when there is something to skip to.
 *
 * Per-*game* music is not here: it lives on each entry in `games/registry.tsx`
 * as a `music` field, next to the component it belongs to, so adding a track
 * is part of adding the game. A cabinet's track always wins over the floor's,
 * whichever floor track is selected.
 *
 * ## Track names are placeholders
 *
 * These are stand-ins derived from the filenames. Replace `name` with the real
 * titles when they are known — it is the only player-facing part of this file.
 */
export const ARCADE_FLOOR_TRACKS: Record<string, ArcadeFloorMusic> = {
  "nightshade-arcade": {
    name: "Arcade",
    tracks: [
      { src: mainArcade1, name: "Arcade 1" },
      { src: mainArcade2, name: "Arcade 2" },
      { src: mainArcade3, name: "Arcade 3" },
      { src: mainArcade4, name: "Arcade 4" },
      { src: mainArcade5, name: "Arcade 5" },
    ],
  },
  "nightshade-arcade-basement": {
    name: "Basement",
    tracks: [{ src: basementTrack, name: "Basement" }],
  },
};

/**
 * Which track of the current floor's list is selected.
 *
 * Deliberately one index shared by every floor rather than one per floor. It is
 * why a trip to the basement and back returns you to the track you chose: the
 * basement's single track cannot change the index (see `skipFloorTrack`), and
 * `resolveFloorTrack` reads it modulo the list length.
 *
 * A store rather than prop state because the player is not the one changing it:
 * the audio panel's skip buttons and the music hook itself both need it, and
 * they are separate components.
 */
export const $floorTrackIndex = atom(0);

/**
 * Whether a floor track repeats itself instead of advancing.
 *
 * Off by default, which is what makes the floor's list a *playlist*: a track
 * that ends moves on to the next, and the set loops around.
 *
 * Session state, like `$floorTrackIndex`, because it is a listening mode rather
 * than a device setting — unlike the volume and the two mute flags, which are
 * remembered. Nothing here persists, so a reload returns to track 1 with repeat
 * off.
 */
export const $repeatTrack = atom(false);

/** Flip repeat. Called by the audio panel's repeat button. */
export function toggleRepeatTrack(): void {
  $repeatTrack.set(!$repeatTrack.get());
}

/** The floor's music, or undefined for a floor that has none. */
export function getFloorMusic(
  sceneId: string | undefined,
): ArcadeFloorMusic | undefined {
  return sceneId ? ARCADE_FLOOR_TRACKS[sceneId] : undefined;
}

/**
 * The selected track, or undefined if the floor is silent.
 *
 * The index is taken modulo the list length rather than clamped, so it stays
 * valid on a floor of any size without having to be reset when the floor
 * changes — including the single-track basement, where it always resolves to
 * index 0 without the stored value changing.
 */
export function resolveFloorTrack(
  sceneId: string | undefined,
  index: number,
): ArcadeTrack | undefined {
  const tracks = getFloorMusic(sceneId)?.tracks;
  if (!tracks?.length) return undefined;

  const safe = ((Math.trunc(index) % tracks.length) + tracks.length) % tracks.length;
  return tracks[safe];
}

/**
 * Step through the current floor's list, wrapping at both ends.
 *
 * A no-op when the floor has fewer than two tracks — the basement, and any
 * floor added with a single file — so the skip buttons cannot leave the index
 * pointing at nothing.
 */
export function skipFloorTrack(delta: number): void {
  const tracks = getFloorMusic($gameState.get().activeSceneId)?.tracks;
  if (!tracks || tracks.length < 2) return;

  const count = tracks.length;
  const current = $floorTrackIndex.get();
  $floorTrackIndex.set(((current + delta) % count + count) % count);
}