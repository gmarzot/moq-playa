import { describe, it, expect } from 'vitest';
import {
  SMOOTH_CEILING_MS, catalogIsLive, latencyReadout, migrateLatencyQuery, nextLiveState,
  parseLatencySettings, playbackLatency, postureLabel, targetText,
} from './latency-settings.js';

const q = (s: string): URLSearchParams => new URLSearchParams(s);
const fromUrl = (s: string, catalogMs?: number) => playbackLatency(parseLatencySettings(q(s)), catalogMs);

describe('URL to latency settings', () => {
  it('no targetLatency is Catalog', () => {
    expect(parseLatencySettings(q(''))).toEqual({ targetLatencyMs: undefined, congestionControl: undefined });
  });
  it('a typed target is kept', () => {
    expect(parseLatencySettings(q('targetLatency=500')).targetLatencyMs).toBe(500);
  });
  it('invalid targets fall back to Catalog', () => {
    for (const v of ['0', '-5', 'abc', '', ' ', 'Infinity']) {
      expect(parseLatencySettings(q(`targetLatency=${v}`)).targetLatencyMs).toBeUndefined();
    }
  });
  it('congestionControl takes its two values; anything else is the browser default', () => {
    expect(parseLatencySettings(q('congestionControl=low-latency')).congestionControl).toBe('low-latency');
    expect(parseLatencySettings(q('congestionControl=throughput')).congestionControl).toBe('throughput');
    expect(parseLatencySettings(q('congestionControl=bbr')).congestionControl).toBeUndefined();
  });
  it('labels each choice', () => {
    expect(postureLabel(undefined)).toBe('Browser default');
    expect(postureLabel('low-latency')).toBe('Low latency');
    expect(postureLabel('throughput')).toBe('Smooth');
  });
});

describe('settings to player options', () => {
  const smooth = (targetLatencyMs: number | undefined, smoothFloorMs: number | undefined) =>
    ({ latencyMode: 'smooth', targetLatencyMs, smoothFloorMs, smoothCeilingMs: SMOOTH_CEILING_MS });
  it('Low latency holds the target, live', () => {
    expect(fromUrl('congestionControl=low-latency&targetLatency=300', 205)).toEqual(
      { latencyMode: 'live', targetLatencyMs: 300, smoothFloorMs: undefined, smoothCeilingMs: undefined });
    expect(fromUrl('congestionControl=low-latency', 205).targetLatencyMs).toBeUndefined();
  });
  it('Browser default and Smooth adapt from the typed target', () => {
    expect(fromUrl('targetLatency=800', 205)).toEqual(smooth(800, 800));
    expect(fromUrl('congestionControl=throughput&targetLatency=800', 205)).toEqual(smooth(800, 800));
  });
  it('on Catalog they adapt from the catalog target', () => {
    expect(fromUrl('', 205)).toEqual(smooth(undefined, 205));
    expect(fromUrl('congestionControl=throughput', 205)).toEqual(smooth(undefined, 205));
  });
  it('with no target anywhere the engine default floor stays', () => {
    expect(fromUrl('').smoothFloorMs).toBeUndefined();
    expect(fromUrl('congestionControl=throughput', 0).smoothFloorMs).toBeUndefined();
  });
  it('a target above the bound lifts the ceiling to it', () => {
    expect(fromUrl('congestionControl=throughput&targetLatency=5000').smoothCeilingMs).toBe(5000);
  });
});

