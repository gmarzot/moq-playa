/**
 * Player facade: live program, view and audio-language switching.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Player } from './player.js';

function mockElement(): any {
  return {
    style: {}, appendChild: vi.fn(), removeChild: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    getContext: vi.fn(() => ({ drawImage: vi.fn() })),
    width: 0, height: 0, hidden: false, muted: false, volume: 1, playsInline: false,
    parentNode: null, play: vi.fn(async () => {}), pause: vi.fn(),
    removeAttribute: vi.fn(), load: vi.fn(), disableRemotePlayback: false,
  };
}

beforeEach(() => {
  vi.stubGlobal('document', {
    createElement: () => mockElement(), hidden: false,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
  });
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 0));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('AudioContext', class {
    state = 'suspended'; currentTime = 0; outputLatency = 0;
    destination = { maxChannelCount: 2 };
    resume = vi.fn(async () => {}); close = vi.fn(async () => {});
    createGain = vi.fn(() => ({ gain: { value: 1, setTargetAtTime: vi.fn() }, connect: vi.fn() }));
    getOutputTimestamp = vi.fn(() => ({ contextTime: 0, performanceTime: 0 }));
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const CATALOG = { version: 1, tracks: [
  { name: 'main_hi', role: 'video', packaging: 'loc', isLive: true, codec: 'avc1.640028',
    width: 1920, height: 1080, bitrate: 4_000_000, altGroup: 1, renderGroup: 1 },
  { name: 'main_lo', role: 'video', packaging: 'loc', isLive: true, codec: 'avc1.640028',
    width: 1280, height: 720, bitrate: 2_000_000, altGroup: 1, renderGroup: 1 },
  { name: 'portrait', role: 'video', packaging: 'loc', isLive: true, codec: 'avc1.640028',
    width: 720, height: 1280, bitrate: 2_000_000, altGroup: 2, renderGroup: 1 },
  { name: 'audio_en', role: 'audio', packaging: 'loc', isLive: true, codec: 'opus', lang: 'en', altGroup: 3, renderGroup: 1 },
  { name: 'audio_es', role: 'audio', packaging: 'loc', isLive: true, codec: 'opus', lang: 'es', altGroup: 3, renderGroup: 1 },
] };

function setup() {
  const player = new Player(mockElement(), { url: 'https://relay.example/moq', namespace: 'views' });
  const engine = (player as any).engine;
  return { player, engine, emit: (type: string, e: object) => engine.emitter.emit(type, { type, ...e }) };
}

describe('Player — programs, views and audio languages', () => {
  it('delegates selection and reads current state from the engine', async () => {
    const { player, engine } = setup();
    try {
      const selectProgram = vi.spyOn(engine, 'selectProgram').mockResolvedValue(undefined);
      const selectView = vi.spyOn(engine, 'selectView').mockResolvedValue(undefined);
      const selectAudioTrack = vi.spyOn(engine, 'selectAudioTrack').mockResolvedValue(undefined);
      vi.spyOn(engine, 'currentView', 'get').mockReturnValue(2);
      vi.spyOn(engine, 'currentAudioTrack', 'get').mockReturnValue('audio_es');

      await player.selectProgram(2);
      await player.selectView(1);
      await player.selectAudioTrack('audio_es');

      expect(selectProgram).toHaveBeenCalledWith(2);
      expect(selectView).toHaveBeenCalledWith(1);
      expect(selectAudioTrack).toHaveBeenCalledWith('audio_es');
      expect(player.currentView).toBe(2);
      expect(player.currentAudioTrackName).toBe('audio_es');
    } finally { await player.destroy(); }
  });

  it('a view change re-emits view_changed and loads the new view as the quality ladder', async () => {
    const { player, engine, emit } = setup();
    try {
      emit('catalog_received', { catalog: CATALOG });
      expect(player.levels.map((l) => l.trackName)).toEqual(['main_hi', 'main_lo']);

      const loaded = vi.fn();
      const quality = vi.fn();
      const viewChanged = vi.fn();
      player.on('levelsloaded', loaded);
      player.on('qualitychange', quality);
      player.on('view_changed', viewChanged);
      vi.spyOn(engine, 'availableVideoTracks', 'get').mockReturnValue([{ name: 'portrait' }]);

      emit('view_changed', { fromView: 1, toView: 2, trackName: 'portrait' });

      expect(player.levels.map((l) => [l.index, l.trackName])).toEqual([[0, 'portrait']]);
      expect(player.currentLevel).toBe(0);
      expect(loaded).toHaveBeenCalledWith({ levels: player.levels });
      expect(quality).toHaveBeenCalledWith({ level: player.levels[0], auto: true });
      expect(viewChanged).toHaveBeenCalledWith({ fromView: 1, toView: 2, trackName: 'portrait' });
    } finally { await player.destroy(); }
  });

  it('re-emits program and audio-track events without the engine type field', async () => {
    const { player, emit } = setup();
    try {
      const program = vi.fn();
      const audio = vi.fn();
      const failed = vi.fn();
      player.on('program_changed', program);
      player.on('audio_track_changed', audio);
      player.on('audio_track_switch_failed', failed);
      const error = new Error('changeType rejected');

      emit('program_changed', { fromProgram: 1, toProgram: 2 });
      emit('audio_track_changed', { fromTrackName: 'audio_en', toTrackName: 'audio_es', lang: 'es', reason: 'manual' });
      emit('audio_track_switch_failed', { fromTrackName: 'audio_es', toTrackName: 'audio_en', reason: 'manual', error });

      expect(program).toHaveBeenCalledWith({ fromProgram: 1, toProgram: 2 });
      expect(audio).toHaveBeenCalledWith({ fromTrackName: 'audio_en', toTrackName: 'audio_es', lang: 'es', reason: 'manual' });
      expect(failed).toHaveBeenCalledWith({ fromTrackName: 'audio_es', toTrackName: 'audio_en', reason: 'manual', error });
    } finally { await player.destroy(); }
  });
});
