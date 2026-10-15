import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseSiteVersion, watchSiteBuild, PAGE_BUILD } from './build-info.js';

const response = (body: string, ok = true) => ({ ok, text: async () => body }) as Response;

describe('parseSiteVersion', () => {
  it.each([
    ['moq-playa 0.5.9+439f76c\n', '0.5.9+439f76c'],
    ['0.5.9+439f76c', '0.5.9+439f76c'],
    ['moq-playa 0.6.0-rc.1+abcdef12-dirty', '0.6.0-rc.1+abcdef12-dirty'],
  ])('reads %j', (text, build) => {
    expect(parseSiteVersion(text)).toBe(build);
  });

  it.each(['<!doctype html><html>', '', 'moq-playa', '0.5.9'])('rejects %j', (text) => {
    expect(parseSiteVersion(text)).toBeNull();
  });
});

describe('watchSiteBuild', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('reports a different build once, then stops polling', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async () => response('moq-playa 0.5.9+aaaaaaa'));
    const onNewer = vi.fn();
    watchSiteBuild(onNewer, { fetchFn, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3500);
    expect(onNewer).toHaveBeenCalledTimes(1);
    expect(onNewer).toHaveBeenCalledWith('0.5.9+aaaaaaa');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the site serves this build, a page, or an error', async () => {
    vi.useFakeTimers();
    const bodies = [response(`moq-playa ${PAGE_BUILD}`), response('<!doctype html>'), response('', false)];
    const fetchFn = vi.fn(async () => bodies.shift() ?? Promise.reject(new Error('offline')));
    const onNewer = vi.fn();
    const stop = watchSiteBuild(onNewer, { fetchFn, intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(4500);
    stop();
    expect(onNewer).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
});
