/**
 * WebAudioOutput tests — scheduled-buffer playhead mapping.
 *
 * playheadCaptureUs() answers "which CaptureTimestamp is coming out of the
 * speakers right now," derived from the scheduled-buffer ring. This is the
 * observability foundation for LOC A/V skew measurement — it must be exact
 * across chained buffers, playbackRate changes, gaps, and flush.
 */

import { describe, expect, it, vi } from 'vitest';
import { WebAudioOutput } from './webaudio-output.js';

// ─── Mock AudioContext ───────────────────────────────────────────────

class MockAudioContext {
  currentTime = 0;
  // Real contexts start suspended and stop currentTime while they are; the
  // output now refuses to schedule into one, so the mock must say it is live.
  state: AudioContextState = 'running';
  private listeners: Array<() => void> = [];
  addEventListener(_type: string, fn: () => void): void { this.listeners.push(fn); }
  removeEventListener(_type: string, fn: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== fn);
  }
  /** Drive a suspend/resume transition the way the browser would. */
  setState(next: AudioContextState): void {
    this.state = next;
    for (const l of [...this.listeners]) l();
  }
  readonly destination = { kind: 'destination' };
  readonly started: Array<{ when: number; offset: number; duration: number; rate: number }> = [];
  readonly sources: any[] = [];

  createBuffer(channels: number, frames: number, sampleRate: number) {
    return {
      duration: frames / sampleRate,
      numberOfChannels: channels,
      getChannelData: () => new Float32Array(frames),
    };
  }

  createBufferSource() {
    const ctx = this;
    const source: any = {
      buffer: null,
      playbackRate: { value: 1 },
      onended: null,
      connect: vi.fn(),
      disconnect: vi.fn(),
      stop: vi.fn(),
      start(when: number, offset = 0) {
        ctx.started.push({ when, offset, duration: source.buffer.duration, rate: source.playbackRate.value });
      },
    };
    this.sources.push(source);
    return source;
  }
}

/** 20ms of mono 48kHz audio with the given capture timestamp (µs). */
function audioData(timestampUs: number, frames = 960) {
  return {
    timestamp: timestampUs,
    numberOfChannels: 1,
    numberOfFrames: frames,
    sampleRate: 48_000,
    copyTo: vi.fn(),
    close: vi.fn(),
  };
}

