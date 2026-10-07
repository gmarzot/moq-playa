/**
 * MseMediaSource live-edge behaviour: the soft chase and its floor, the
 * stale-group floor, and the stall nudge / post-stall snap.
 */
import { describe, it, expect, vi } from 'vitest';
import { MseMediaSource } from './mse-adapter.js';
import { MockVideoElement, flush, installMseStubs, makeInit, makeSegment, makeTimeRanges } from './testkit/mse.js';

const stubs = installMseStubs();

describe('MseMediaSource — soft chase', () => {
    it('soft chase engages two-thirds of the target above it and releases at the target', () => {
        const video = new MockVideoElement();
        (video as unknown as { playbackRate: number }).playbackRate = 1;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { targetAheadSec: 0.2 });
        (adapter as any).playTriggered = true;
        const rateAt = (aheadSec: number): number => {
            video.buffered = makeTimeRanges([[0, 10 + aheadSec]]);
            video.currentTime = 10;
            (adapter as any).maybeChaseLiveEdge();
            return (video as unknown as { playbackRate: number }).playbackRate;
        };
        expect(rateAt(0.30)).toBe(1);     // inside the band
        expect(rateAt(0.35)).toBe(1.05);  // past 0.2 + 0.132
        expect(rateAt(0.25)).toBe(1.05);  // still above target: keeps chasing
        expect(rateAt(0.20)).toBe(1);     // back at target: released
    });

    it('soft chase ends at the target measured before new media lands', () => {
        const video = new MockVideoElement();
        (video as unknown as { playbackRate: number }).playbackRate = 1;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { targetAheadSec: 0.2 });
        (adapter as any).playTriggered = true;
        const rate = () => (video as unknown as { playbackRate: number }).playbackRate;
        video.currentTime = 10;
        video.buffered = makeTimeRanges([[0, 10.35]]);
        (adapter as any).maybeChaseLiveEdge();
        expect(rate()).toBe(1.05);

        video.buffered = makeTimeRanges([[0, 10.21]]);    // low point, before an append
        (adapter as any).chase.onLowPoint((adapter as any).cushionAheadSec());
        expect(rate()).toBe(1.05);
        video.buffered = makeTimeRanges([[0, 10.2]]);
        (adapter as any).chase.onLowPoint((adapter as any).cushionAheadSec());
        expect(rate()).toBe(1);

        video.buffered = makeTimeRanges([[0, 10.25]]);    // the append's peak does not re-engage
        (adapter as any).maybeChaseLiveEdge();
        expect(rate()).toBe(1);
    });

    it('a stall during a chase raises the cushion the chase stops at', () => {
        const video = new MockVideoElement();
        (video as unknown as { playbackRate: number }).playbackRate = 1;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { targetAheadSec: 0.1 });
        (adapter as any).playTriggered = true;
        (adapter as any).chase.noteSampleDuration(0.04);
        const floors: number[] = [];
        adapter.onChaseFloor = (floorSec) => floors.push(floorSec);
        const rate = () => (video as unknown as { playbackRate: number }).playbackRate;
        const chaseAt = (aheadSec: number) => {
            video.buffered = makeTimeRanges([[0, 10 + aheadSec]]);
            (adapter as any).maybeChaseLiveEdge();
            return rate();
        };
        video.currentTime = 10;
        expect(chaseAt(0.4)).toBe(1.05);

        video.buffered = makeTimeRanges([[0, 10.13]]);
        (adapter as any).handleWaiting();                  // stalled with 130 ms still buffered
        expect(floors).toHaveLength(1);
        expect(floors[0]).toBeCloseTo(0.17, 5);
        expect(rate()).toBe(1);
        (adapter as any).cancelStallEpisode();

        expect(chaseAt(0.4)).toBe(1.05);                   // past 0.17 + 0.066
        expect(chaseAt(0.18)).toBe(1.05);
        expect(chaseAt(0.17)).toBe(1);                     // released at the floor, not the target
    });

    it('a stall outside a chase leaves the chase floor alone', () => {
        const video = new MockVideoElement();
        (video as unknown as { playbackRate: number }).playbackRate = 1;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, { targetAheadSec: 0.1 });
        (adapter as any).playTriggered = true;
        const floors: number[] = [];
        adapter.onChaseFloor = (floorSec) => floors.push(floorSec);
        video.currentTime = 10;
        video.buffered = makeTimeRanges([[0, 10.13]]);
        (adapter as any).handleWaiting();
        expect(floors).toEqual([]);
    });
});

