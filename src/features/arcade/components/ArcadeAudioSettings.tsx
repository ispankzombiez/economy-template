import React from "react";
import { useStore } from "@nanostores/react";
import { PIXEL_SCALE } from "lib/constants";
// Deep import, not the `components/ui` barrel: every other file in this repo
// imports primitives by path, and the barrel re-exports `ResourceImage` /
// `Icon`, which reach `config/*.config.ts` and its `@sl-assets` art. Rollup
// resolves asset imports while building the module graph — before tree-shaking
// can drop unused re-exports — so importing the barrel makes the build require
// the sibling `images` repo even when nothing here renders those components.
import { Slider } from "components/ui/Slider";
import { $gameState } from "lib/gameStore";
import { useIsAudioMuted } from "lib/utils/hooks/useIsAudioMuted";
import { useIsMusicPaused } from "lib/utils/hooks/useIsMusicPaused";
import { useMusicVolume } from "lib/utils/hooks/useMusicVolume";
import {
  getFloorMusic,
  resolveFloorTrack,
  skipFloorTrack,
  toggleRepeatTrack,
  $floorTrackIndex,
  $repeatTrack,
} from "../lib/arcadeMusic";

/**
 * Two arrows chasing round a loop — repeat.
 *
 * Same drawn-not-imported reasoning as the skip arrows beside it; a `repeat`
 * glyph is not among the published CDN icons either.
 */
const RepeatIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    className="h-full w-full"
  >
    <g
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 11a7 7 0 0 1 7-7h7" />
      <path d="m16 1 4 3-4 3" />
      <path d="M19 13a7 7 0 0 1-7 7H5" />
      <path d="m8 23-4-3 4-3" />
    </g>
  </svg>
);

/**
 * Double triangle pointing left / right — previous / next track.
 *
 * Drawn rather than imported for the same reason as the rest of this panel's
 * glyphs: the main game's `arrow_previous` / `arrow_next` are not on the CDN
 * (verified 404). `arrow_left` and `play` *are* published, but mixing one CDN
 * arrow with drawn triangles would clash stylistically and read as a bug.
 */
const PreviousTrackIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    className="h-full w-full"
  >
    <path d="M10 6 3 12l7 6z" fill="currentColor" />
    <path d="M20 6l-7 6 7 6z" fill="currentColor" />
  </svg>
);

const NextTrackIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    className="h-full w-full"
  >
    <path d="M14 6l7 6-7 6z" fill="currentColor" />
    <path d="M4 6l7 6-7 6z" fill="currentColor" />
  </svg>
);

/** SFL sizes its audio glyphs at 10–13 grid squares; these are matched to 13. */
const ICON_SIZE = `${PIXEL_SCALE * 13}px`;

/**
 * Skip arrows sit beside the track name rather than under it, so they are
 * smaller than the on/off glyphs — sized to line up with the `text-xs` label
 * they share a row with.
 */
const TRACK_BUTTON_SIZE = `${PIXEL_SCALE * 7}px`;

/** Speaker with two wave arcs — sound effects are on. */
const SoundOnIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    className="h-full w-full"
  >
    <path d="M4 9h3l4-3.5v13L7 15H4z" fill="currentColor" />
    <g
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      fill="none"
    >
      <path d="M14.5 9a4.5 4.5 0 0 1 0 6" />
      <path d="M17.5 6a9 9 0 0 1 0 12" />
    </g>
  </svg>
);

/** Same speaker, struck through — sound effects are off. */
const SoundOffIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    className="h-full w-full"
  >
    <path d="M4 9h3l4-3.5v13L7 15H4z" fill="currentColor" />
    <g
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      fill="none"
    >
      <line x1="15" y1="9.5" x2="21" y2="15.5" />
      <line x1="21" y1="9.5" x2="15" y2="15.5" />
    </g>
  </svg>
);

/** Eighth note with beams — music is on. */
const MusicOnIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    className="h-full w-full"
  >
    <path d="M9 18a2.5 2.5 0 1 1-2.5-2.5c.6 0 1.1.2 1.5.5V5l10-2v10.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <circle cx="18" cy="16" r="2.5" fill="currentColor" />
    <circle cx="6.5" cy="18" r="2.5" fill="currentColor" />
  </svg>
);