function makeOutput(playbackDelayMs = 0) {
  const ctx = new MockAudioContext();
  // Clock pinned to the ctx so toAudioCtxTime is deterministic.
  const clock = { now: () => ctx.currentTime * 1_000_000 };
  const out = new WebAudioOutput(ctx as unknown as AudioContext, undefined, playbackDelayMs, clock);
  return { ctx, out };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe('WebAudioOutput.playheadCaptureUs', () => {
  it('returns null when nothing has been scheduled', () => {
    const { out } = makeOutput();
    expect(out.playheadCaptureUs()).toBeNull();
  });

  it('returns null before the first buffer starts playing', () => {
    const { ctx, out } = makeOutput(200); // anchored 200ms in the future
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000);
    // now = 1.0, buffer starts at 1.2 — nothing is being heard yet
    expect(out.playheadCaptureUs()).toBeNull();
  });

  it('maps playout position inside a buffer to its capture timeline', () => {
    const { ctx, out } = makeOutput();
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000); // starts at 1.0, 20ms long

    ctx.currentTime = 1.010; // 10ms into the buffer
    expect(out.playheadCaptureUs()).toBe(5_010_000);
  });

  it('tracks across chained buffers (the normal playback path)', () => {
    const { ctx, out } = makeOutput();
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000); // [1.000, 1.020)
    out.schedule(audioData(5_020_000), 1_020_000); // chained: [1.020, 1.040)
    out.schedule(audioData(5_040_000), 1_040_000); // chained: [1.040, 1.060)

    ctx.currentTime = 1.030; // 10ms into the SECOND buffer
    expect(out.playheadCaptureUs()).toBe(5_030_000);
    ctx.currentTime = 1.055; // 15ms into the THIRD
    expect(out.playheadCaptureUs()).toBe(5_055_000);
  });

  it('accounts for playbackRate in both duration and capture progression', () => {
    const { ctx, out } = makeOutput();
    out.setPlaybackRate(2.0); // catch-up: 20ms of media plays in 10ms wall
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000); // wall [1.000, 1.010)

    ctx.currentTime = 1.005; // 5ms wall = 10ms of media at 2×
    expect(out.playheadCaptureUs()).toBe(5_010_000);
  });

  it('returns null once playout has run past the last scheduled buffer (starved)', () => {
    const { ctx, out } = makeOutput();
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000); // [1.000, 1.020)

    ctx.currentTime = 1.5;
    expect(out.playheadCaptureUs()).toBeNull();
  });

  it('prunes finished buffers without losing the playing one', () => {
    const { ctx, out } = makeOutput();
    ctx.currentTime = 1.0;
    for (let i = 0; i < 200; i++) {
      out.schedule(audioData(5_000_000 + i * 20_000), 1_000_000 + i * 20_000);
    }
    ctx.currentTime = 1.0 + 199 * 0.020 + 0.010; // inside the LAST buffer
    // toBeCloseTo: float accumulation across 199 chained start times is ~1e-8µs
    expect(out.playheadCaptureUs()).toBeCloseTo(5_000_000 + 199 * 20_000 + 10_000, 0);
  });

  it('prunes played-out buffers on schedule, with no playhead read (audio-only)', () => {
    const { ctx, out } = makeOutput();
    ctx.currentTime = 1.0;
    for (let i = 0; i < 500; i++) {
      out.schedule(audioData(5_000_000 + i * 20_000), 1_000_000 + i * 20_000);
      ctx.currentTime += 0.020;
    }
    // Only buffers not yet fully played remain.
    expect(out['scheduledRing'].length).toBeLessThanOrEqual(2);
  });

  it('uses the passed capture timestamp over the decoded one (decoder rebasing)', () => {
    const { ctx, out } = makeOutput();
    ctx.currentTime = 1.0;
    // Decoder rebased this buffer to 5.000 s; its real capture time is 9.000 s.
    out.schedule(audioData(5_000_000), 1_000_000, 9_000_000);
    ctx.currentTime = 1.010;
    expect(out.playheadCaptureUs()).toBe(9_010_000);
  });

  it('flush() clears the ring — playhead goes null', () => {
    const { ctx, out } = makeOutput();
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000);
    ctx.currentTime = 1.010;
    expect(out.playheadCaptureUs()).not.toBeNull();

    out.flush();
    expect(out.playheadCaptureUs()).toBeNull();
  });

  it('does not change scheduling behavior (observability only)', () => {
    const { ctx, out } = makeOutput(200);
    ctx.currentTime = 1.0;
    out.schedule(audioData(5_000_000), 1_000_000);
    out.schedule(audioData(5_020_000), 1_020_000);

    // Identical to pre-slice behavior: first anchored at renderTime+delay
    // (clock pinned to ctx → toAudioCtxTime(1s)=1.0, +0.2), second chained.
    expect(ctx.started).toEqual([
      { when: 1.2, offset: 0, duration: 0.02, rate: 1 },
      { when: 1.22, offset: 0, duration: 0.02, rate: 1 },
    ]);
  });
});

