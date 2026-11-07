import { describe, it, expect, vi, afterEach } from 'vitest';
import { describeBuild, parseSiteVersion, watchSiteBuild } from './build-info.js';

const response = (body: string, ok = true) => ({ ok, text: async () => body }) as Response;

describe('parseSiteVersion', () => {
  it.each([
    ['moq-playa 0.5.9+439f76c 2026-10-16T19:00:00.000Z\n', '0.5.9+439f76c', Date.parse('2026-10-16T19:00:00.000Z')],
    ['moq-playa 0.5.9+439f76c\n', '0.5.9+439f76c', null],
    ['0.6.0-rc.1+abcdef12-dirty', '0.6.0-rc.1+abcdef12-dirty', null],
  ])('reads %j', (text, build, builtAtMs) => {
    expect(parseSiteVersion(text)).toEqual({ build, builtAtMs });
  });

  it.each(['<!doctype html><html>', '', 'moq-playa', '0.5.9'])('rejects %j', (text) => {
    expect(parseSiteVersion(text)).toBeNull();
  });
});

describe('watchSiteBuild', () => {
  afterEach(() => { vi.useRealTimers(); });
  const PAGE = { pageBuild: '0.5.9+aaaaaaa', pageBuiltAt: '2026-10-16T12:00:00.000Z' };
  const version = (build: string, at?: string) => response(`moq-playa ${build}${at ? ` ${at}` : ''}`);

  it('reports a newer build after two matching reads, once, then stops', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => version('0.5.9+bbbbbbb', '2026-10-16T13:00:00.000Z'));
    const onNewer = vi.fn();
    watchSiteBuild(onNewer, { ...PAGE, fetchFn, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(onNewer).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(onNewer).toHaveBeenCalledTimes(1);
    expect(onNewer).toHaveBeenCalledWith('0.5.9+bbbbbbb');
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['this build', version('0.5.9+aaaaaaa', '2026-10-16T13:00:00.000Z')],
    ['an older build (a deploy in progress)', version('0.5.9+ccccccc', '2026-10-16T11:00:00.000Z')],
    ['a build without a time', version('0.5.9+bbbbbbb')],
    ['a page', response('<!doctype html>')],
    ['an error', response('', false)],
  ])('stays quiet on %s', async (_name, res) => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => res);
    const onNewer = vi.fn();
    const stop = watchSiteBuild(onNewer, { ...PAGE, fetchFn, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(4500);
    stop();
    expect(onNewer).not.toHaveBeenCalled();
  });

  it('a single odd read does not count', async () => {
    vi.useFakeTimers();
    const reads = [version('0.5.9+bbbbbbb', '2026-10-16T13:00:00.000Z'), version('0.5.9+aaaaaaa', '2026-10-16T12:00:00.000Z')];
    const fetchFn = vi.fn(async () => reads.shift() ?? version('0.5.9+aaaaaaa', '2026-10-16T12:00:00.000Z'));
    const onNewer = vi.fn();
    const stop = watchSiteBuild(onNewer, { ...PAGE, fetchFn, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(4500);
    stop();
    expect(onNewer).not.toHaveBeenCalled();
  });

  it('stays quiet when the page has no build time', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => version('0.5.9+bbbbbbb', '2026-10-16T13:00:00.000Z'));
    const onNewer = vi.fn();
    const stop = watchSiteBuild(onNewer, { pageBuild: '0.5.9+aaaaaaa', pageBuiltAt: null, fetchFn, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(4500);
    stop();
    expect(onNewer).not.toHaveBeenCalled();
  });
});

describe('describeBuild', () => {
  it('adds the build time when known', () => {
    const text = describeBuild('0.5.9+abcdef1', '2026-10-15T23:10:00.000Z');
    expect(text.startsWith('0.5.9+abcdef1 · built ')).toBe(true);
    expect(text).toMatch(/2026/);
  });

  it('is the bare build without a usable time', () => {
    expect(describeBuild('0.5.9+abcdef1', null)).toBe('0.5.9+abcdef1');
    expect(describeBuild('0.5.9+abcdef1', 'not a date')).toBe('0.5.9+abcdef1');
  });
});
