/**
 * Playback pipeline sync behaviour: audio lateness re-anchoring, the video
 * fallback reference when advertised audio never delivers, and the release
 * budget on a throttled tick.
 */
import { describe, it, expect } from 'vitest';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import type { ClockSource, DecoderCommand, PlaybackEvent, PlaybackConfig } from './types.js';
import type { MoqtObjectData } from '@openmoq/transport';
import { varint } from '@openmoq/transport';
import type { LocHeaders } from '@openmoq/loc';

// Helpers as in pipeline.test.ts.

class MockClock implements ClockSource {
    private _now = 0;
    now(): number { return this._now; }
    advance(us: number): void { this._now += us; }
    set(us: number): void { this._now = us; }
}

function makeData(
    groupId: number,
    objectId: number,
    payload = new Uint8Array([0xCA, 0xFE]),
    subgroupId = 0,
    priority: number | undefined = 128,
): MoqtObjectData {
    return {
        kind: 'data',
        trackAlias: varint(1),
        groupId: varint(groupId),
        subgroupId: varint(subgroupId),
        objectId: varint(objectId),
        publisherPriority: priority,
        extensions: undefined,
        payload,
    };
}

function videoHeaders(
    captureTimestampUs: bigint,
    independent: boolean,
    videoConfig?: Uint8Array,
): LocHeaders {
    const h: LocHeaders = {
        captureTimestamp: captureTimestampUs,
        videoFrameMarking: {
            startOfFrame: true,
            endOfFrame: true,
            independent,
            discardable: false,
            baseLayerSync: false,
            temporalId: 0,
        },
    };
    if (videoConfig) {
        return { ...h, videoConfig };
    }
    return h;
}

function audioHeaders(captureTimestampUs: bigint): LocHeaders {
    return { captureTimestamp: captureTimestampUs };
}

const DEFAULT_CONFIG: PlaybackConfig = {
    gapTimeoutUs: 200_000,
    driftThresholdUs: 500_000,
    maxBufferDepth: 100,
};

function createPipeline(opts: {
    mediaType: 'video' | 'audio';
    clock: MockClock;
    config?: PlaybackConfig;
    sync?: SyncController;
    recovery?: import('./recovery.js').RecoveryController;
    getPlaybackDelayUs?: () => number;
}) {
    const commands: DecoderCommand[] = [];
    const events: PlaybackEvent[] = [];
    const config = opts.config ?? DEFAULT_CONFIG;
    const sync = opts.sync ?? new SyncController({
        driftThresholdUs: config.driftThresholdUs,
        clock: opts.clock,
    });

    const pipeline = new PlaybackPipeline({
        mediaType: opts.mediaType,
        config,
        clock: opts.clock,
        sync,
        onCommand: (cmd) => commands.push(cmd),
        onEvent: (evt) => events.push(evt),
        recovery: opts.recovery,
        ...(opts.getPlaybackDelayUs ? { getPlaybackDelayUs: opts.getPlaybackDelayUs } : {}),
    });

    return { pipeline, commands, events, sync };
}