describe('unified playout cushion (delay unification)', () => {
  it('honors the first render time before the audio context clock has advanced', () => {
    const { ctx, out } = makeOutput();
    expect(ctx.currentTime).toBe(0);
    out.schedule(audioData(5_000_000), 250_000);
    expect(ctx.started[0]!.when).toBeCloseTo(0.25, 5);
    expect(out.playheadCaptureUs()).toBeNull();
    ctx.currentTime = 0.26;
    expect(out.playheadCaptureUs()).toBeCloseTo(5_010_000, 0);
  });

  it('honors a standalone delay at context time zero without a render timestamp', () => {
    const { ctx, out } = makeOutput(200);
    out.schedule(audioData(5_000_000), 0);
    expect(ctx.started[0]!.when).toBeCloseTo(0.2, 5);
  });

  it('chains after a real zero-time start but anchors again after flush', () => {
    const { ctx, out } = makeOutput();
    out.schedule(audioData(5_000_000), 0);
    out.schedule(audioData(5_020_000), 250_000);
    expect(ctx.started.map((entry) => entry.when)).toEqual([0, 0.02]);
    out.flush();
    out.schedule(audioData(6_000_000), 500_000);
    expect(ctx.started[2]!.when).toBeCloseTo(0.5, 5);
  });

  it('DEFAULT construction adds no delay of its own — the dispatcher owns the cushion', () => {
    // The documented @openmoq/player + @openmoq/browser composition wires this
    // output behind the CommandDispatcher, which already adds the shared
    // cushion to renderTimeUs. A non-zero default here would double-delay
    // audio ~200ms behind video after startup or an underrun.
    const ctx = new MockAudioContext();
    const clock = { now: () => ctx.currentTime * 1_000_000 };
    const out = new WebAudioOutput(ctx as unknown as AudioContext, undefined, undefined, clock);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_500_000);
    expect(ctx.started[0]!.when).toBeCloseTo(1.5, 5); // exactly the render time
  });

  // With playbackDelayMs = 0, the cushion arrives INSIDE renderTimeUs (the
  // dispatcher adds the shared pipeline cushion) — the output must anchor at
  // exactly toAudioCtxTime(renderTimeUs), adding no delay of its own.
  it('with zero playbackDelayMs the first anchor is exactly the render time', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_500_000); // render at ctx 1.5s
    expect(ctx.started[0]!.when).toBeCloseTo(1.5, 5);
  });

  it('PINNED SEMANTICS: a mid-chain cushion change does NOT retime healthy chained playback', () => {
    // Audio adopts the shared cushion at anchor/underrun boundaries ONLY.
    // While the chain is healthy (nextScheduledTime >= now) schedule()
    // intentionally ignores renderTimeUs — retiming a playing chain would
    // need an audible gap or rate control (slice-C territory). So a cushion
    // that grows mid-session reaches audio playout at the NEXT underrun,
    // not immediately. Video adopts per-frame; transient divergence between
    // a cushion change and the next audio anchor is expected and bounded.
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_200_000);      // anchor at 1.2 (cushion 200ms)
    // Cushion grew to 400ms upstream — next buffer arrives while the chain
    // is still healthy, carrying renderTime reflecting the LARGER cushion.
    out.schedule(audioData(20_000) as unknown as AudioData, 1_420_000);
    // Chained back-to-back at 1.22 — renderTime (1.42) intentionally ignored.
    expect(ctx.started[1]!.when).toBeCloseTo(1.22, 5);
  });

  it('realign(): the next buffer waits for a grown cushion\'s slot, once', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_200_000);      // anchor at 1.2
    out.realign();                                                      // cushion grew 200 ms
    out.schedule(audioData(20_000) as unknown as AudioData, 1_420_000); // chain at 1.22, slot 1.42
    expect(ctx.started[1]!.when).toBeCloseTo(1.42, 5);
    out.schedule(audioData(40_000) as unknown as AudioData, 1_640_000);
    expect(ctx.started[2]!.when).toBeCloseTo(1.44, 5);                  // back-to-back again
  });

  it('realign() leaves a chain within 20 ms of its slot, and flush() cancels a pending one', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_200_000);
    out.realign();
    out.schedule(audioData(20_000) as unknown as AudioData, 1_230_000); // 10 ms past the chain
    expect(ctx.started[1]!.when).toBeCloseTo(1.22, 5);
    out.realign();
    out.flush();
    ctx.currentTime = 2.0;
    out.schedule(audioData(40_000) as unknown as AudioData, 2_200_000); // anchor
    out.schedule(audioData(60_000) as unknown as AudioData, 2_520_000);
    expect(ctx.started[3]!.when).toBeCloseTo(2.22, 5);
  });

  it('the next underrun re-anchor ADOPTS the grown cushion (adoption boundary)', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_200_000);      // chain ends 1.22
    ctx.currentTime = 2.0;                                              // underrun
    out.schedule(audioData(20_000) as unknown as AudioData, 2_400_000); // new 400ms cushion inside renderTime
    expect(ctx.started[1]!.when).toBeCloseTo(2.4, 5);                   // adopted exactly
  });

  it('an underrun re-anchor also lands exactly on the (cushion-inclusive) render time', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_100_000); // 20ms buffer → chain ends 1.12
    ctx.currentTime = 2.0; // chain long dry — underrun
    out.schedule(audioData(20_000) as unknown as AudioData, 2_300_000);
    expect(ctx.started[1]!.when).toBeCloseTo(2.3, 5); // no hidden +200ms
  });
});

