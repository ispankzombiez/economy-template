import { useEffect, useState } from "react";

/**
 * Music on/off, kept deliberately separate from `useIsAudioMuted`.
 *
 * The main game splits these too: this is `settings.musicPaused`, the sound
 * effects toggle is `settings.audioMuted` (`useIsAudioMuted.ts`). Sharing the
 * split is what lets the main game's own audio settings carry into an embedded
 * arcade, and it means a player can turn the music down without losing the
 * footsteps.
 *
 * Verbatim from the main game
 * (`src/lib/utils/hooks/useIsMusicPaused.ts`), which is where the localStorage
 * key and event name come from.
 */

const LOCAL_STORAGE_KEY = "settings.musicPaused";
export const MUSIC_PAUSED_EVENT = "musicPausedChanged";

export function cacheMusicPausedSetting(value: boolean) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent(MUSIC_PAUSED_EVENT, { detail: value }));
}

export function getMusicPausedSetting(): boolean {
  const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
  return cached ? JSON.parse(cached) : false;
}

export const useIsMusicPaused = () => {
  const [isMusicPaused, setIsMusicPaused] = useState(getMusicPausedSetting());

  const toggleMusicPaused = () => {
    const newValue = !isMusicPaused;
    setIsMusicPaused(newValue);
    cacheMusicPausedSetting(newValue);
  };

  useEffect(() => {
    const handleMusicPausedChange = (event: CustomEvent) => {
      setIsMusicPaused(event.detail);
    };

    window.addEventListener(MUSIC_PAUSED_EVENT as any, handleMusicPausedChange);

    return () => {
      window.removeEventListener(
        MUSIC_PAUSED_EVENT as any,
        handleMusicPausedChange,
      );
    };
  }, []);

  return { isMusicPaused, toggleMusicPaused };
};