/** Same note, struck through — music is off. */
const MusicOffIcon: React.FC = () => (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    focusable="false"
    className="h-full w-full"
  >
    <path d="M9 18a2.5 2.5 0 1 1-2.5-2.5c.6 0 1.1.2 1.5.5V5l10-2v10.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <circle cx="18" cy="16" r="2.5" fill="currentColor" />
    <circle cx="6.5" cy="18" r="2.5" fill="currentColor" />
    <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="14" y1="17" x2="22" y2="21" />
      <line x1="22" y1="17" x2="14" y2="21" />
    </g>
  </svg>
);

/**
 * One toggle row: a "<label>: On/Off" line with the glyph underneath, matching
 * the shape of the main game's audio panel.
 */
const ToggleRow: React.FC<{
  label: string;
  on: boolean;
  onToggle: () => void;
  /** Noun for the aria-label, e.g. "sound" → "Turn sound on". */
  subject: string;
  children: React.ReactNode;
}> = ({ label, on, onToggle, subject, children }) => (
  <div className="mb-3 last:mb-0">
    <p className="mb-1.5 text-xs text-[#3e2731]">
      {label}: {on ? "On" : "Off"}
    </p>
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      aria-label={on ? `Turn ${subject} off` : `Turn ${subject} on`}
      title={on ? `Turn ${subject} off` : `Turn ${subject} on`}
      // `hover:img-highlight` is what the main game uses on these glyphs, but
      // that class is defined nowhere in this repo's CSS — it silently does
      // nothing. `brightness-90` is what its own Button and Panel use.
      className="block cursor-pointer text-[#3e2731] hover:brightness-90"
      style={{ width: ICON_SIZE, height: ICON_SIZE }}
    >
      {children}
    </button>
  </div>
);

/**
 * The arcade's audio page: music and sound effects, each toggled separately.
 *
 * Modelled on the main game's audio panel
 * (`src/features/game/components/AudioMenu.tsx`), which is laid out as two
 * stacked sections — music above, sound effects below — each a state line with
 * its glyph beneath.
 *
 * ## How much of a transport, and why
 *
 * The main game's music section is a full player: track name plus
 * previous/play/pause/next over a playlist. This copies the *skip* half and
 * stops there.
 *
 * Play/pause is not copied because the Music row is already a toggle — a second
 * control for the same thing beside it would be noise.
 *
 * The skip is scoped to the **floor's** playlist only. The arcade floor cycles
 * through several tracks and moving between them is a choice a playlist can
 * legitimately answer. Cabinet tracks are not skippable: a cabinet has exactly
 * one track, picked by which machine you walked up to, so "the previous track"
 * has no answer there — the previous *machine* is a movement, not a button.
 * `skipFloorTrack` reads the floor list only, and the arrows disappear entirely
 * on a floor with a single track.
 *
 * ## The two flags are independent
 *
 * `settings.musicPaused` for the music, `settings.audioMuted` for sound
 * effects, exactly as the main game splits them. Music is played by
 * `useArcadeMusic`, which reads the former; sound effects are the Phaser
 * sounds, muted by `ArcadeBaseScene.onAudioMuted` reading the latter. Turning
 * one off leaves the other alone.
 *
 * ## Why the glyphs are drawn rather than imported
 *
 * The main game imports `sound_on` / `sound_off` and `play` / `pause` from its
 * own `src/assets/icons`, and declares the `/icons/sound_on.png` shape in
 * `example-assets/sunnyside`. None of those PNGs are on the `testnet-assets`
 * CDN this build loads from — all verified 404, the same reason the arcade's
 * settings button cannot use `icons/settings.png`. Vendoring them is possible
 * but they are private art, and this repo's rule is that the sibling `images`
 * repo is the supported place for that.
 *
 * So the glyphs are inline SVG, which cannot 404 and stay crisp at any
 * `PIXEL_SCALE` — the same trade the settings button already makes. Swapping in
 * real PNGs is a one-line change per row once they are published.
 *
 * Note that `useSound` is still the template's no-op stub, so UI button clicks
 * are silent regardless of the sound-effects toggle.
 */