describe('live-edge lead clamp', () => {
  const MS = 1_000; // µs per ms
  /** Chain `n` contiguous 20ms buffers whose render times start at `renderStartUs`. */
  const feed = (out: WebAudioOutput, n: number, captureStartUs: number, renderStartUs: number) => {
    for (let i = 0; i < n; i++) {
      out.schedule(audioData(captureStartUs + i * 20 * MS) as unknown as AudioData, renderStartUs + i * 20 * MS);
    }
  };

  it('a healthy chain on schedule has zero lead: no chase, no snap', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    feed(out, 100, 0, 1_000 * MS);
    expect(out.captureLeadSec).toBeCloseTo(0, 6);
    expect(out.chasing).toBe(false);
    expect(out.liveEdgeSnapCount).toBe(0);
    expect(ctx.started.every((s) => s.rate === 1)).toBe(true);
  });

  it('a grown cushion (chain earlier than policy) is neither chased nor snapped', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_200 * MS);
    out.schedule(audioData(20 * MS) as unknown as AudioData, 1_420 * MS);
    expect(out.captureLeadSec).toBeLessThan(0);
    expect(out.chasing).toBe(false);
    expect(out.liveEdgeSnapCount).toBe(0);
    expect(ctx.started[1]!.rate).toBe(1);
  });

  it('a late anchor leaves a persistent lead that the soft chase drains at CHASE_RATE', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    // Render time 0.5 s is already in the past: anchor at now, lead 0.5 s.
    feed(out, 2, 0, 500 * MS);
    expect(out.captureLeadSec).toBeCloseTo(0.5, 6);
    expect(out.chasing).toBe(true);
    expect(ctx.started[1]!.rate).toBeCloseTo(1.02, 6);

    // Each chased buffer sheds 20ms − 20ms/1.02 ≈ 0.39ms; ~900 buffers reach target.
    feed(out, 1000, 40 * MS, 540 * MS);
    expect(out.chasing).toBe(false);
    expect(out.captureLeadSec).toBeLessThanOrEqual(0.15 + 1e-9);
    expect(ctx.started.at(-1)!.rate).toBe(1);
    expect(out.liveEdgeSnapCount).toBe(0);
  });

  it('chase does not stack on the catch-up rate (pitch shifts would compound)', () => {
    const { ctx, out } = makeOutput(0);
    out.setPlaybackRate(1.1);
    ctx.currentTime = 1.0;
    feed(out, 2, 0, 500 * MS);
    expect(out.chasing).toBe(true);
    expect(ctx.started[1]!.rate).toBeCloseTo(1.1, 6);   // not 1.1 × 1.02

    out.setPlaybackRate(1.0);
    feed(out, 1, 40 * MS, 540 * MS);
    expect(ctx.started.at(-1)!.rate).toBeCloseTo(1.02, 6);
  });

  it('a backlog beyond maxAheadSec is dropped past the landing and the chain re-anchored', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    feed(out, 60, 0, 1_000 * MS);                       // chain [1.0, 2.2)
    // This buffer belongs at 1.3 s: lead 0.9 s > 0.75 → land at 1.3 + 0.15.
    out.schedule(audioData(1_200 * MS) as unknown as AudioData, 1_300 * MS);

    expect(out.liveEdgeSnapCount).toBe(1);
    expect(ctx.started.at(-1)!.when).toBeCloseTo(1.45, 6);
    expect(out.scheduledAheadSec).toBeCloseTo(0.47, 6);  // 1.47 − 1.0
    // Buffers starting at/after 1.45 were stopped: i ≥ 23 of 60 (37 nodes);
    // the buffer spanning 1.45 was truncated with stop(1.45).
    const stops = ctx.sources.map((s) => s.stop.mock.calls);
    expect(stops.filter((c) => c.length === 1 && c[0]!.length === 0)).toHaveLength(37);
    expect(stops.filter((c) => c.length === 1 && c[0]![0] === 1.45)).toHaveLength(1);
    // Playhead follows the re-anchored chain.
    ctx.currentTime = 1.455;
    expect(out.playheadCaptureUs()).toBeCloseTo(1_200 * MS + 5 * MS, 0);
    expect(out.chasing).toBe(false);
  });

  it('pure arrival lateness with nothing queued past the landing drops nothing', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_000 * MS); // chain ends 1.02
    ctx.currentTime = 1.02;
    out.schedule(audioData(20 * MS) as unknown as AudioData, 100 * MS); // 0.92 s late
    expect(out.liveEdgeSnapCount).toBe(0);
    expect(ctx.started[1]!.when).toBeCloseTo(1.02, 6);
    expect(out.chasing).toBe(true);
  });

  it('audio BEHIND its sync reference is never dropped (the strobe bug)', () => {
    // Field symptom: under CPU load the A/V skew grew to ~2.3 s, so the
    // audio render times sat far in the past. `lead` then reads huge while
    // the landing is already behind `now` — the clamp fired on every
    // buffer, stopping the audible one mid-playback and flushing the
    // queue ~47x/s. Audible as strobing, louder, with underruns climbing.
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 10.0;
    feed(out, 40, 0, 10_000 * MS);                // chain [10.0, 10.8)
    const queued = ctx.sources.length;
    ctx.currentTime = 10.1;

    // Render time 2.3 s in the past (still positive, or the output reads
    // it as "no render time" and never reaches the clamp at all).
    out.schedule(audioData(0) as unknown as AudioData, 7_800 * MS);

    expect(out.liveEdgeSnapCount).toBe(0);         // nothing dropped
    expect(ctx.sources[queued]!.start).toBeTruthy();
    expect(ctx.started.at(-1)!.when).toBeCloseTo(10.8, 6); // chained, not cut
    expect(ctx.sources.slice(0, queued).every((s) => s.stop.mock.calls.length === 0))
      .toBe(true);
    expect(out.chasing).toBe(true);                // catch up by rate instead
  });

  it('options override the bounds', () => {
    const ctx = new MockAudioContext();
    const clock = { now: () => ctx.currentTime * 1_000_000 };
    const out = new WebAudioOutput(ctx as unknown as AudioContext, undefined, 0, clock,
      { maxAheadSec: 0.3, targetAheadSec: 0.05 });
    ctx.currentTime = 1.0;
    feed(out, 30, 0, 1_000 * MS);                        // chain [1.0, 1.6)
    out.schedule(audioData(600 * MS) as unknown as AudioData, 1_200 * MS); // lead 0.4 > 0.3
    expect(out.liveEdgeSnapCount).toBe(1);
    expect(ctx.started.at(-1)!.when).toBeCloseTo(1.25, 6);
  });
});

