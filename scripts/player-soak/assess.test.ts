import { describe, it, expect, vi } from 'vitest';
import type { PlaybackSample } from '../player-acceptance/assessment.mjs';
import { assessSoak, latencyReport, quietIntervals } from './assess.mjs';
import { MttClient } from './mtt.mjs';

/** 250 ms samples; `frame(i)` gives the varying fields of sample i. */
function samples(n: number, frame: (i: number) => Partial<PlaybackSample>): PlaybackSample[] {
  return Array.from({ length: n }, (_, i) => ({
    outputKind: 'video', wallMs: i * 250, mediaTimeS: i * 0.25, presentedMediaTimeS: i * 0.25,
    presentedFrames: i * 7.5, pictureDigest: String(i), pictureChange: 5, markerRgb: [0, 0, 0],
    videoWidth: 1280, videoHeight: 720, audioRms: 0.2, audioPeakHz: 440, paused: false, seeking: false,
    visibility: 'visible', bufferedRanges: [], ...frame(i),
  }));
}

describe('player soak assessment', () => {
  it('finds a stall, a frozen picture and an audio gap with their lengths', () => {
    const s = samples(40, (i) => (i >= 10 && i < 20 ? { mediaTimeS: 2.5, pictureDigest: '10', audioRms: 0 } : {}));
    const r = assessSoak({ samples: s, ticks: [] });
    expect(r.verdict).toBe('played');
    // Measured from the first sample that did not advance.
    expect(r.playback.stalls).toEqual({ count: 1, totalMs: 2250, longestMs: 2250 });
    expect(r.playback.frozen.count).toBe(1);
    expect(r.playback.audioGaps).toEqual({ count: 1, totalMs: 2500, longestMs: 2500 });
    expect(r.playback.fps.mean).toBeGreaterThan(29);
  });

  it('reports an interval still open at the end', () => {
    const s = samples(10, (i) => (i >= 6 ? { audioRms: 0 } : {}));
    expect(quietIntervals(s, (x) => x.audioRms > 0.015, 500)).toEqual([{ startMs: 1500, durationMs: 750, open: true }]);
  });

  it('is no-playback when the playhead never moves', () => {
    expect(assessSoak({ samples: samples(20, () => ({ mediaTimeS: 1, presentedFrames: 3 })), ticks: [] }).verdict)
      .toBe('no-playback');
  });

  it('summarizes latency per minute and its drift', () => {
    const ticks = Array.from({ length: 180 }, (_, i) => ({
      wallEpochMs: 1_000_000 + i * 1000,
      latency: { 'video/property': { n: 30, min: 50, p50: 60 + Math.floor(i / 60) * 10, p95: 90, max: 120 } },
    }));
    const r = latencyReport(ticks)['video/property']!;
    expect(r.perMinute.map((m) => m.p50)).toEqual([60, 70, 80]);
    expect(r.driftMs).toBe(20);
    expect(r.max).toBe(120);
  });

  it('takes player counters as deltas over the run', () => {
    const ticks = [
      { wallEpochMs: 0, stats: { stallCount: 2, stallDurationMs: 300, framesDropped: 5, audioUnderruns: 1, gapCount: 0, framesRendered: 10, avSkewMs: 4, cushionMs: 200 } },
      { wallEpochMs: 1000, stats: { stallCount: 3, stallDurationMs: 800, framesDropped: 9, audioUnderruns: 1, gapCount: 2, framesRendered: 40, avSkewMs: -8, cushionMs: 150 } },
    ];
    const r = assessSoak({ samples: samples(8, () => ({})), ticks });
    expect(r.player).toMatchObject({ stallCount: 1, stallDurationMs: 500, framesDropped: 4, audioUnderruns: 0, gapCount: 2, framesRendered: 30 });
    expect(r.player.avSkewMs).toEqual({ p50: 4, max: 8 });
  });
});

describe('moq-test-tracks client', () => {
  it('retries a job over a cap, then waits for it to run', async () => {
    vi.useFakeTimers();
    const replies = [
      new Response('{"error":"cap"}', { status: 429 }),
      new Response('{"id":"j1","state":"starting","joined":false}', { status: 201 }),
      new Response('{"id":"j1","state":"running"}', { status: 200 }),
      new Response(null, { status: 204 }),
    ];
    const fetchImpl = vi.fn(async () => replies.shift()!);
    const client = new MttClient({ key: 'k', base: 'https://mtt.example/', fetchImpl });
    const started = client.start({ namespace: 'ns', relay: 'moqx-main', draft: 18 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await started).id).toBe('j1');
    await expect(client.waitRunning('j1')).resolves.toMatchObject({ state: 'running' });
    await client.stop('j1');
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'POST https://mtt.example/api/v1/jobs', 'POST https://mtt.example/api/v1/jobs',
      'GET https://mtt.example/api/v1/jobs/j1', 'DELETE https://mtt.example/api/v1/jobs/j1',
    ]);
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe('Bearer k');
    vi.useRealTimers();
  });
});