describe('retired latency params', () => {
  it('leave a query without them alone', () => {
    expect(migrateLatencyQuery(q('ns=live&targetLatency=300'))).toBeNull();
  });
  it('latency=smooth with min and max becomes a target at the min', () => {
    const m = migrateLatencyQuery(q('ns=a&latency=smooth&latencyMin=1000&latencyMax=2000'))!;
    expect(m.toString()).toBe('ns=a&targetLatency=1000');
  });
  it('congestionControl keeps the posture', () => {
    const m = migrateLatencyQuery(q('latency=smooth&latencyMin=1000&congestionControl=low-latency'))!;
    expect(m.toString()).toBe('congestionControl=low-latency&targetLatency=1000');
  });
  it('latency=smooth alone is Catalog', () => {
    expect(migrateLatencyQuery(q('latency=smooth'))!.toString()).toBe('');
  });
  it('latencyMin replaces an older target, since the delay started there', () => {
    const m = migrateLatencyQuery(q('targetLatency=200&latency=smooth&latencyMin=2000'))!;
    expect(m.get('targetLatency')).toBe('2000');
  });
  it('an invalid or zero latencyMin sets no target', () => {
    for (const v of ['0', 'x', '-1', '']) {
      expect(migrateLatencyQuery(q(`latency=smooth&latencyMin=${v}`))!.has('targetLatency')).toBe(false);
    }
  });
  it('latency=live and min/max without smooth are dropped', () => {
    expect(migrateLatencyQuery(q('latency=live&ns=a'))!.toString()).toBe('ns=a');
    expect(migrateLatencyQuery(q('latencyMin=1000&latencyMax=2000'))!.toString()).toBe('');
  });
  it('the result parses as the new settings', () => {
    const m = migrateLatencyQuery(q('latency=smooth&latencyMin=1500&latencyMax=2500&congestionControl=throughput'))!;
    expect(playbackLatency(parseLatencySettings(m))).toEqual(
      { latencyMode: 'smooth', targetLatencyMs: 1500, smoothFloorMs: 1500, smoothCeilingMs: SMOOTH_CEILING_MS });
    expect(migrateLatencyQuery(m)).toBeNull();
  });
});

describe('readout', () => {
  it('names where the target came from', () => {
    expect(targetText(500, 205)).toBe('target 500 ms');
    expect(targetText(undefined, 205)).toBe('target 205 ms (catalog)');
    expect(targetText(undefined, 0)).toBe('target default');
  });
  it('shows measured latency in seconds next to the target', () => {
    expect(latencyReadout(1012, 'target 205 ms (catalog)')).toBe('1.0 s · target 205 ms (catalog)');
    expect(latencyReadout(null, 'target 500 ms')).toBe('— · target 500 ms');
    expect(latencyReadout(NaN, 'target 500 ms')).toBe('— · target 500 ms');
  });
});

describe('LIVE indicator', () => {
  const tracks = (isLive: boolean | undefined) => [
    { name: 'catalog' },
    { name: 'video', role: 'video', codec: 'avc1', ...(isLive === undefined ? {} : { isLive }) },
    { name: 'audio', role: 'audio', codec: 'opus', ...(isLive === undefined ? {} : { isLive }) },
  ];
  it('reads isLive from the media tracks', () => {
    expect(catalogIsLive(tracks(true))).toBe(true);
    expect(catalogIsLive(tracks(false))).toBe(false);
    expect(catalogIsLive(tracks(undefined))).toBeUndefined();
    expect(catalogIsLive([{ name: 'timeline', isLive: false }, { role: 'video', isLive: true }])).toBe(true);
    expect(catalogIsLive([null, 3, 'x'])).toBeUndefined();
  });
  it('true is LIVE', () => {
    expect(nextLiveState(null, true)).toBe('live');
  });
  it('true then false is ENDED, and stays ENDED', () => {
    expect(nextLiveState('live', false)).toBe('ended');
    expect(nextLiveState('ended', false)).toBe('ended');
  });
  it('false from the start is VOD', () => {
    expect(nextLiveState(null, false)).toBe('vod');
    expect(nextLiveState('vod', false)).toBe('vod');
  });
  it('missing isLive is treated as live', () => {
    expect(nextLiveState(null, undefined)).toBe('live');
    expect(nextLiveState('live', undefined)).toBe('live');
  });
  it('live again after ENDED is LIVE', () => {
    expect(nextLiveState('ended', true)).toBe('live');
  });
});