describe('lag after an underrun', () => {
  const MS = 1_000;
  const buffer = (ts: number): AudioData => ({
    timestamp: ts, duration: 20 * MS, numberOfFrames: 960, numberOfChannels: 1, sampleRate: 48_000,
    format: 'f32', copyTo: () => {}, close: () => {}, allocationSize: () => 3_840,
  }) as unknown as AudioData;

  it('is drained below the target, where a chase would not otherwise start', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(buffer(0), 1_000 * MS);
    ctx.currentTime = 2.0;                 // the chain ran dry
    out.schedule(buffer(0), 2_000 * MS);   // anchors on its slot
    out.schedule(buffer(20 * MS), (2_000 + 20 - 90) * MS);
    expect(out.captureLeadSec).toBeCloseTo(0.09, 3);
    expect(out.chasing).toBe(true);
    // 90 ms sheds at about 0.39 ms per 20 ms buffer.
    for (let i = 2; i < 400; i++) out.schedule(buffer(i * 20 * MS), (2_000 + i * 20 - 90) * MS);
    expect(out.chasing).toBe(false);
    expect(out.captureLeadSec).toBeLessThanOrEqual(0.02 + 1e-9);
  });

  it('is drained the same way when video re-anchors with no underrun', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(buffer(0), 1_000 * MS);
    out.drainLag();
    out.schedule(buffer(20 * MS), (1_000 + 20 - 90) * MS);
    expect(out.chasing).toBe(true);
  });

  it('catches a lag that grows after the anchor, as video\'s cushion decays, until the window ends', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.drainLag();
    out.schedule(buffer(0), 1_000 * MS);
    expect(out.chasing).toBe(false);
    out.schedule(buffer(20 * MS), (1_000 + 20 - 90) * MS);
    expect(out.chasing).toBe(true);

    const late = makeOutput(0);
    late.ctx.currentTime = 1.0;
    late.out.drainLag();
    late.ctx.currentTime = 31.5;
    late.out.schedule(buffer(0), 31_500 * MS);
    late.out.schedule(buffer(20 * MS), (31_500 + 20 - 90) * MS);
    expect(late.out.chasing).toBe(false);
  });

  it('stays out of a chase without an underrun', () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(buffer(0), 1_000 * MS);
    out.schedule(buffer(20 * MS), (1_000 - 70) * MS);
    expect(out.captureLeadSec).toBeGreaterThan(0.02);
    expect(out.chasing).toBe(false);
  });
});

