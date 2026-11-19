import { describe, it, expect, vi } from 'vitest';
import type { PlaybackSample } from '../player-acceptance/assessment.mjs';
import { abrReport, abrSwitch, assessSoak, latencyReport, quietIntervals, recoveryReport } from './assess.mjs';
import { MttClient } from './mtt.mjs';

const T0 = 1_000_000;

/** 250 ms samples; `frame(i)` gives the varying fields of sample i. */
function samples(n: number, frame: (i: number) => Partial<PlaybackSample>): PlaybackSample[] {
  return Array.from({ length: n }, (_, i) => ({
    outputKind: 'video', wallMs: i * 250, wallEpochMs: T0 + i * 250, mediaTimeS: i * 0.25, presentedMediaTimeS: i * 0.25,
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
    expect(r.playback.audioGaps).toEqual({ count: 1, totalMs: 2500, longestMs: 2500, p99Ms: 2500 });
    expect(r.playback.fps.mean).toBeGreaterThan(29);
  });

  it('reports an interval still open at the end', () => {
    const s = samples(10, (i) => (i >= 6 ? { audioRms: 0 } : {}));
    expect(quietIntervals(s, (x) => x.audioRms > 0.015, 500)).toEqual([{ startMs: 1500, durationMs: 750, open: true }]);
  });

  it('does not count a hidden page\'s once-a-second drawing as stalls', () => {
    const steps = (i: number) => ({ mediaTimeS: Math.floor(i / 4), presentedMediaTimeS: Math.floor(i / 4) });
    const hidden = samples(40, (i) => ({ ...steps(i), visibility: 'hidden' }));
    expect(assessSoak({ samples: hidden, ticks: [] }).playback.stalls.count).toBe(0);
    expect(assessSoak({ samples: samples(40, steps), ticks: [] }).playback.stalls.count).toBeGreaterThan(0);
  });

  it('is no-playback when the playhead never moves', () => {
    expect(assessSoak({ samples: samples(20, () => ({ mediaTimeS: 1, presentedFrames: 3 })), ticks: [] }).verdict)
      .toBe('no-playback');
  });

  it('is no-audio when the catalog lists audio that is never heard', () => {
    const silent = samples(20, () => ({ audioRms: 0 }));
    const catalog = (roles: string[]) => [{ wallEpochMs: 0, events: [{ timeMs: 0, type: 'catalog_received',
      data: { catalog: { tracks: roles.map((role) => ({ name: role, role })) } } }] }];
    expect(assessSoak({ samples: silent, ticks: catalog(['video', 'audio']) }).verdict).toBe('no-audio');
    expect(assessSoak({ samples: silent, ticks: catalog(['video']) }).verdict).toBe('played');
    const roleless = [{ wallEpochMs: 0, events: [{ timeMs: 0, type: 'catalog_received',
      data: { catalog: { tracks: [{ name: 'v', codec: 'avc1.64001f' }, { name: 'a', codec: 'opus' }] } } }] }];
    expect(assessSoak({ samples: silent, ticks: roleless }).verdict).toBe('no-audio');
    expect(assessSoak({ samples: samples(20, () => ({})), ticks: catalog(['video', 'audio']) }).audio)
      .toEqual({ advertised: true, audible: true });
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

describe('player soak recovery', () => {
  /** The picture holds sample `from`'s frame through `to` (exclusive), or to the end. */
  const frozenBetween = (from: number, to = Infinity) => (i: number) => (i > from && i < to
    ? { pictureDigest: String(from), presentedFrames: from * 7.5 } : {});
  /** One tick per second with video p50 latency `p50(second)`. */
  const ticks = (n: number, p50: (s: number) => number) => Array.from({ length: n }, (_, s) => ({
    wallEpochMs: T0 + s * 1000, latency: { 'video/property': { n: 30, min: 50, p50: p50(s), p95: p50(s), max: p50(s) } },
  }));

  it('measures a blackout: first fresh frame, picture outage, and when latency settles', () => {
    const s = samples(120, frozenBetween(40, 60));
    const t = ticks(30, (sec) => (sec >= 10 && sec < 18 ? 400 : 100));
    const blackout = { kind: 'blackout', startEpochMs: T0 + 10_000, endEpochMs: T0 + 13_000 };
    const r = assessSoak({ samples: s, ticks: t, disruptions: [blackout], adverse: true });
    expect(r.verdict).toBe('played');
    expect(r.recovery.events).toEqual([expect.objectContaining({
      kind: 'blackout', durationMs: 3000, freshFrameAfterMs: 2000, outageMs: 5000,
      stableLatencyAfterMs: 5000, baselineLatencyMs: 100 })]);
    expect(r.recovery).toMatchObject({ unrecovered: 0, unsettled: 0, freshFrameAfterMsMax: 2000 });
  });

  it('fails an adverse case whose picture never resumes; a clean run only reports it', () => {
    const s = samples(200, frozenBetween(40));
    const blackout = { kind: 'blackout', startEpochMs: T0 + 10_000, endEpochMs: T0 + 13_000 };
    const adverse = assessSoak({ samples: s, ticks: [], disruptions: [blackout], adverse: true });
    expect(adverse.verdict).toBe('unrecovered');
    expect(adverse.recovery.events[0]!.freshFrameAfterMs).toBeNull();
    const clean = assessSoak({ samples: s, ticks: [] });
    expect(clean.verdict).toBe('played');
    expect(clean.recovery.unrecovered).toBe(1);
  });

  it('fails an adverse case that resumes after a disruption but ends frozen', () => {
    const s = samples(200, frozenBetween(100));
    const blackout = { kind: 'blackout', startEpochMs: T0 + 10_000, endEpochMs: T0 + 13_000 };
    const r = assessSoak({ samples: s, ticks: [], disruptions: [blackout], adverse: true });
    expect(r.recovery.events[0]!.freshFrameAfterMs).toBe(0);
    expect(r.recovery).toMatchObject({ unrecovered: 0, endedFrozenMs: 24_500 });
    expect(r.verdict).toBe('unrecovered');
  });

  it('leaves out a freeze still open in the run\'s last seconds', () => {
    const s = samples(80, frozenBetween(70));
    expect(assessSoak({ samples: s, ticks: [], adverse: true })).toMatchObject({ verdict: 'played', recovery: { events: [] } });
  });

  it('counts each freeze as a disruption when none was scheduled', () => {
    const s = samples(80, frozenBetween(40, 48));
    const frozen = quietIntervals(s, (() => {
      let prev: PlaybackSample | undefined;
      return (x: PlaybackSample) => { const c = !prev || x.pictureDigest !== prev.pictureDigest; prev = x; return c; };
    })(), 1500);
    expect(recoveryReport(s, [], [], frozen)).toEqual([expect.objectContaining({
      kind: 'freeze', freshFrameAfterMs: 1750, stableLatencyAfterMs: null })]);
  });
});

describe('player soak hidden-tab pause', () => {
  it('gives each return from a hidden tab: paused or not, first fresh frame, and what followed', () => {
    // Picture and playhead held for 3 s soon after the first return.
    const s = samples(200, (i) => (i > 64 && i < 77 ? { pictureDigest: '64', presentedFrames: 480, mediaTimeS: 16 } : {}));
    const hides = [{ kind: 'hidden', method: 'emulated', startEpochMs: T0 + 5000, endEpochMs: T0 + 15_000 },
      { kind: 'hidden', method: 'emulated', startEpochMs: T0 + 30_000, endEpochMs: T0 + 40_000 }];
    const t = [
      { wallEpochMs: T0 + 12_000, events: [{ timeMs: 0, type: 'lifecycle', data: { state: 'hidden', paused: 'silent' } }] },
      { wallEpochMs: T0 + 17_000, events: [{ timeMs: 0, type: 'stall', data: {} }, { timeMs: 0, type: 'stall', data: {} }] },
      { wallEpochMs: T0 + 33_000, events: [{ timeMs: 0, type: 'stall', data: {} }] },
    ];
    const r = assessSoak({ samples: s, ticks: t, disruptions: hides, adverse: true, hiddenPause: true });
    expect(r.verdict).toBe('played');
    expect(r.hiddenPause).toEqual([
      { startEpochMs: T0 + 5000, hiddenMs: 10_000, paused: 'silent', freshFrameAfterMs: 0,
        stalls: { count: 1, totalMs: 3000, longestMs: 3000 }, frozen: { count: 1, totalMs: 3000, longestMs: 3000 },
        playerStalls: 2 },
      { startEpochMs: T0 + 30_000, hiddenMs: 10_000, paused: null, freshFrameAfterMs: 0,
        stalls: { count: 0, totalMs: 0, longestMs: 0 }, frozen: { count: 0, totalMs: 0, longestMs: 0 },
        playerStalls: 0 },
    ]);
    expect(assessSoak({ samples: s, ticks: t, disruptions: hides, adverse: true })).not.toHaveProperty('hiddenPause');
  });
});

describe('player soak ABR ladder', () => {
  /** One tick a second playing the rung at `kbps(second)`. */
  const ticks = (n: number, kbps: (s: number) => number) => Array.from({ length: n }, (_, s) => ({
    wallEpochMs: T0 + s * 1000,
    stats: { bitrate: kbps(s) * 1000, resolution: { width: 0, height: { 4500: 1080, 2500: 720, 1500: 540 }[kbps(s)] ?? 0 } },
  }));
  const line = (atS: number, text: string) => ({ t: T0 + atS * 1000, text: `[moqt] ${text}` });

  it('reads switch lines as Playwright reports them and as substituted text', () => {
    const fmt = 'Buffer %.1fs, BW %.0fkbps (arrival %.0fkbps) → %s to %s%s';
    expect(abrSwitch(`[moqt] ${fmt} 0 2400.5 2300 downshift video_1  (video 480 ms late and rising)`))
      .toEqual({ direction: 'down', to: 'video_1', kind: 'lag', reason: 'video 480 ms late and rising' });
    expect(abrSwitch(`[moqt] ${fmt} 0 2400 2300 downshift video_1  (video arriving 450 ms later)`)?.kind).toBe('lag');
    expect(abrSwitch(`[moqt] ${fmt} 0 2400 2300 downshift video_2 `))
      .toEqual({ direction: 'down', to: 'video_2', kind: 'buffer', reason: null });
    expect(abrSwitch(`[moqt] ${fmt} 2 60000 2300 upshift video  (no link rate: probing)`))
      .toMatchObject({ direction: 'up', to: 'video', kind: 'probe' });
    expect(abrSwitch('[moqt] Buffer 0.0s, BW 2400kbps (arrival 2300kbps) → downshift to video_1 (link 2500 kbps under 4500 kbps)'))
      .toMatchObject({ direction: 'down', to: 'video_1', kind: 'link' });
    expect(abrSwitch('[moqt] Over %d%% of %s frames dropped → downshift to %s; Auto stays below %s for %d min 5 video video_1 video 5'))
      .toMatchObject({ to: 'video_1', kind: 'decode' });
    expect(abrSwitch('[moqt] MSE stall %dms → emergency downshift to %s 600 video_2')).toMatchObject({ to: 'video_2', kind: 'stall' });
    expect(abrSwitch('[moqt] [SWITCH] start: "%s" → "%s" (newReqId=%s, oldReqId=%s) video video_1 5 3')).toBeNull();
  });

  it('gives the time at each level, the shifts, the first downshift and its reasons', () => {
    const t = ticks(60, (s) => (s < 10 ? 4500 : s < 40 ? 2500 : s < 50 ? 1500 : 2500));
    const log = [
      line(8, 'Buffer %.1fs, BW %.0fkbps (arrival %.0fkbps) → %s to %s%s 0 2400 2300 downshift video_1  (video 480 ms late and rising)'),
      line(38, 'Buffer %.1fs, BW %.0fkbps (arrival %.0fkbps) → %s to %s%s 0 2400 2300 downshift video_2  (link 2400 kbps under 2500 kbps)'),
      line(48, 'Buffer %.1fs, BW %.0fkbps (arrival %.0fkbps) → %s to %s%s 2 9000 1500 upshift video_1 '),
    ];
    const r = abrReport(t, log, T0 - 2000);
    expect(r.timeline).toEqual([{ atS: 2, kbps: 4500, height: 1080 }, { atS: 12, kbps: 2500, height: 720 },
      { atS: 42, kbps: 1500, height: 540 }, { atS: 52, kbps: 2500, height: 720 }]);
    expect(r.timeAtLevelS).toEqual([{ kbps: 4500, height: 1080, seconds: 10 }, { kbps: 2500, height: 720, seconds: 39 },
      { kbps: 1500, height: 540, seconds: 10 }]);
    expect(r).toMatchObject({ downshifts: 2, upshifts: 1, firstDownshiftS: 10 });
    expect(r.logged).toMatchObject({ downshifts: 2, upshifts: 1, reasons: { lag: 1, link: 1 } });
  });

  it('takes the first downshift from the stats when the log has none, and holds one rung when manual', () => {
    expect(abrReport(ticks(20, (s) => (s < 5 ? 4500 : 2500)), []).firstDownshiftS).toBe(5);
    const held = abrReport(ticks(20, () => 4500), []);
    expect(held).toMatchObject({ downshifts: 0, upshifts: 0, firstDownshiftS: null,
      timeAtLevelS: [{ kbps: 4500, height: 1080, seconds: 19 }] });
  });

  it('is in the summary only for a ladder case, timed from the play click', () => {
    const s = samples(40, () => ({}));
    const t = ticks(10, (sec) => (sec < 5 ? 4500 : 2500));
    expect(assessSoak({ samples: s, ticks: t }).abr).toBeUndefined();
    const r = assessSoak({ samples: s, ticks: t, abrLog: [], startup: { clickedEpochMs: T0 - 3000 } });
    expect(r.abr).toMatchObject({ downshifts: 1, firstDownshiftS: 8 });
  });

  it('gives the p99 audio gap', () => {
    const gaps = new Set([10, 11, 12, 30, 31, 32, 33, 34, 35, 36]);
    const r = assessSoak({ samples: samples(60, (i) => (gaps.has(i) ? { audioRms: 0 } : {})), ticks: [] });
    expect(r.playback.audioGaps).toMatchObject({ count: 2, totalMs: 2500, p99Ms: 1750 });
  });
});

describe('moq-test-tracks client', () => {
  it('retries a job over a cap and a 5xx while waiting, then waits for it to run', async () => {
    vi.useFakeTimers();
    const replies = [
      new Response('{"error":"cap"}', { status: 429 }),
      new Response('{"id":"j1","state":"starting","joined":false}', { status: 201 }),
      new Response('busy', { status: 503 }),
      new Response('{"id":"j1","state":"running"}', { status: 200 }),
      new Response(null, { status: 204 }),
    ];
    const fetchImpl = vi.fn(async () => replies.shift()!);
    const client = new MttClient({ key: 'k', base: 'https://mtt.example/', fetchImpl });
    const started = client.start({ namespace: 'ns', relay: 'moqx-main', draft: 18 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await started).id).toBe('j1');
    const running = client.waitRunning('j1');
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(running).resolves.toMatchObject({ state: 'running' });
    await client.stop('j1');
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method} ${url}`)).toEqual([
      'POST https://mtt.example/api/v1/jobs', 'POST https://mtt.example/api/v1/jobs',
      'GET https://mtt.example/api/v1/jobs/j1', 'GET https://mtt.example/api/v1/jobs/j1',
      'DELETE https://mtt.example/api/v1/jobs/j1',
    ]);
    expect((calls[0]![1].headers as Record<string, string>).authorization).toBe('Bearer k');
    vi.useRealTimers();
  });
});