describe('PlaybackPipeline — audio lateness re-anchor', () => {
    // The reference is set from the first audio frame's transit. Audio
    // that then stays >100 ms later than that (a publisher clock step, a
    // transit increase) used to be dropped for the rest of the session
    // while video kept rendering.
    const FRAME_US = 21_333;
    const C0 = 1_000_000_000n;

    function setup(cushionUs?: number) {
        const clock = new MockClock();
        clock.set(5_000_000);
        // Production passes lateFrameThresholdMs (100 ms); the standalone default is 500.
        const sync = new SyncController({
            driftThresholdUs: DEFAULT_CONFIG.driftThresholdUs, dropThresholdUs: 100_000, clock,
        });
        const ctx = createPipeline({
            mediaType: 'audio', clock, sync,
            ...(cushionUs !== undefined ? { getPlaybackDelayUs: () => cushionUs } : {}),
        });
        ctx.pipeline.configure(new Uint8Array([0x01]));
        ctx.pipeline.pushObject(makeData(0, 0), audioHeaders(C0));
        ctx.pipeline.tick();
        let group = 1;
        // Frame `group` arrives `lateUs` after its reference-mapped time.
        const push = (lateUs: number) => {
            clock.set(5_000_000 + group * FRAME_US + lateUs);
            ctx.pipeline.pushObject(makeData(group, 0), audioHeaders(C0 + BigInt(group * FRAME_US)));
            ctx.pipeline.tick();
            group++;
        };
        const decodes = () => ctx.commands.filter(c => c.type === 'decode_audio').length;
        const reanchors = () => ctx.events.filter(e => e.type === 'audio_reanchored');
        return { ...ctx, clock, push, decodes, reanchors };
    }

    it('drops a short late run, then re-anchors and resumes decoding', () => {
        const s = setup();
        expect(s.sync.hasReference).toBe(true);
        const before = s.decodes();

        for (let i = 0; i < 10; i++) s.push(150_000);     // ~200 ms of lateness
        expect(s.decodes()).toBe(before);
        expect(s.reanchors()).toHaveLength(0);

        for (let i = 0; i < 20; i++) s.push(150_000);
        expect(s.reanchors()).toHaveLength(1);
        expect((s.reanchors()[0] as { lateByUs: number }).lateByUs).toBeGreaterThanOrEqual(150_000);
        // Frames 1..12 dropped, frame 13 re-anchors, 14..30 are on time again.
        expect(s.decodes()).toBe(before + 18);
    });

    it('an on-time frame ends the late run (one jittery frame never re-anchors)', () => {
        const s = setup();
        for (let i = 0; i < 40; i++) s.push(i % 2 === 0 ? 150_000 : 0);
        expect(s.reanchors()).toHaveLength(0);
    });

    it('audio the playout cushion still covers is decoded, not dropped', () => {
        // 120 ms late against the uncushioned timeline is on time with a
        // 150 ms cushion; only lateness past cushion + threshold drops.
        const s = setup(150_000);
        const before = s.decodes();
        for (let i = 0; i < 20; i++) s.push(120_000);
        expect(s.decodes()).toBe(before + 20);
        expect(s.pipeline.lateAudioDrops).toBe(0);

        for (let i = 0; i < 5; i++) s.push(300_000);     // 150 ms past the cushion
        expect(s.decodes()).toBe(before + 20);
        expect(s.pipeline.lateAudioDrops).toBe(5);
    });

    it('re-anchors at most once per 2 s', () => {
        const s = setup();
        for (let i = 0; i < 13; i++) s.push(150_000);     // first re-anchor
        expect(s.reanchors()).toHaveLength(1);

        // Another 150 ms step right away: a sustained run, but inside 2 s.
        for (let i = 0; i < 40; i++) s.push(300_000);     // ~850 ms
        expect(s.reanchors()).toHaveLength(1);

        for (let i = 0; i < 80; i++) s.push(300_000);     // past 2 s since the first
        expect(s.reanchors()).toHaveLength(2);
    });

    it('a re-anchor step is bounded, so the reference cannot jump far', () => {
        const s = setup();
        for (let i = 0; i < 13; i++) s.push(3_000_000);   // 3 s late
        expect(s.reanchors()).toHaveLength(1);
        expect(s.sync.baselineDebtUs).toBe(100_000);      // not 3 s
    });

    it('the shift is retired by the frames that follow it', () => {
        const s = setup();
        for (let i = 0; i < 13; i++) s.push(150_000);
        expect(s.sync.baselineDebtUs).toBeGreaterThan(0);

        // On-time frames walk the shifted anchor back, down to the tolerance.
        for (let i = 0; i < 40; i++) s.push(0);
        expect(s.sync.baselineDebtUs).toBe(20_000);
    });

    it('startup slack is retired by frames that beat the anchor', () => {
        // Frames arriving 80 ms early walk the anchor toward them.
        const s = setup();
        const before = s.sync.computeVideoRenderTime(C0 + 1_000_000n)!.renderTimeUs;
        for (let i = 0; i < 40; i++) s.push(-80_000);   // 80 ms EARLY
        const after = s.sync.computeVideoRenderTime(C0 + 1_000_000n)!.renderTimeUs;
        expect(before - after).toBeGreaterThan(50_000);
        expect(s.reanchors()).toHaveLength(0);
    });

    it('a late run never walks the anchor in — grows on impairment only', () => {
        const s = setup();
        for (let i = 0; i < 13; i++) s.push(150_000);
        for (let i = 0; i < 200; i++) s.push(0);          // retires the shift
        expect(s.sync.baselineDebtUs).toBe(20_000);       // the tolerance

        const anchored = s.sync.computeVideoRenderTime(C0 + 1_000_000n)!.renderTimeUs;
        // Late, and short of the sustained window that would re-anchor.
        for (let i = 0; i < 7; i++) s.push(300_000);
        expect(s.sync.computeVideoRenderTime(C0 + 1_000_000n)!.renderTimeUs)
            .toBe(anchored);
    });
});