describe('underrun resync', () => {
  const MS = 1_000; // µs per ms
  /** One on-time 20ms buffer at ctx 1.0: the chain ends at 1.02. */
  const startChain = () => {
    const { ctx, out } = makeOutput(0);
    ctx.currentTime = 1.0;
    out.schedule(audioData(0) as unknown as AudioData, 1_000 * MS);
    return { ctx, out };
  };

  it('a partly late buffer after an underrun starts part-way in, on its aligned slot', () => {
    const { ctx, out } = startChain();
    ctx.currentTime = 1.5;
    out.schedule(audioData(490 * MS) as unknown as AudioData, 1_490 * MS); // 10ms late
    expect(ctx.started[1]).toMatchObject({ when: 1.5 });
    expect(ctx.started[1]!.offset).toBeCloseTo(0.01, 9);
    expect(out.underrunCount).toBe(1);

    out.schedule(audioData(510 * MS) as unknown as AudioData, 1_510 * MS);
    expect(ctx.started[2]!.when).toBeCloseTo(1.51, 9);
    expect(out.captureLeadSec).toBeCloseTo(0, 9);
    ctx.currentTime = 1.505;
    expect(out.playheadCaptureUs()).toBeCloseTo(505 * MS, 0);
  });

  it('wholly late buffers in the burst are skipped and the underrun counted once', () => {
    const { ctx, out } = startChain();
    ctx.currentTime = 1.5;
    // 80, 60, 40 and 20ms late (each 20ms long), then one on time.
    for (const t of [420, 440, 460, 480, 500]) {
      out.schedule(audioData(t * MS) as unknown as AudioData, (1_000 + t) * MS);
    }
    expect(ctx.started).toHaveLength(2);
    expect(ctx.started[1]).toMatchObject({ when: 1.5, offset: 0 });
    expect(out.underrunCount).toBe(1);
    expect(out.underrunGapSec).toBeCloseTo(0.48, 9);
    ctx.currentTime = 1.51;
    expect(out.playheadCaptureUs()).toBeCloseTo(510 * MS, 0);
  });

  it('lateness that outlasts the burst plays late, as before', () => {
    const { ctx, out } = startChain();
    // Every buffer arrives 50ms late, at the pace it plays.
    for (let i = 0; i < 4; i++) {
      ctx.currentTime = 1.5 + i * 0.02;
      out.schedule(audioData((450 + i * 20) * MS) as unknown as AudioData, (1_450 + i * 20) * MS);
    }
    expect(ctx.started).toHaveLength(2);
    expect(ctx.started[1]!.when).toBeCloseTo(1.56, 9);
    expect(ctx.started[1]!.offset).toBe(0);
    expect(out.underrunCount).toBe(1);
    expect(out.underrunGapSec).toBeCloseTo(0.54, 9); // 1.02 → 1.56

    ctx.currentTime = 1.58;
    out.schedule(audioData(530 * MS) as unknown as AudioData, 1_530 * MS);
    expect(out.captureLeadSec).toBeCloseTo(0.05, 9);
  });

  it('reports one gap, through to the buffer that resumes playout', () => {
    const { ctx, out } = startChain();
    const gaps: Array<[number, number | null]> = [];
    out.onUnderrun = (gap, late) => gaps.push([gap, late]);
    ctx.currentTime = 1.5;
    out.schedule(audioData(450 * MS) as unknown as AudioData, 1_450 * MS); // 50ms late: skipped
    expect(gaps).toEqual([]);
    ctx.currentTime = 1.53;
    out.schedule(audioData(520 * MS) as unknown as AudioData, 1_520 * MS); // 10ms late: plays
    expect(out.underrunCount).toBe(1);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]![0]).toBeCloseTo(0.51, 9);  // 1.02 → 1.53
    expect(gaps[0]![1]).toBeCloseTo(0.05, 9);  // the first buffer after the chain ran dry
  });

  it('an on-time buffer after the burst window ends the same underrun', () => {
    const { ctx, out } = startChain();
    ctx.currentTime = 1.5;
    out.schedule(audioData(450 * MS) as unknown as AudioData, 1_450 * MS); // skipped
    ctx.currentTime = 1.56;
    out.schedule(audioData(600 * MS) as unknown as AudioData, 1_600 * MS);
    expect(ctx.started[1]).toMatchObject({ when: 1.6, offset: 0 });
    expect(out.underrunCount).toBe(1);
    expect(out.underrunGapSec).toBeCloseTo(0.58, 9); // 1.02 → 1.60
  });

  it('resyncs again only after audio has arrived on time', () => {
    const { ctx, out } = startChain();
    ctx.currentTime = 1.5;
    out.schedule(audioData(490 * MS) as unknown as AudioData, 1_490 * MS); // resync, ends 1.51
    ctx.currentTime = 1.53;
    out.schedule(audioData(500 * MS) as unknown as AudioData, 1_500 * MS); // still late: plays late
    expect(ctx.started[2]).toMatchObject({ when: 1.53, offset: 0 });

    out.schedule(audioData(540 * MS) as unknown as AudioData, 1_540 * MS); // on time: re-arms
    ctx.currentTime = 2.0;
    out.schedule(audioData(990 * MS) as unknown as AudioData, 1_990 * MS); // 10ms late
    expect(ctx.started[4]!.when).toBe(2.0);
    expect(ctx.started[4]!.offset).toBeCloseTo(0.01, 9);
  });
});

