/**
 * QualityController tests — red/green TDD.
 *
 * Uses @moqt/msf selection APIs (groupByAlt, selectTrack) for ABR.
 * Responds to recovery actions by selecting lower quality tracks.
 *
 * @see draft-ietf-moq-msf-00 §5.1.19 (altGroup)
 * @see draft-ietf-moq-msf-00 §4.2 (time-alignment at group boundaries)
 * @module
 */

import { describe, it, expect } from 'vitest';
import { QualityController } from './quality-controller.js';
import type { CatalogTrack, CatalogState } from '@moqt/msf';
import type { ClockSource } from '@moqt/playback';

class MockClock implements ClockSource {
  private _now = 0;
  now(): number { return this._now; }
  advance(us: number): void { this._now += us; }
  set(us: number): void { this._now = us; }
}

/** Test catalog with video altGroup (3 qualities) + 1 audio track. */
function createTestCatalog(): CatalogState {
  return {
    version: 1,
    tracks: [
      {
        name: 'video-1080p',
        packaging: 'loc' as const,
        isLive: true,
        role: 'video' as const,
        renderGroup: 1,
        altGroup: 1,
        codec: 'av01.0.08M.10',
        width: 1920,
        height: 1080,
        bitrate: 3_000_000,
      },
      {
        name: 'video-720p',
        packaging: 'loc' as const,
        isLive: true,
        role: 'video' as const,
        renderGroup: 1,
        altGroup: 1,
        codec: 'av01.0.05M.10',
        width: 1280,
        height: 720,
        bitrate: 1_500_000,
      },
      {
        name: 'video-360p',
        packaging: 'loc' as const,
        isLive: true,
        role: 'video' as const,
        renderGroup: 1,
        altGroup: 1,
        codec: 'av01.0.04M.10',
        width: 640,
        height: 360,
        bitrate: 300_000,
      },
      {
        name: 'audio',
        packaging: 'loc' as const,
        isLive: true,
        role: 'audio' as const,
        renderGroup: 1,
        codec: 'opus',
        samplerate: 48000,
        channelConfig: '2',
        bitrate: 32000,
      },
    ],
  };
}

