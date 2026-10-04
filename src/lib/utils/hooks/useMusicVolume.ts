import { useEffect, useState } from "react";

/**
 * Music volume, 0–1.
 *
 * Distinct from the two flags beside it: `useIsMusicPaused` is a mute, this is
 * a level. Keeping them apart means a player can silence the music with one
 * click without losing the setting they dialled in.
 *
 * Not copied from the main game — the main game has no volume control. The
 * localStorage key and event follow the same shape as its
 * `settings.musicPaused` / `settings.audioMuted` pair so the family reads
 * consistently, and so a future SFL-side volume control can adopt these names.
 */

/**
 * Level used before anyone has touched the slider.
 *
 * Deliberately the value the arcade shipped with while every track played at
 * one hard-coded constant, so existing players hear no change.
 */
export const DEFAULT_MUSIC_VOLUME = 0.25;

const LOCAL_STORAGE_KEY = "settings.musicVolume";
export const MUSIC_VOLUME_EVENT = "musicVolumeChanged";

/** Anything unparseable or out of range falls back to the default. */
function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MUSIC_VOLUME;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function cacheMusicVolumeSetting(value: number) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent(MUSIC_VOLUME_EVENT, { detail: value }));
}

export function getMusicVolumeSetting(): number {
  const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (cached === null) return DEFAULT_MUSIC_VOLUME;

  try {
    return clampVolume(JSON.parse(cached));
  } catch {
    // A corrupt entry should not take the panel down with it.
    return DEFAULT_MUSIC_VOLUME;
  }
}

export const useMusicVolume = () => {
  const [volume, setVolume] = useState(getMusicVolumeSetting());

  const setMusicVolume = (value: number) => {
    const next = clampVolume(value);
    setVolume(next);
    cacheMusicVolumeSetting(next);
  };

  useEffect(() => {
    const handleMusicVolumeChange = (event: CustomEvent) => {
      setVolume(clampVolume(event.detail));
    };

    window.addEventListener(MUSIC_VOLUME_EVENT as any, handleMusicVolumeChange);

    return () => {
      window.removeEventListener(
        MUSIC_VOLUME_EVENT as any,
        handleMusicVolumeChange,
      );
    };
  }, []);

  return { volume, setMusicVolume };
};