describe('stale-group floor', () => {
    it('video drops two groups behind the floor, appends one behind; audio is exempt', async () => {
        const video = new MockVideoElement();
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        const initData = makeInit(1, 100);
        adapter.initialize({
            video: { codec: 'avc1.42c01e', initData },
            audio: { codec: 'mp4a.40.2', initData },
        });
        stubs.ms().open();
        await flush();
        await flush();
        const vsb = stubs.ms().videoBuffer;
        const asb = stubs.ms().audioBuffer;
        const seg = (bmd: number) => makeSegment({ bmd, defaultDur: 100, sampleCount: 1 });

        adapter.appendChunk('video', seg(1000), 'v', 10n);                 // floor → 10
        await flush(); await flush();
        const vBase = vsb.appendedPayloads.length;
        adapter.appendChunk('video', seg(800), 'v', 8n);                   // two behind: dropped
        await flush(); await flush();
        expect(vsb.appendedPayloads.length).toBe(vBase);
        adapter.appendChunk('video', seg(900), 'v', 9n);                   // previous group: late tail, appends
        await flush(); await flush();
        expect(vsb.appendedPayloads.length).toBe(vBase + 1);

        adapter.appendChunk('audio', seg(1000), 'a', 100n);                // audio floor → 100
        await flush(); await flush();
        const aBase = asb.appendedPayloads.length;
        adapter.appendChunk('audio', seg(840), 'a', 92n);                  // 8 groups (~170ms) late: appends
        await flush(); await flush();
        expect(asb.appendedPayloads.length).toBe(aBase + 1);
        adapter.destroy();
    });

    it('clearTimeline drops the floor so a renumbered epoch is not stale', async () => {
        const video = new MockVideoElement();
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement);
        adapter.initialize({ video: { codec: 'avc1.42c01e', initData: makeInit(1, 100) } });
        stubs.ms().open();
        await flush();
        await flush();
        const vsb = stubs.ms().videoBuffer;
        const seg = (bmd: number) => makeSegment({ bmd, defaultDur: 100, sampleCount: 1 });

        adapter.appendChunk('video', seg(5000), 'v', 50n);                 // floor → 50
        await flush(); await flush();
        expect(adapter.getCommittedGroupFloor('video', 'v')).toBe(50n);

        // Source restart renumbers groups downward; without the floor clear
        // every chunk of the new epoch reads as stale and is dropped forever.
        adapter.clearTimeline('video', 'v');
        expect(adapter.getCommittedGroupFloor('video', 'v')).toBeUndefined();

        const base = vsb.appendedPayloads.length;
        adapter.appendChunk('video', seg(100), 'v', 1n);
        await flush(); await flush();
        expect(vsb.appendedPayloads.length).toBe(base + 1);
        adapter.destroy();
    });
});

