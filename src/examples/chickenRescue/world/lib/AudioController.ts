import Phaser from "phaser";

export type Sound =
  | Phaser.Sound.HTML5AudioSound
  | Phaser.Sound.WebAudioSound
  | Phaser.Sound.NoAudioSound;

/**
 * Cadence and level of the walking loop. Playback is slower than the source
 * file's own rate — the loops ship a "walk/run" cadence and read as a jog at
 * 1.0 — and kept quiet so it sits under the scene rather than over it.
 */
export const DEFAULT_WALK_RATE = 0.62;
export const DEFAULT_WALK_VOLUME = 0.07;

/**
 * Loops the controller can switch between, keyed by whatever the caller uses to
 * name them (a surface, a tile group). The controller never looks inside.
 */
export type WalkSoundMap = Record<string, Sound>;

/**
 * Key for the single-sound form, which is what Chicken Rescue passes.
 */
const SINGLE_SOUND_KEY = "default";

export class WalkAudioController {
  private walkSounds: Map<string, Sound>;
  private defaultKey: string;
  private rate: number;
  private volume: number;

  /** Which loop is currently running, so a repeat call is a no-op. */
  private playingKey?: string;

  /**
   * Accepts either one loop or a set of them. A single `Sound` is wrapped so
   * existing callers (Chicken Rescue's `BaseScene`) are unaffected and keep
   * getting the one key.
   */
  constructor(
    walkSounds: Sound | WalkSoundMap,
    rate: number = DEFAULT_WALK_RATE,
    volume: number = DEFAULT_WALK_VOLUME,
  ) {
    // this.music = music;
    this.rate = rate;
    this.volume = volume;

    if (typeof (walkSounds as Sound).play === "function") {
      this.walkSounds = new Map([[SINGLE_SOUND_KEY, walkSounds as Sound]]);
      this.defaultKey = SINGLE_SOUND_KEY;
    } else {
      this.walkSounds = new Map(Object.entries(walkSounds as WalkSoundMap));
      this.defaultKey = this.walkSounds.keys().next().value ?? SINGLE_SOUND_KEY;
    }
  }

  /**
   * @param soundKey Which loop to run. Omit to keep using the default one,
   * which is the only option for single-sound callers.
   */
  handleWalkSound(isWalking: boolean, soundKey?: string): void {
    if (!isWalking) {
      this.stop();
      return;
    }

    const key =
      soundKey !== undefined && this.walkSounds.has(soundKey)
        ? soundKey
        : this.defaultKey;
    const sound = this.walkSounds.get(key);

    if (!sound) return;

    // Already running the requested loop. Re-entering `play` every frame is
    // what makes a loop retrigger on top of itself.
    if (this.playingKey === key && sound.isPlaying) return;

    // Switching surfaces: the outgoing loop has to be silenced first, or it
    // plays on underneath the incoming one.
    this.stop();

    sound.play({ loop: true, volume: this.volume, rate: this.rate });
    this.playingKey = key;
  }

  /**
   * Silences every loop but keeps them playable.
   *
   * Callers that have stopped feeding `handleWalkSound` — because they bypassed
   * the movement update, or because the scene is going away — need this, since
   * a looped sound only stops when something says so.
   */
  stop(): void {
    this.walkSounds.forEach((sound) => {
      if (sound.isPlaying) {
        sound.stop();
      }
    });

    this.playingKey = undefined;
  }

  /**
   * Stops the loops and releases the underlying sounds.
   *
   * Required on scene changes: a scene's `this.sound` is the *global* sound
   * manager (see Phaser's `Systems.sound`), not a per-scene one, so sounds
   * added via `this.sound.add()` outlive the scene that created them. Left
   * alone, a loop keeps playing after the scene stops and a re-entered scene
   * adds a second copy on top of it.
   */
  destroy(): void {
    this.stop();
    this.walkSounds.forEach((sound) => sound.destroy());
    this.walkSounds.clear();
    this.playingKey = undefined;
  }
}

export type AudioProps = {
  sound: Sound;
  distanceThreshold: number;
  coordinates: {
    x: number;
    y: number;
  };
  maxVolume: number;
};

export class AudioController {
  // private music: Sound;
  private audio: AudioProps;

  constructor(audio: AudioProps) {
    this.audio = audio;
  }

  setVolumeAndPan(playerX: number, playerY: number): void {
    const distanceToSoundSource = Phaser.Math.Distance.Between(
      playerX,
      playerY,
      this.audio.coordinates.x,
      this.audio.coordinates.y,
    );

    let normalizedSound =
      1 - Math.min(distanceToSoundSource / this.audio.distanceThreshold, 1);
    normalizedSound = Math.max(normalizedSound, 0);

    if ("volume" in this.audio.sound) {
      const volume =
        Phaser.Math.Easing.Sine.In(normalizedSound) * this.audio.maxVolume;
      this.audio.sound.volume = Phaser.Math.Clamp(
        volume,
        0,
        this.audio.maxVolume,
      );
    }

    const panPosition =
      Phaser.Math.Clamp((playerX - this.audio.coordinates.x) / 50, -1, 1) * -1;

    if ("setPan" in this.audio.sound) {
      this.audio.sound.setPan(panPosition);
    }
  }
}