export const ArcadeAudioSettings: React.FC = () => {
  const { isAudioMuted, toggleAudioMuted } = useIsAudioMuted();
  const { isMusicPaused, toggleMusicPaused } = useIsMusicPaused();
  const { volume, setMusicVolume } = useMusicVolume();

  // The floor's playlist, so the panel can name what is playing and offer a skip.
  const activeSceneId = useStore($gameState).activeSceneId;
  const trackIndex = useStore($floorTrackIndex);
  const floor = getFloorMusic(activeSceneId);
  const trackCount = floor?.tracks.length ?? 0;
  const currentTrack = resolveFloorTrack(activeSceneId, trackIndex);
  const repeatTrack = useStore($repeatTrack);

  return (
    <div className="p-1">
      <ToggleRow
        label="Music"
        on={!isMusicPaused}
        onToggle={toggleMusicPaused}
        subject="music"
      >
        {isMusicPaused ? <MusicOffIcon /> : <MusicOnIcon />}
      </ToggleRow>

      {/* Only rendered when the floor has more than one track, so the basement and
          any single-track floor show nothing here rather than buttons that
          cannot do anything.

          It reflects the *floor's* playlist even while a cabinet is open — at
          that point the cabinet's own track is what is audible, so a skip lands
          when the player returns to the floor. Cabinet tracks are not part of
          the playlist and cannot be skipped. */}
      {trackCount > 1 ? (
        <div className="-mt-1 mb-3">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-xs text-[#3e2731]">
              {floor?.name} — {currentTrack?.name}
            </p>
            <div className="flex shrink-0 gap-1">
              {/* Leftmost, per the transport order: repeat, back, forward.
                  Carries a filled plate when engaged rather than only an
                  `aria-pressed` change, since a bare icon swap between two
                  near-identical arrows is easy to miss. */}
              <button
                type="button"
                onClick={toggleRepeatTrack}
                aria-pressed={repeatTrack}
                aria-label={repeatTrack ? "Repeat off" : "Repeat on"}
                title={repeatTrack ? "Repeat off" : "Repeat on"}
                className={
                  repeatTrack
                    ? "cursor-pointer rounded bg-[#4a2f3a] text-[#f6e3c5] hover:brightness-90"
                    : "cursor-pointer text-[#3e2731] hover:brightness-90"
                }
                style={{ width: TRACK_BUTTON_SIZE, height: TRACK_BUTTON_SIZE }}
              >
                <RepeatIcon />
              </button>
              <button
                type="button"
                onClick={() => skipFloorTrack(-1)}
                aria-label="Previous track"
                title="Previous track"
                className="cursor-pointer text-[#3e2731] hover:brightness-90"
                style={{ width: TRACK_BUTTON_SIZE, height: TRACK_BUTTON_SIZE }}
              >
                <PreviousTrackIcon />
              </button>
              <button
                type="button"
                onClick={() => skipFloorTrack(1)}
                aria-label="Next track"
                title="Next track"
                className="cursor-pointer text-[#3e2731] hover:brightness-90"
                style={{ width: TRACK_BUTTON_SIZE, height: TRACK_BUTTON_SIZE }}
              >
                <NextTrackIcon />
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Level sits under its own toggle rather than beside the row: the
          slider needs the width, and grouping them reads as "music, and how
          loud" the way the sound-effects row does not have a level.

          Dimmed while music is off, but left draggable — someone turning the
          music back on should find the level they set still there, and being
          able to set it before switching on is the point of storing it
          separately from the mute. */}
      <div className="-mt-1 mb-3">
        <div className="mb-1 flex items-baseline justify-between text-xs text-[#3e2731]">
          <span>Volume</span>
          <span>{Math.round(volume * 100)}%</span>
        </div>
        <Slider
          value={volume}
          onValueChange={setMusicVolume}
          ariaLabel="Music volume"
          inactive={isMusicPaused}
        />
      </div>

      <ToggleRow
        label="Sound Effects"
        on={!isAudioMuted}
        onToggle={toggleAudioMuted}
        subject="sound effects"
      >
        {isAudioMuted ? <SoundOffIcon /> : <SoundOnIcon />}
      </ToggleRow>
    </div>
  );
};