describe('stall nudge and post-stall live-edge snap', () => {
    function stallSetup(opts: { maxAheadSec?: number } = {}) {
        const video = new MockVideoElement();
        video.buffered = makeTimeRanges([[5, 25]]);
        video.currentTime = 10;
        video.readyState = 2;
        const adapter = new MseMediaSource(video as unknown as HTMLVideoElement, {
            targetAheadSec: 0.2,
            ...(opts.maxAheadSec !== undefined ? { maxAheadSec: opts.maxAheadSec } : {}),
        });
        (adapter as any).playTriggered = true;
        const adjusts: Array<[string, number, number]> = [];
        adapter.onPlayheadAdjust = (kind, from, to) => adjusts.push([kind, from, to]);
        return { adapter, video, adjusts };
    }

    it('nudges a playhead frozen with media ahead once, after 500 ms', () => {
        vi.useFakeTimers();
        try {
            const { adapter, video, adjusts } = stallSetup();
            (adapter as any).handleWaiting();
            vi.advanceTimersByTime(400);
            expect(video.currentTime).toBe(10);
            vi.advanceTimersByTime(200);
            expect(video.currentTime).toBeCloseTo(10.1, 5);
            expect(adjusts).toEqual([['nudge', 10, expect.closeTo(10.1, 5)]]);
            // The nudge's own seek-generated waiting does not nudge again.
            (adapter as any).handleWaiting();
            vi.advanceTimersByTime(1_000);
            expect(adjusts).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not nudge without media ahead, while paused, or after the stall ended', () => {
        vi.useFakeTimers();
        try {
            const thin = stallSetup();
            thin.video.currentTime = 24.7;              // 0.3 s ahead
            (thin.adapter as any).handleWaiting();
            vi.advanceTimersByTime(600);
            expect(thin.adjusts).toEqual([]);

            const paused = stallSetup();
            (paused.adapter as any).handleWaiting();
            paused.video.paused = true;
            vi.advanceTimersByTime(600);
            expect(paused.adjusts).toEqual([]);

            const ended = stallSetup();
            (ended.adapter as any).handleWaiting();
            (ended.adapter as any).handlePlaying();    // resumed before the nudge
            vi.advanceTimersByTime(600);
            expect(ended.adjusts).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('after a detected stall, snaps a live cushion more than 1 s over target to the live edge', () => {
        vi.useFakeTimers();
        try {
            const { adapter, video, adjusts } = stallSetup();
            video.currentTime = 20;                     // 5 s ahead, target 0.2 s
            (adapter as any).handleWaiting();
            vi.advanceTimersByTime(300);                // detected (default threshold)
            video.currentTime = 20;                     // undo the nudge for a clean read
            adjusts.length = 0;
            (adapter as any).handlePlaying();
            expect(video.currentTime).toBeCloseTo(24.8, 5);
            expect(adjusts).toEqual([['snap', 20, expect.closeTo(24.8, 5)]]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not snap after an undetected wait, near target, or on a non-live stream', () => {
        vi.useFakeTimers();
        try {
            const brief = stallSetup();
            brief.video.currentTime = 20;
            (brief.adapter as any).handleWaiting();
            (brief.adapter as any).handlePlaying();    // below the detection threshold
            expect(brief.adjusts).toEqual([]);

            const near = stallSetup();
            near.video.currentTime = 24;                // 1 s ahead: 0.8 s over target
            (near.adapter as any).handleWaiting();
            vi.advanceTimersByTime(300);
            (near.adapter as any).handlePlaying();
            expect(near.adjusts.filter(([k]) => k === 'snap')).toEqual([]);

            const vod = stallSetup({ maxAheadSec: Infinity });
            vod.video.currentTime = 20;
            (vod.adapter as any).handleWaiting();
            vi.advanceTimersByTime(300);
            (vod.adapter as any).handlePlaying();
            expect(vod.adjusts.filter(([k]) => k === 'snap')).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('describes each SourceBuffer and the frame counters', () => {
        const { adapter } = stallSetup();
        (adapter as any).videoBuffer = { buffered: makeTimeRanges([[5, 25]]) };
        (adapter as any).audioBuffer = { buffered: makeTimeRanges([[5, 12], [12.04, 25]]) };
        expect(adapter.describeBuffers())
            .toBe('video=[5.00–25.00] audio=[5.00–12.00][12.04–25.00] frames=100 dropped=2');
    });
});
