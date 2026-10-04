import { useEffect, useRef } from "react";
import { useStore } from "@nanostores/react";
import { $gameState } from "lib/gameStore";
import { useIsMusicPaused } from "lib/utils/hooks/useIsMusicPaused";
import { useMusicVolume } from "lib/utils/hooks/useMusicVolume";
import {
  getFloorMusic,
  resolveFloorTrack,
  skipFloorTrack,
  $floorTrackIndex,
  $repeatTrack,
} from "./arcadeMusic";

/**
 * Plays whatever the arcade should be playing right now.
 *
 * One track at a time, chosen by precedence:
 *
 *  1. **The open game's own soundtrack**, when the player has clicked a cabinet
 *     and that game has a `music` entry. This is the "machine menu opens" moment
 *     — clicking a cabinet emits `minigamesEventEmitter`, which sets
 *     `activeGameId` and opens the game's modal (see `NightshadeArcadeApp`).
 *  2. **Otherwise the current floor's track**, picked out of that floor's list
 *     by `$floorTrackIndex` — which the audio panel's skip buttons move. The
 *     floor itself comes from `$gameState.activeSceneId`, published by each
 *     scene's `create()`.
 *  3. **Otherwise nothing** — a floor with no entry in `ARCADE_FLOOR_TRACKS` is
 *     silent.
 *
 * A game with no `music` entry falls through to (2) rather than going quiet,
 * which is what lets tracks be written one game at a time.
 *
 * Music is toggled on its own flag, `settings.musicPaused`, separate from the
 * sound-effects flag — the same split the main game makes, so a player can turn
 * the music down without losing the footsteps. Turning sound effects off
 * therefore does not silence this, and vice versa.
 *
 * The level itself comes from `useMusicVolume`, so it survives a reload and
 * applies to whichever track is current — including one swapped in later.
 *
 * ## Repeat, and what a track ending actually does
 *
 * The floor's list is a playlist rather than one long loop: with repeat off —
 * the default — a track that reaches its end advances to the next, and the set
 * cycles round. Turning repeat on loops that one track instead. The toggle sits
 * in the audio panel beside the skip arrows.
 *
 * Cabinet tracks sit outside this and always loop, because they belong to no
 * playlist, so "the next track" would have nothing to mean.
 *
 * ## Leaving a cabinet resumes; opening one starts fresh
 *
 * Each distinct `src` gets its own `Audio` element, but the position is
 * remembered per src, so the two directions differ on purpose:
 *
 *  - **Into a cabinet:** that game's soundtrack is new, so it opens on the
 *    first bar. There is nothing to resume — it was never playing.
 *  - **Back out to the floor:** the floor track picks up where it was paused,
 *    so stepping into a cabinet and back out does not cost you your place in
 *    the song.
 *
 * The skip buttons share that memory, so cycling back to a track already heard
 * resumes it too. Only a reload clears it (see `positionsRef`).
 *
 * It also means leaving a floor cannot leave its track playing, which is the
 * same class of bug the walking loops had (see `WalkAudioController`).
 */