describe('sync reference fallback (advertised audio that never delivers)', () => {
    it('video anchors the reference itself once the bound elapses, and says so', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        // videoOnly is NOT set: the catalog advertised an audio track, so only
        // the audio pipeline may normally anchor the shared reference.
        const { pipeline, events, sync } = createPipeline({ mediaType: 'video', clock });

        pipeline.pushObject(
            makeData(0, 0),
            videoHeaders(1_000_000_000n, true, new Uint8Array([0x01, 0x64])),
        );
        pipeline.tick();
        // No audio has arrived, so nothing may anchor yet.
        expect(sync.hasReference).toBe(false);

        // Still inside the bound.
        clock.set(5_000_000 + 1_900_000);
        pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_333n, false));
        pipeline.tick();
        expect(sync.hasReference).toBe(false);
        expect(events.some((e) => e.type === 'sync_reference_fallback')).toBe(false);

        // Past it: video anchors, and the reason is reported exactly once.
        clock.set(5_000_000 + 2_100_000);
        pipeline.pushObject(makeData(0, 2), videoHeaders(1_000_066_666n, false));
        pipeline.tick();
        expect(sync.hasReference).toBe(true);
        expect(events.filter((e) => e.type === 'sync_reference_fallback')).toHaveLength(1);

        clock.set(5_000_000 + 3_000_000);
        pipeline.pushObject(makeData(0, 3), videoHeaders(1_000_099_999n, false));
        pipeline.tick();
        expect(events.filter((e) => e.type === 'sync_reference_fallback')).toHaveLength(1);
    });

    it('audio arriving inside the bound keeps priority — no fallback fires', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, events, sync } = createPipeline({ mediaType: 'video', clock });

        pipeline.pushObject(makeData(0, 0), videoHeaders(1_000_000_000n, true));
        pipeline.tick();

        sync.setAudioReference(1_000_000_000n);   // audio lands first

        clock.set(5_000_000 + 5_000_000);
        pipeline.pushObject(makeData(0, 1), videoHeaders(1_000_033_333n, false));
        pipeline.tick();

        expect(events.some((e) => e.type === 'sync_reference_fallback')).toBe(false);
    });
});

describe('release budget on a throttled tick', () => {
    // A hidden tab clamps timers to ~1Hz. A per-tick cap then drains far
    // slower than media arrives, and the backlog grows without bound.
    it('a late tick releases the work of the ticks it replaced', () => {
        const clock = new MockClock();
        clock.set(5_000_000);
        const { pipeline, commands, sync } = createPipeline({ mediaType: 'video', clock });
        sync.setAudioReference(1_000_000_000n);

        for (let i = 0; i < 40; i++) {
            pipeline.pushObject(
                makeData(0, i),
                videoHeaders(1_000_000_000n + BigInt(i * 41_000), i === 0,
                    i === 0 ? new Uint8Array([0x01, 0x64]) : undefined),
            );
        }

        // A normal 16ms tick stays near the cap.
        clock.set(5_016_000);
        pipeline.tick();
        const afterNormal = commands.filter((c) => c.type === 'decode_video').length;
        expect(afterNormal).toBeLessThanOrEqual(6);

        // A 1s tick drains the backlog the missed ticks would have handled.
        clock.set(6_016_000);
        pipeline.tick();
        const afterLate = commands.filter((c) => c.type === 'decode_video').length;
        expect(afterLate).toBeGreaterThan(afterNormal + 20);
    });
});
