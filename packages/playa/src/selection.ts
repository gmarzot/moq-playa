/**
 * Live program, view and audio-language switching on the Player facade:
 * re-emits the engine's switch events and keeps the quality ladder on the
 * current view.
 *
 * @see draft-ietf-moq-msf-00 §5.1.18 (renderGroup), §5.1.19 (altGroup)
 * @module
 */

import type { CatalogState } from '@openmoq/msf';
import type { MoqtPlayer, TypedEmitter } from '@openmoq/player';
import type { PlayerEventMap } from './events.js';
import type { Level } from './types.js';
import { mapLevels } from './level-mapper.js';

/**
 * Forward the engine's switch events to `emitter`. On a view change,
 * `setLevels` receives the new view's ladder and the index of the track now
 * playing (-1 when it is not in the ladder).
 */
export function forwardSelectionEvents(
  engine: MoqtPlayer,
  emitter: TypedEmitter<PlayerEventMap>,
  setLevels: (levels: Level[], current: number) => void,
): void {
  let catalog: CatalogState | null = null;
  engine.on('catalog_received', (e) => { catalog = e.catalog; });
  engine.on('catalog_updated', (e) => { catalog = e.catalog; });

  engine.on('view_changed', (e) => {
    if (catalog) {
      const ladder = new Set(engine.availableVideoTracks.map((t) => t.name));
      const levels = mapLevels(catalog, e.toView)
        .filter((l) => ladder.has(l.trackName))
        .map((l, index) => ({ ...l, index }));
      setLevels(levels, levels.findIndex((l) => l.trackName === e.trackName));
    }
    emitter.emit('view_changed', { fromView: e.fromView, toView: e.toView, trackName: e.trackName });
  });
  engine.on('program_changed', (e) => {
    emitter.emit('program_changed', { fromProgram: e.fromProgram, toProgram: e.toProgram });
  });
  engine.on('audio_track_changed', (e) => {
    emitter.emit('audio_track_changed', {
      fromTrackName: e.fromTrackName, toTrackName: e.toTrackName, lang: e.lang, reason: e.reason,
    });
  });
  engine.on('audio_track_switch_failed', (e) => {
    emitter.emit('audio_track_switch_failed', {
      fromTrackName: e.fromTrackName, toTrackName: e.toTrackName, reason: e.reason, error: e.error,
    });
  });
}