export function useArcadeMusic(gameTrack?: string): void {
  const activeSceneId = useStore($gameState).activeSceneId;
  const { isMusicPaused } = useIsMusicPaused();
  const { volume } = useMusicVolume();
  const trackIndex = useStore($floorTrackIndex);
  const repeatTrack = useStore($repeatTrack);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  /**
   * Where each track was last left, keyed by its src.
   *
   * A ref rather than state or localStorage: this is playback bookkeeping, not
   * something the UI renders or the player chose, and it should not outlive the
   * session — a reload starts the music from the top, which is what a fresh
   * visit should do.
   */
  const positionsRef = useRef<Map<string, number>>(new Map());

  // The element is rebuilt whenever the *track* changes, and that effect must
  // not also depend on `volume` — dragging the slider would then tear down and
  // recreate the element on every tick, restarting the track from the top. So
  // the builder reads the level through a ref, and a separate effect below
  // pushes changes onto whichever element is live.
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  // The floor's selected track. `resolveFloorTrack` applies the modulo, so the
  // index stays valid on a floor of any size without being reset when the
  // floor changes.
  const floorSrc = resolveFloorTrack(activeSceneId, trackIndex)?.src;
  const src = gameTrack ?? floorSrc;

  /**
   * Whether the current track loops, or ends and hands over to the next.
   *
   * Loops when repeat is on, and also when there is nothing to advance *to* —
   * a cabinet's lone track, or a floor whose list holds one. Restarting those
   * from zero every time would put an audible seam where a loop is seamless, so
   * they loop instead. That makes repeat a genuine no-op there, which is why the
   * transport hides itself on a single-track floor.
   *
   * A cabinet always loops regardless of the setting: its track is not in the
   * playlist, so "the next track" would have no meaning.
   */
  const floorTrackCount = getFloorMusic(activeSceneId)?.tracks.length ?? 0;
  const shouldLoop = repeatTrack || floorTrackCount < 2;

  // Read through a ref by the element builder, for the same reason as the
  // volume: toggling repeat must adjust the live element, not rebuild it.
  const shouldLoopRef = useRef(shouldLoop);
  shouldLoopRef.current = shouldLoop;

  // (Re)create the element for whichever track is current. Declared before the
  // effect below so that on a track change the element exists by the time that
  // one reaches for it.
  useEffect(() => {
    if (!src) return;

    const audio = new Audio(src);
    // Not `loop: true` unconditionally: with repeat off, a floor track that
    // reaches its end has to fall through to the next one instead.
    audio.loop = shouldLoopRef.current;
    audio.preload = "auto";
    audio.volume = volumeRef.current;

    /**
     * Hand over to the next track when this one finishes.
     *
     * Only reached while `audio.loop` is false — a looping element never fires
     * `ended` — so there is no repeat check to make here. `skipFloorTrack` is a
     * no-op unless the floor holds at least two tracks, and it advances the floor
     * index. A cabinet's own track has already overridden playback by then, so the
     * new selection takes effect on the way back out of the cabinet.
     */
    const handleEnded = () => {
      skipFloorTrack(1);
    };

    audio.addEventListener("ended", handleEnded);

    /**
     * Seek to where this track was last left.
     *
     * Only meaningful for a track that has played before: a cabinet's own
     * soundtrack is new every time, so it starts on the first bar, while the
     * floor track the player was listening to before opening the cabinet picks
     * up mid-piece. That is the whole point — leaving a machine should not cost
     * you your place in the song.
     *
     * Deferred to `loadedmetadata` when the browser does not have it yet, since
     * `currentTime` is only reliably seekable once the duration is known. The
     * `readyState` check comes first so an already-cached file seeks straight
     * away rather than waiting on an event that may have fired already.
     */
    const applySavedPosition = () => {
      const saved = positionsRef.current.get(src);
      if (saved === undefined || saved <= 0) return;

      // A looping track should always report a position inside itself, but a
      // saved time at or past the end would park the element at the close.
      if (Number.isFinite(audio.duration) && saved >= audio.duration) return;

      try {
        audio.currentTime = saved;
      } catch {
        // Seeking can be refused before the media is seekable. Not worth
        // reporting — the track just starts from the top instead.
      }
    };

    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      applySavedPosition();
    } else {
      audio.addEventListener("loadedmetadata", applySavedPosition, {
        once: true,
      });
    }

    audioRef.current = audio;

    return () => {
      audio.removeEventListener("ended", handleEnded);

      // Read before pausing, so this is the last audible position.
      const played = audio.currentTime;
      if (Number.isFinite(played) && played > 0) {
        positionsRef.current.set(src, played);
      }

      audio.pause();
      // Drop the source too, so a stopped element is not left holding a decoded
      // track in memory for a floor or game the player has left.
      audio.removeAttribute("src");
      audio.load();
      audioRef.current = null;
    };
  }, [src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isMusicPaused) {
      audio.pause();
      return;
    }

    void audio.play().catch(() => {
      // Blocked by the browser's autoplay policy until the page has been
      // interacted with. Nothing to recover here — a later floor change, machine
      // open or unmute retries. Failing loudly would only spam the console on
      // every state change while the player is still on the title screen.
    });
  }, [isMusicPaused, src]);

  // Push the level onto the live element. Separate from the effect above so
  // that moving the slider adjusts the sound in place instead of restarting
  // the track.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.volume = volume;
  }, [volume]);

  // Same reasoning for the loop flag: toggling repeat must change how the live
  // element behaves, not replace it and cut the track off mid-phrase.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.loop = shouldLoop;
  }, [shouldLoop]);
}