describe('suspended AudioContext', () => {
  it('schedules nothing and reports no queue while suspended', () => {
    const { out, ctx } = makeOutput();
    ctx.setState('suspended');
    for (let i = 0; i < 50; i++) out.schedule(audioData(i * 20_000), (i * 20_000) + 1, i * 20_000);
    expect(out.suspendedDropCount).toBe(50);
    // The bug this guards: nextScheduledTime advanced per buffer while
    // currentTime stayed frozen, so the queue reading grew without bound.
    expect(out.scheduledAheadSec).toBe(0);
    expect(out.playheadCaptureUs()).toBeNull();
  });

  it('re-anchors instead of unwinding a phantom backlog on resume', () => {
    const { out, ctx } = makeOutput();
    ctx.setState('suspended');
    for (let i = 0; i < 50; i++) out.schedule(audioData(i * 20_000), (i * 20_000) + 1, i * 20_000);
    ctx.setState('running');
    expect(out.scheduledAheadSec).toBe(0);
    expect(out.chasing).toBe(false);
    expect(out.captureLeadSec).toBeNull();
  });

  it('frees native memory for every dropped buffer', () => {
    const { out, ctx } = makeOutput();
    ctx.setState('suspended');
    const d = audioData(0);
    out.schedule(d, 1, 0);
    expect(d.close).toHaveBeenCalledOnce();
  });
});

describe('WebAudioOutput — live edge aimed at the catalog target', () => {
  it('setTargetAheadSec narrows the edge but never widens past the default', () => {
    const ctx = new MockAudioContext() as unknown as AudioContext;
    const out = new WebAudioOutput(ctx);

    // A 50ms end-to-end target: half of it is 25ms of allowed lead.
    out.setTargetAheadSec(0.025);
    expect((out as unknown as { targetAheadSec: number }).targetAheadSec).toBeCloseTo(0.025, 5);

    // Clamped to the construction default: this must not widen the edge.
    out.setTargetAheadSec(5);
    expect((out as unknown as { targetAheadSec: number }).targetAheadSec).toBeCloseTo(0.15, 5);
  });

  it('ignores a non-positive or non-finite target', () => {
    const ctx = new MockAudioContext() as unknown as AudioContext;
    const out = new WebAudioOutput(ctx);
    const before = (out as unknown as { targetAheadSec: number }).targetAheadSec;
    out.setTargetAheadSec(0);
    out.setTargetAheadSec(-1);
    out.setTargetAheadSec(Number.NaN);
    expect((out as unknown as { targetAheadSec: number }).targetAheadSec).toBe(before);
  });
});
