/**
 * Audio constraints for broadcast capture. The browser's voice processing
 * (echo cancellation, noise suppression, automatic gain) pumps the level,
 * smears and gates music and effects: a broadcast carries programme audio.
 *
 * @module
 */

export const PROGRAMME_AUDIO: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};

/** `true` becomes the programme-audio constraints; anything else is kept. */
export function programmeAudio(audio: boolean | MediaTrackConstraints): boolean | MediaTrackConstraints {
  return audio === true ? PROGRAMME_AUDIO : audio;
}
