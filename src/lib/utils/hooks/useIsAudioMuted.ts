import { useEffect, useState } from "react";

const LOCAL_STORAGE_KEY = "settings.audioMuted";
export const AUDIO_MUTED_EVENT = "audioMutedChanged";

export function cacheAudioMutedSetting(value: boolean) {
  localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(value));
  window.dispatchEvent(new CustomEvent(AUDIO_MUTED_EVENT, { detail: value }));
}

export function getAudioMutedSetting(): boolean {
  const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
  return cached ? JSON.parse(cached) : false;
}

/**
 * React view of the stored mute flag, kept in step with the Phaser scenes.
 *
 * The scenes read the flag themselves and listen for `AUDIO_MUTED_EVENT` to
 * re-apply it (`ArcadeBaseScene.onAudioMuted`), so the browser tab holding this
 * hook and the running game always agree — including when the change came from
 * somewhere other than this component.
 *
 * Verbatim from the main game
 * (`src/lib/utils/hooks/useIsAudioMuted.ts`), which is where the localStorage
 * key and event name come from. Sharing them is what lets the main game's own
 * mute state carry across to the arcade in an embedded portal.
 */
export const useIsAudioMuted = () => {
  const [isAudioMuted, setIsAudioMuted] = useState(getAudioMutedSetting());

  const toggleAudioMuted = () => {
    const newValue = !isAudioMuted;
    setIsAudioMuted(newValue);
    cacheAudioMutedSetting(newValue);
  };

  useEffect(() => {
    const handleAudioMutedChange = (event: CustomEvent) => {
      setIsAudioMuted(event.detail);
    };

    window.addEventListener(AUDIO_MUTED_EVENT as any, handleAudioMutedChange);

    return () => {
      window.removeEventListener(
        AUDIO_MUTED_EVENT as any,
        handleAudioMutedChange,
      );
    };
  }, []);

  return { isAudioMuted, toggleAudioMuted };
};