describe('QualityController', () => {
  it('auto start-level picks middle of video ladder (safe default)', () => {
    const qc = new QualityController();
    const catalog = createTestCatalog(); // 3 tracks: 1080p, 720p, 360p
    const selected = qc.selectInitialTracks(catalog);

    // Middle of 3 = index 1 = 720p. Not highest (avoids catastrophic
    // stall on constrained networks) and not lowest (looks reasonable).
    expect(selected.video?.name).toBe('video-720p');
    expect(selected.audio?.name).toBe('audio');
  });

  it('auto start-level on 4-track ladder picks index 2', () => {
    const qc = new QualityController();
    const catalog: CatalogState = {
      version: 1,
      tracks: [
        { name: 'v-1080p', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 4000000 },
        { name: 'v-720p', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 1500000 },
        { name: 'v-480p', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 600000 },
        { name: 'v-240p', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 150000 },
      ],
    };
    const selected = qc.selectInitialTracks(catalog);
    expect(selected.video?.name).toBe('v-480p'); // index 2 = Math.floor(4/2)
  });

  it('auto start-level on 2-track ladder picks index 1 (lower)', () => {
    const qc = new QualityController();
    const catalog: CatalogState = {
      version: 1,
      tracks: [
        { name: 'v-high', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 3000000 },
        { name: 'v-low', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 300000 },
      ],
    };
    const selected = qc.selectInitialTracks(catalog);
    expect(selected.video?.name).toBe('v-low'); // index 1 = Math.floor(2/2)
  });

  it('auto start-level on 1-track ladder picks the only track', () => {
    const qc = new QualityController();
    const catalog: CatalogState = {
      version: 1,
      tracks: [
        { name: 'v-only', packaging: 'loc' as const, isLive: true, role: 'video' as const, renderGroup: 1, altGroup: 1, bitrate: 3000000 },
      ],
    };
    const selected = qc.selectInitialTracks(catalog);
    expect(selected.video?.name).toBe('v-only'); // index 0 = Math.floor(1/2)
  });

  it('selectInitialTracks applies video constraints', () => {
    const qc = new QualityController();
    const catalog = createTestCatalog();
    const selected = qc.selectInitialTracks(catalog, {
      videoConstraints: { maxHeight: 720 },
    });

    expect(selected.video?.name).toBe('video-720p');
  });

  it('reduceVideoQuality picks next-lower bitrate from altGroup', () => {
    const qc = new QualityController();
    const catalog = createTestCatalog();
    qc.selectInitialTracks(catalog); // starts at 720p (middle)

    const lower = qc.reduceVideoQuality();
    expect(lower?.name).toBe('video-360p');
  });

  it('reduceVideoQuality returns null when already at lowest', () => {
    const qc = new QualityController();
    const catalog = createTestCatalog();
    qc.selectInitialTracks(catalog); // starts at 720p

    qc.reduceVideoQuality(); // → 360p
    const result = qc.reduceVideoQuality(); // → null (already lowest)
    expect(result).toBeNull();
  });

  it('currentVideoTrack reflects the active track', () => {
    const qc = new QualityController();
    const catalog = createTestCatalog();
    qc.selectInitialTracks(catalog); // starts at 720p (middle)

    expect(qc.currentVideoTrack?.name).toBe('video-720p');
    qc.reduceVideoQuality();
    expect(qc.currentVideoTrack?.name).toBe('video-360p');
  });

  it('returns null video/audio if catalog has no matching tracks', () => {
    const qc = new QualityController();
    const emptyCatalog: CatalogState = { version: 1, tracks: [] };
    const selected = qc.selectInitialTracks(emptyCatalog);

    expect(selected.video).toBeUndefined();
    expect(selected.audio).toBeUndefined();
  });

  it('never selects a locmaf track with an unsupported locmafVersion; supported locmaf is selectable like cmaf (LOCMAF §5)', () => {
    const qc = new QualityController();
    const catalog: CatalogState = {
      version: 1,
      tracks: [
        { name: 'v-locmaf-future', packaging: 'locmaf', locmafVersion: '9.9', isLive: true, role: 'video', altGroup: 1, codec: 'avc1.640028', bitrate: 4_000_000 },
        { name: 'v-locmaf', packaging: 'locmaf', locmafVersion: '0.3', isLive: true, role: 'video', altGroup: 1, codec: 'avc1.640028', bitrate: 2_000_000 },
        { name: 'v-cmaf', packaging: 'cmaf', isLive: true, role: 'video', altGroup: 1, codec: 'avc1.640028', bitrate: 1_000_000 },
        { name: 'a-future', packaging: 'locmaf', locmafVersion: '9.9', isLive: true, role: 'audio', codec: 'mp4a.40.2' },
        { name: 'a-loc', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus' },
      ],
    };
    const selected = qc.selectInitialTracks(catalog);
    const names = qc.allAlternatives.map((t) => t.name);
    expect(names).toEqual(['v-locmaf', 'v-cmaf']);
    expect(selected.video?.name).not.toBe('v-locmaf-future');
    expect(selected.audio?.name).toBe('a-loc');
  });

  it('handles catalog with single video quality (no altGroup)', () => {
    const qc = new QualityController();
    const catalog: CatalogState = {
      version: 1,
      tracks: [
        {
          name: 'video',
          packaging: 'loc',
          isLive: true,
          role: 'video',
          codec: 'avc1.42E01E',
          width: 1280,
          height: 720,
          bitrate: 1_000_000,
        },
      ],
    };
    const selected = qc.selectInitialTracks(catalog);
    expect(selected.video?.name).toBe('video');

    // Can't reduce — no alt group
    expect(qc.reduceVideoQuality()).toBeNull();
  });

  it('audio tracks are not in altGroups for quality reduction', () => {
    const qc = new QualityController();
    const catalog = createTestCatalog();
    qc.selectInitialTracks(catalog);

    expect(qc.currentAudioTrack?.name).toBe('audio');
  });

  // ─── Config options ─────────────────────────────────────────

  it('startLevel "lowest" picks lowest bitrate', () => {
    const clock = new MockClock();
    const qc = new QualityController({
      autoQuality: true,
      startLevel: 'lowest',
      qualitySwitchCooldownMs: 5_000,
      clock,
    });
    const catalog = createTestCatalog();
    const selected = qc.selectInitialTracks(catalog);

    expect(selected.video?.name).toBe('video-360p');
  });

  it('startLevel number picks track by index', () => {
    const clock = new MockClock();
    const qc = new QualityController({
      autoQuality: true,
      startLevel: 1,
      qualitySwitchCooldownMs: 5_000,
      clock,
    });
    const catalog = createTestCatalog();
    const selected = qc.selectInitialTracks(catalog);

    // Index 1 in bitrate-descending order = 720p
    expect(selected.video?.name).toBe('video-720p');
  });

  it('startLevel number is clamped to range', () => {
    const clock = new MockClock();
    const qc = new QualityController({
      autoQuality: true,
      startLevel: 999, // way beyond available tracks
      qualitySwitchCooldownMs: 5_000,
      clock,
    });
    const catalog = createTestCatalog();
    const selected = qc.selectInitialTracks(catalog);

    // Clamped to last (lowest bitrate)
    expect(selected.video?.name).toBe('video-360p');
  });

  it('capLevelToResolution filters out tracks above cap', () => {
    const clock = new MockClock();
    const qc = new QualityController({
      autoQuality: true,
      startLevel: 'auto',
      capLevelToResolution: { width: 1280, height: 720 },
      qualitySwitchCooldownMs: 5_000,
      clock,
    });
    const catalog = createTestCatalog();
    const selected = qc.selectInitialTracks(catalog);

    // 1080p filtered out → remaining [720p, 360p] → middle = index 1 = 360p
    expect(selected.video?.name).toBe('video-360p');
  });

  it('autoQuality false prevents reduceVideoQuality', () => {
    const clock = new MockClock();
    const qc = new QualityController({
      autoQuality: false,
      startLevel: 'auto',
      qualitySwitchCooldownMs: 5_000,
      clock,
    });
    const catalog = createTestCatalog();
    qc.selectInitialTracks(catalog);

    expect(qc.reduceVideoQuality()).toBeNull();
  });

  it('qualitySwitchCooldownMs prevents rapid switches', () => {
    const clock = new MockClock();
    const qc = new QualityController({
      autoQuality: true,
      startLevel: 'auto',
      qualitySwitchCooldownMs: 5_000,
      clock,
    });
    const catalog = createTestCatalog();
    qc.selectInitialTracks(catalog);

    // Starts at 720p (middle). First switch — should work
    const first = qc.reduceVideoQuality();
    expect(first?.name).toBe('video-360p');

    // Second switch immediately — blocked by cooldown (already at lowest anyway)
    const second = qc.reduceVideoQuality();
    expect(second).toBeNull();
  });
});

describe('QualityController — video views (altGroups)', () => {
  const video = (name: string, altGroup: number | undefined, bitrate: number, width = 1280, height = 720): CatalogTrack => ({
    name, packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f',
    width, height, bitrate, ...(altGroup !== undefined ? { altGroup } : {}),
  });
  const audio: CatalogTrack = { name: 'audio', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus' };
  const defaultConfig = () => ({
    autoQuality: true, startLevel: 'auto' as const, qualitySwitchCooldownMs: 0, clock: new MockClock(),
  });
  const twoViews = (): CatalogState => ({
    version: 1,
    tracks: [
      video('land-hi', 1, 3_000_000), video('land-lo', 1, 1_000_000),
      video('port-hi', 2, 2_500_000, 720, 1280), video('port-lo', 2, 800_000, 720, 1280),
      audio,
    ],
  });

  it('treats each altGroup as a view and runs ABR inside the first one', () => {
    const qc = new QualityController();
    const sel = qc.selectInitialTracks(twoViews());
    expect(qc.views.map(v => v.altGroup)).toEqual([1, 2]);
    expect(qc.currentView).toBe(1);
    expect(qc.allAlternatives.map(t => t.name)).toEqual(['land-hi', 'land-lo']);
    expect(sel.video?.name).toBe('land-lo');
    expect(sel.audio?.name).toBe('audio');
  });

  it('starts on initialView, falling back to the first view when unknown', () => {
    const qc = new QualityController({ ...defaultConfig(), initialView: 2 });
    qc.selectInitialTracks(twoViews());
    expect(qc.currentView).toBe(2);
    expect(qc.allAlternatives.map(t => t.name)).toEqual(['port-hi', 'port-lo']);

    const fallback = new QualityController({ ...defaultConfig(), initialView: 9 });
    fallback.selectInitialTracks(twoViews());
    expect(fallback.currentView).toBe(1);
  });

  it('has no views without altGroups (single implicit view)', () => {
    const qc = new QualityController();
    qc.selectInitialTracks({ version: 1, tracks: [video('a', undefined, 1), video('b', undefined, 2), audio] });
    expect(qc.views).toEqual([]);
    expect(qc.currentView).toBeUndefined();
    expect(qc.allAlternatives.map(t => t.name)).toEqual(['b', 'a']);
  });

  it('peekViewTrack keeps the current ABR level and does not mutate state', () => {
    const qc = new QualityController({ ...defaultConfig(), startLevel: 0 });
    qc.selectInitialTracks(twoViews());
    expect(qc.currentVideoTrack?.name).toBe('land-hi');
    // land-hi 3 Mb/s → highest portrait track not above it.
    expect(qc.peekViewTrack(2)?.name).toBe('port-hi');
    qc.commitVideoTrack('land-lo');
    // land-lo 1 Mb/s → port-lo (800 kb/s).
    expect(qc.peekViewTrack(2)?.name).toBe('port-lo');
    expect(qc.currentView).toBe(1);
    expect(qc.peekViewTrack(7)).toBeUndefined();
  });

  it('commitVideoTrack on another view moves ABR to that view', () => {
    const qc = new QualityController();
    qc.selectInitialTracks(twoViews());
    qc.commitVideoTrack('port-hi');
    expect(qc.currentView).toBe(2);
    expect(qc.currentVideoTrack?.name).toBe('port-hi');
    expect(qc.alternatives.map(t => t.name)).toEqual(['port-hi', 'port-lo']);
    expect(qc.viewOf('land-lo')).toBe(1);
  });
});

describe('QualityController — programs (renderGroups) and audio languages', () => {
  // The handoff's booth + match catalog, in its stream order.
  const booth = (): CatalogState => ({
    version: 1,
    tracks: [
      { name: 'video_booth', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', bitrate: 3_000_000, altGroup: 4, renderGroup: 1, label: 'Commentator Booth' },
      { name: 'video_match_main', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', bitrate: 3_000_000, altGroup: 1, renderGroup: 2, label: 'Main Camera' },
      { name: 'video_match_cam2', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', bitrate: 3_000_000, altGroup: 2, renderGroup: 2, label: 'Tactical' },
      { name: 'audio_booth', packaging: 'loc', isLive: true, role: 'audio', codec: 'mp4a.40.2', renderGroup: 1 },
      { name: 'audio_match_en', packaging: 'loc', isLive: true, role: 'audio', codec: 'mp4a.40.2', altGroup: 3, renderGroup: 2, lang: 'en' },
      { name: 'audio_match_es', packaging: 'loc', isLive: true, role: 'audio', codec: 'mp4a.40.2', altGroup: 3, renderGroup: 2, lang: 'es' },
    ],
  });
  const config = (extra: object = {}) => ({
    autoQuality: true, startLevel: 'auto' as const, qualitySwitchCooldownMs: 0, clock: new MockClock(), ...extra,
  });

  it('starts on the first video\'s program and only offers that program\'s views and audio', () => {
    const qc = new QualityController(config());
    const sel = qc.selectInitialTracks(booth());
    expect(qc.programs.map(p => p.renderGroup)).toEqual([1, 2]);
    expect(qc.currentProgram).toBe(1);
    expect(qc.views.map(v => v.altGroup)).toEqual([4]);
    expect(qc.audioTracks.map(t => t.name)).toEqual(['audio_booth']);
    expect(sel).toMatchObject({ video: { name: 'video_booth' }, audio: { name: 'audio_booth' } });
  });

  it('starts on initialProgram, picking the preferred language on the primary subtag', () => {
    const qc = new QualityController(config({ initialProgram: 2, preferredLanguage: 'ES-mx' }));
    const sel = qc.selectInitialTracks(booth());
    expect(qc.currentProgram).toBe(2);
    expect(qc.views.map(v => v.altGroup)).toEqual([1, 2]);
    expect(sel).toMatchObject({ video: { name: 'video_match_main' }, audio: { name: 'audio_match_es' } });
  });

  it('never lets a language preference empty the audio choice', () => {
    const qc = new QualityController(config({ initialProgram: 2, preferredLanguage: 'fr' }));
    expect(qc.selectInitialTracks(booth()).audio?.name).toBe('audio_match_en');
    const lone = new QualityController(config({ preferredLanguage: 'fr' }));
    expect(lone.selectInitialTracks({
      version: 1,
      tracks: [{ name: 'a', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus', lang: 'de' }],
    }).audio?.name).toBe('a');
  });

  it('initialView of another program selects that program', () => {
    const qc = new QualityController(config({ initialView: 2, initialProgram: 1 }));
    const sel = qc.selectInitialTracks(booth());
    expect(qc.currentProgram).toBe(2);
    expect(qc.currentView).toBe(2);
    expect(sel.video?.name).toBe('video_match_cam2');
  });

  it('peekProgramTracks keeps the language when the program has it, without mutating', () => {
    const qc = new QualityController(config({ initialProgram: 2, preferredLanguage: 'es' }));
    qc.selectInitialTracks(booth());
    expect(qc.peekProgramTracks(1)).toMatchObject({ video: { name: 'video_booth' }, audio: { name: 'audio_booth' } });
    expect(qc.currentProgram).toBe(2);

    const fromBooth = new QualityController(config({ preferredLanguage: 'es' }));
    fromBooth.selectInitialTracks(booth());
    // The booth audio has no lang, so the preference decides.
    expect(fromBooth.peekProgramTracks(2)).toMatchObject({ video: { name: 'video_match_main' }, audio: { name: 'audio_match_es' } });
    expect(fromBooth.peekProgramTracks(9)).toBeUndefined();
  });

  it('committing a track of another program moves the program, its views and its audio list', () => {
    const qc = new QualityController(config());
    qc.selectInitialTracks(booth());
    qc.commitVideoTrack('video_match_main');
    expect(qc.currentProgram).toBe(2);
    expect(qc.currentView).toBe(1);
    expect(qc.views.map(v => v.altGroup)).toEqual([1, 2]);
    expect(qc.audioTracks.map(t => t.name)).toEqual(['audio_match_en', 'audio_match_es']);
    qc.commitAudioTrack('audio_match_es');
    expect(qc.currentAudioTrack?.name).toBe('audio_match_es');
    expect(qc.currentProgram).toBe(2);
  });

  it('matches ISO 639-2 and regional preferences to the catalog\'s 2-letter tags', () => {
    for (const pref of ['spa', 'es-419', 'ES']) {
      const qc = new QualityController(config({ initialProgram: 2, preferredLanguage: pref }));
      expect(qc.selectInitialTracks(booth()).audio?.name).toBe('audio_match_es');
    }
  });

  it('moves the ABR ladder with a program that has no altGroups', () => {
    const qc = new QualityController(config());
    const v = (name: string, rg: number, bitrate: number): CatalogTrack =>
      ({ name, packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', renderGroup: rg, bitrate });
    qc.selectInitialTracks({ version: 1, tracks: [v('a_hi', 1, 3e6), v('a_lo', 1, 1e6), v('b_hi', 2, 3e6), v('b_lo', 2, 1e6)] });
    expect(qc.alternatives.map(t => t.name)).toEqual(['a_hi', 'a_lo']);
    qc.commitVideoTrack('b_lo');
    expect(qc.currentProgram).toBe(2);
    expect(qc.alternatives.map(t => t.name)).toEqual(['b_hi', 'b_lo']);
    expect(qc.currentVideoTrack?.name).toBe('b_lo');
  });

  it('never lets the resolution cap empty a view (portrait under a landscape cap)', () => {
    const cat: CatalogState = {
      version: 1,
      tracks: [
        { name: 'land', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', width: 1280, height: 720, altGroup: 1 },
        { name: 'port', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', width: 720, height: 1280, altGroup: 2 },
      ],
    };
    const qc = new QualityController(config({ initialView: 2, capLevelToResolution: { width: 1280, height: 720 } }));
    expect(qc.selectInitialTracks(cat).video?.name).toBe('port');
    expect(qc.peekViewTrack(1)?.name).toBe('land');
  });

  it('keeps currentVideoTrack truthful after a manual pick of another codec family', () => {
    const qc = new QualityController(config({ startLevel: 0 }));
    qc.selectInitialTracks({
      version: 1,
      tracks: [
        { name: 'avc', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', bitrate: 3e6, altGroup: 1 },
        { name: 'hevc', packaging: 'loc', isLive: true, role: 'video', codec: 'hvc1.1.6.L93.90', bitrate: 2e6, altGroup: 1 },
      ],
    });
    expect(qc.currentVideoTrack?.name).toBe('avc');
    qc.commitVideoTrack('hevc');
    expect(qc.currentVideoTrack?.name).toBe('hevc');
  });

  it('falls back from a language preference rather than lose audio to constraints', () => {
    const qc = new QualityController(config({ preferredLanguage: 'es' }));
    const sel = qc.selectInitialTracks({
      version: 1,
      tracks: [
        { name: 'es_aac', packaging: 'loc', isLive: true, role: 'audio', codec: 'mp4a.40.2', lang: 'es' },
        { name: 'en_opus', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus', lang: 'en' },
      ],
    }, { audioConstraints: { codec: 'opus' } });
    expect(sel.audio?.name).toBe('en_opus');
  });

  it('prefers the exact regional tag over another region of the language', () => {
    const qc = new QualityController(config({ preferredLanguage: 'pt-BR' }));
    expect(qc.selectInitialTracks({
      version: 1,
      tracks: [
        { name: 'pt_pt', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus', lang: 'pt-PT' },
        { name: 'pt_br', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus', lang: 'pt-BR' },
      ],
    }).audio?.name).toBe('pt_br');
  });

  it('honours initialProgram when it also holds initialView', () => {
    const v = (name: string, alt: number, rg: number): CatalogTrack =>
      ({ name, packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', altGroup: alt, renderGroup: rg });
    const qc = new QualityController(config({ initialProgram: 2, initialView: 1 }));
    expect(qc.selectInitialTracks({ version: 1, tracks: [v('a', 1, 1), v('b', 1, 2)] }).video?.name).toBe('b');
  });

  it('keeps audio when video and audio carry different renderGroups', () => {
    const qc = new QualityController(config());
    const sel = qc.selectInitialTracks({
      version: 1,
      tracks: [
        { name: 'v', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', renderGroup: 1 },
        { name: 'a', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus', renderGroup: 2 },
      ],
    });
    expect(sel).toMatchObject({ video: { name: 'v' }, audio: { name: 'a' } });
  });

  it('follows catalog updates while keeping the current program, view and tracks', () => {
    const qc = new QualityController(config({ initialProgram: 2 }));
    qc.selectInitialTracks(booth());
    qc.commitAudioTrack('audio_match_es');
    const updated = booth();
    const added = { ...updated, tracks: [...updated.tracks,
      { name: 'audio_match_de', packaging: 'loc' as const, isLive: true, role: 'audio' as const, codec: 'mp4a.40.2', altGroup: 3, renderGroup: 2, lang: 'de' }] };
    expect(qc.updateCatalog(added)).toBe(false);
    expect(qc.currentProgram).toBe(2);
    expect(qc.currentView).toBe(1);
    expect(qc.currentAudioTrack?.name).toBe('audio_match_es');
    expect(qc.audioTracks.map(t => t.name)).toEqual(['audio_match_en', 'audio_match_es', 'audio_match_de']);
  });

  it('keeps tracks without a renderGroup in every program', () => {
    const qc = new QualityController(config({ initialProgram: 2 }));
    qc.selectInitialTracks({
      version: 1,
      tracks: [
        { name: 'v1', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', altGroup: 1, renderGroup: 1 },
        { name: 'v2', packaging: 'loc', isLive: true, role: 'video', codec: 'avc1.64001f', altGroup: 2, renderGroup: 2 },
        { name: 'shared_audio', packaging: 'loc', isLive: true, role: 'audio', codec: 'opus' },
      ],
    });
    expect(qc.programs.map(p => p.tracks.map(t => t.name))).toEqual([['v1', 'shared_audio'], ['v2', 'shared_audio']]);
    expect(qc.audioTracks.map(t => t.name)).toEqual(['shared_audio']);
    expect(qc.currentAudioTrack?.name).toBe('shared_audio');
  });
});
