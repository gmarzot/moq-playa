/**
 * Late audio under delivery deficits, replayed on the audio pipeline.
 *
 * Following late audio (LIVE) steps the shared reference past a sustained late
 * run, at most 1 s per step, unless its lateness is shrinking. Without it
 * (LIVE(+1s), LIVE(+2s)) a run moves the reference at most 100 ms per 2 s;
 * those cases pin that rule's values. Armed LIVE(+1s) and LIVE(+2s) judge audio
 * against their 2 s and 3 s ceilings.
 */
import { describe, it, expect } from 'vitest';
import { PlaybackPipeline } from './pipeline.js';
import { SyncController } from './sync.js';
import type { ClockSource, DecoderCommand, PlaybackEvent } from './types.js';
import type { MoqtObjectData } from '@openmoq/transport';
import { varint } from '@openmoq/transport';

const FRAME_US = 20_000;
const C0 = 1_000_000_000n;
const START_US = 100_000;
const due = (i: number): number => START_US + i * FRAME_US;

const LIVE_CUSHION_US = 200_000;
const PLUS_1S_CEILING_US = 2_000_000;
const PLUS_2S_CEILING_US = 3_000_000;

const data = (group: number): MoqtObjectData => ({
    kind: 'data', trackAlias: varint(1), groupId: varint(group), subgroupId: varint(0), objectId: varint(0),
    publisherPriority: 128, extensions: undefined, payload: new Uint8Array([1, 2]),
});

function harness(cushionUs: number, follow?: () => boolean) {
    let nowUs = START_US;
    const clock: ClockSource = { now: () => nowUs };
    // Production passes lateFrameThresholdMs (100 ms).
    const sync = new SyncController({ driftThresholdUs: 500_000, dropThresholdUs: 100_000, clock });
    const commands: DecoderCommand[] = [];
    const events: PlaybackEvent[] = [];
    const pipeline = new PlaybackPipeline({
        mediaType: 'audio',
        config: { gapTimeoutUs: 200_000, driftThresholdUs: 500_000, maxBufferDepth: 4000 },
        clock, sync,
        onCommand: (c) => commands.push(c),
        onEvent: (e) => events.push(e),
        getPlaybackDelayUs: () => cushionUs,
        ...(follow ? { followLateAudio: follow } : {}),
    });
    pipeline.configure(new Uint8Array([1]));
    const steps = () => events.filter(e => e.type === 'audio_reanchored').length;
    /** Reference shift since the anchor (µs). */
    const shift = () => (sync.computeAudioRenderTime(C0)?.renderTimeUs ?? START_US) - START_US;
    let maxStepUs = 0;
    /** Frame `i` arrives at `atUs`, never ahead of the frame before it. */
    const emit = (atUs: number, i: number): void => {
        nowUs = Math.max(atUs, nowUs);
        const before = shift(), n = steps();
        pipeline.pushObject(data(i), { captureTimestamp: C0 + BigInt(i * FRAME_US) });
        pipeline.tick();
        if (steps() > n) maxStepUs = Math.max(maxStepUs, shift() - before);
    };
    const decoded = () => commands.filter(c => c.type === 'decode_audio').length;
    return {
        pipeline, emit, shift, steps, decoded,
        now: () => nowUs,
        maxStepUs: () => maxStepUs,
        /** Anchor on frame 0, then 30 frames on time. */
        warm: () => { for (let i = 0; i <= 30; i++) emit(due(i), i); },
    };
}
type Harness = ReturnType<typeof harness>;

/** Delivery at `rate` of real time for `seconds`, then the backlog at once, then on time. */
function sustained(h: Harness, rate: number, seconds: number) {
    h.warm();
    const d0 = h.decoded();
    const n = seconds * 1_000_000 / FRAME_US;
    let at = due(30), peakShiftUs = 0;
    for (let i = 31; i <= 30 + n; i++) {
        at += Math.round(FRAME_US / rate);
        h.emit(at, i);
        peakShiftUs = Math.max(peakShiftUs, h.shift());
    }
    const played = h.decoded() - d0, dropped = h.pipeline.lateAudioDrops, steps = h.steps();
    const backlogAt = at;
    let givenBackAfterUs: number | null = null;
    for (let i = 31 + n; i <= 30 + n + 400; i++) {
        h.emit(due(i), i);
        if (givenBackAfterUs === null && h.shift() <= 20_000) givenBackAfterUs = h.now() - backlogAt;
    }
    return { played, dropped, steps, peakShiftUs, givenBackAfterUs, finalShiftUs: h.shift() };
}

/** Anchor on time, then 30 frames each 400 ms later than the cushion covers. */
function late400(h: Harness) {
    h.emit(START_US, 0);
    for (let i = 1; i <= 30; i++) h.emit(700_000 + i * FRAME_US, i);
    return { decoded: h.decoded() - 1, steps: h.steps(), shiftUs: h.shift() };
}

/** `held` frames held back, then released together. */
function hiccup(h: Harness, held: number) {
    h.warm();
    const before = h.shift(), d0 = h.decoded();
    const last = 30 + held;
    for (let i = 31; i <= last; i++) h.emit(due(last) + FRAME_US, i);
    const burstPlayed = h.decoded() - d0;
    for (let i = last + 1; i <= last + 300; i++) h.emit(due(i), i);
    return { burstPlayed, addedUs: h.shift() - before, steps: h.steps() };
}

/** Delivery `lateUs` late for 10 s, then on time for 20 s. */
function lateFor10s(h: Harness, lateUs: number) {
    h.warm();
    const d0 = h.decoded();
    for (let i = 31; i <= 530; i++) h.emit(due(i) + lateUs, i);
    const played = h.decoded() - d0, dropped = h.pipeline.lateAudioDrops, steps = h.steps(), shiftUs = h.shift();
    const onTimeAt = h.now();
    let givenBackAfterUs: number | null = null;
    for (let i = 531; i <= 1530; i++) {
        h.emit(due(i), i);
        if (givenBackAfterUs === null && h.shift() <= 20_000) givenBackAfterUs = h.now() - onTimeAt;
    }
    return { played, dropped, steps, shiftUs, maxStepUs: h.maxStepUs(), givenBackAfterUs, finalShiftUs: h.shift() };
}

/** Exponential arrival jitter, mean 60 ms, for 60 s (seeded). */
function jitter(h: Harness) {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    h.warm();
    const d0 = h.decoded();
    for (let i = 31; i <= 3030; i++) h.emit(due(i) + Math.round(-Math.log(1 - rnd()) * 60_000), i);
    return { played: h.decoded() - d0, dropped: h.pipeline.lateAudioDrops, steps: h.steps(), finalShiftUs: h.shift() };
}

/** Delivery stalls for `stallUs`, the backlog drains at `speed` times real time, then 10 s on time. */
function drain(h: Harness, stallUs: number, speed: number) {
    h.warm();
    const d0 = h.decoded();
    let at = due(30) + stallUs, i = 31;
    for (; due(i) < at; i++) { h.emit(at, i); at += FRAME_US / speed; }
    const end = i + 500;
    for (; i <= end; i++) h.emit(due(i), i);
    return { played: h.decoded() - d0, of: end - 30, steps: h.steps(), finalShiftUs: h.shift() };
}

const follow = () => true;

describe('late audio following delivery (LIVE)', () => {
    it('90% delivery for 20 s, then the backlog: every frame plays and the shift returns with the backlog', () => {
        const r = sustained(harness(LIVE_CUSHION_US, follow), 0.9, 20);
        expect({ played: r.played, dropped: r.dropped, steps: r.steps }).toEqual({ played: 1000, dropped: 0, steps: 9 });
        // The backlog is 2.2 s; the reference follows it, plus at most the cushion and tolerance.
        expect(r.peakShiftUs).toBeGreaterThan(2_000_000);
        expect(r.peakShiftUs).toBeLessThanOrEqual(2_222_222 + LIVE_CUSHION_US + 20_000);
        // Walked back by the backlog frames themselves, within one frame of its arrival.
        expect(r.givenBackAfterUs).not.toBeNull();
        expect(r.givenBackAfterUs!).toBeLessThanOrEqual(FRAME_US);
        expect(r.finalShiftUs).toBe(20_000);
    });

    it('50% delivery for 5 s: drops only inside the late windows', () => {
        const r = sustained(harness(LIVE_CUSHION_US, follow), 0.5, 5);
        expect({ played: r.played, dropped: r.dropped }).toEqual({ played: 224, dropped: 26 });
        expect(r.finalShiftUs).toBe(20_000);
    });

    it('30 frames each 400 ms late: one step past the lateness, then on time', () => {
        // Frames 1-13 fall inside the 250 ms window; frame 14 steps by its 600 ms
        // lateness plus the 20 ms tolerance and plays, as do the rest.
        expect(late400(harness(LIVE_CUSHION_US, follow))).toEqual({ decoded: 17, steps: 1, shiftUs: 620_000 });
    });

    for (const held of [30, 180]) {
        it(`${held} frames released as a burst add no latency`, () => {
            expect(hiccup(harness(LIVE_CUSHION_US, follow), held)).toEqual({ burstPlayed: 15, addedUs: 0, steps: 0 });
        });
    }

    it('delivery 1 s late: one step, given back as soon as delivery is on time', () => {
        const r = lateFor10s(harness(LIVE_CUSHION_US, follow), 1_000_000);
        expect({ played: r.played, dropped: r.dropped, steps: r.steps }).toEqual({ played: 487, dropped: 13, steps: 1 });
        expect(r.shiftUs).toBe(1_000_000);
        expect(r.givenBackAfterUs!).toBeLessThanOrEqual(FRAME_US);
        expect(r.finalShiftUs).toBe(20_000);
    });

    it('a step is bounded at 1 s: delivery 3 s late takes three steps', () => {
        const r = lateFor10s(harness(LIVE_CUSHION_US, follow), 3_000_000);
        expect({ played: r.played, dropped: r.dropped, steps: r.steps }).toEqual({ played: 461, dropped: 39, steps: 3 });
        expect(r.maxStepUs).toBe(1_000_000);
        expect(r.finalShiftUs).toBe(20_000);
    });

    for (const { stallUs, speed, played, of } of [
        { stallUs: 1_000_000, speed: 2, played: 531, of: 599 },
        { stallUs: 1_000_000, speed: 1.5, played: 546, of: 649 },
        { stallUs: 3_000_000, speed: 1.5, played: 546, of: 948 },
    ]) {
        it(`a ${stallUs / 1e6} s stall draining at ${speed}x takes no step: the backlog ends on its own`, () => {
            expect(drain(harness(LIVE_CUSHION_US, follow), stallUs, speed))
                .toEqual({ played, of, steps: 0, finalShiftUs: 0 });
        });
    }

    it('a late run that stops shrinking steps', () => {
        const h = harness(LIVE_CUSHION_US, follow);
        h.warm();
        // 1 s stall, then the backlog drains at 2x for 300 ms and delivery stays that late.
        let at = due(30) + 1_000_000, i = 31;
        for (; i <= 60; i++) { h.emit(at, i); at += FRAME_US / 2; }
        const lateUs = at - due(i), steadyFrom = i;
        expect(h.steps()).toBe(0);
        let steppedAt = 0, d0 = 0;
        for (; i <= 160; i++) {
            h.emit(due(i) + lateUs, i);
            if (steppedAt === 0 && h.steps() === 1) { steppedAt = i; d0 = h.decoded(); }
        }
        expect(h.steps()).toBe(1);
        // Within two windows of the lateness holding still; every frame after it plays.
        expect((steppedAt - steadyFrom) * FRAME_US).toBeLessThanOrEqual(500_000);
        expect(h.decoded() - d0).toBe(160 - steppedAt);
    });

    it('jitter alone never steps', () => {
        expect(jitter(harness(LIVE_CUSHION_US, follow))).toEqual({ played: 2942, dropped: 58, steps: 0, finalShiftUs: 0 });
    });

    it('reads the mode per decision', () => {
        let following = false;
        const h = harness(LIVE_CUSHION_US, () => following);
        h.warm();
        for (let i = 31; i <= 50; i++) h.emit(due(i) + 1_000_000, i);
        expect({ steps: h.steps(), shiftUs: h.shift() }).toEqual({ steps: 1, shiftUs: 100_000 });
        following = true;
        for (let i = 51; i <= 70; i++) h.emit(due(i) + 1_000_000, i);
        // No 2 s spacing once following: the next window steps by the rest of the lateness.
        expect({ steps: h.steps(), shiftUs: h.shift() }).toEqual({ steps: 2, shiftUs: 1_020_000 });
    });
});

describe('late audio not following delivery: values of the 100 ms per 2 s rule', () => {
    for (const { mode, cushionUs, expected } of [
        { mode: 'LIVE cushion', cushionUs: LIVE_CUSHION_US, expected: { played: 174, dropped: 826, steps: 10, peakShiftUs: 948_866 } },
        { mode: 'LIVE(+1s)', cushionUs: PLUS_1S_CEILING_US, expected: { played: 967, dropped: 33, steps: 1, peakShiftUs: 48_686 } },
        { mode: 'LIVE(+2s)', cushionUs: PLUS_2S_CEILING_US, expected: { played: 1000, dropped: 0, steps: 0, peakShiftUs: 0 } },
    ]) {
        it(`${mode}: 90% delivery for 20 s, then the backlog`, () => {
            for (const h of [harness(cushionUs), harness(cushionUs, () => false)]) {
                const r = sustained(h, 0.9, 20);
                expect({ played: r.played, dropped: r.dropped, steps: r.steps, peakShiftUs: Math.round(r.peakShiftUs) })
                    .toEqual(expected);
            }
        });
    }

    for (const { mode, cushionUs, expected } of [
        { mode: 'LIVE(+1s)', cushionUs: PLUS_1S_CEILING_US, expected: { played: 110, dropped: 140, steps: 3 } },
        { mode: 'LIVE(+2s)', cushionUs: PLUS_2S_CEILING_US, expected: { played: 159, dropped: 91, steps: 2 } },
    ]) {
        it(`${mode}: 50% delivery for 5 s`, () => {
            const r = sustained(harness(cushionUs, () => false), 0.5, 5);
            expect({ played: r.played, dropped: r.dropped, steps: r.steps }).toEqual(expected);
        });
    }

    for (const { mode, cushionUs, expected } of [
        { mode: 'LIVE cushion', cushionUs: LIVE_CUSHION_US, expected: { decoded: 1, steps: 1, shiftUs: 100_000 } },
        { mode: 'LIVE(+1s)', cushionUs: PLUS_1S_CEILING_US, expected: { decoded: 30, steps: 0, shiftUs: 0 } },
        { mode: 'LIVE(+2s)', cushionUs: PLUS_2S_CEILING_US, expected: { decoded: 30, steps: 0, shiftUs: 0 } },
    ]) {
        it(`${mode}: 30 frames each 400 ms late`, () => {
            expect(late400(harness(cushionUs, () => false))).toEqual(expected);
        });
    }

    for (const { mode, held, cushionUs, burstPlayed } of [
        { mode: 'LIVE(+1s)', held: 30, cushionUs: PLUS_1S_CEILING_US, burstPlayed: 30 },
        { mode: 'LIVE(+1s)', held: 180, cushionUs: PLUS_1S_CEILING_US, burstPlayed: 105 },
        { mode: 'LIVE(+2s)', held: 30, cushionUs: PLUS_2S_CEILING_US, burstPlayed: 30 },
        { mode: 'LIVE(+2s)', held: 180, cushionUs: PLUS_2S_CEILING_US, burstPlayed: 155 },
    ]) {
        it(`${mode}: ${held} frames released as a burst`, () => {
            expect(hiccup(harness(cushionUs, () => false), held)).toEqual({ burstPlayed, addedUs: 0, steps: 0 });
        });
    }

    for (const { mode, cushionUs, expected } of [
        { mode: 'LIVE(+1s)', cushionUs: PLUS_1S_CEILING_US, expected: { played: 5, dropped: 495, steps: 5, shiftUs: 500_000 } },
        { mode: 'LIVE(+2s)', cushionUs: PLUS_2S_CEILING_US, expected: { played: 500, dropped: 0, steps: 0, shiftUs: 0 } },
    ]) {
        it(`${mode}: delivery 3 s late for 10 s`, () => {
            const r = lateFor10s(harness(cushionUs, () => false), 3_000_000);
            expect({ played: r.played, dropped: r.dropped, steps: r.steps, shiftUs: r.shiftUs }).toEqual(expected);
        });
    }

    for (const { mode, cushionUs, stallUs, speed, expected } of [
        { mode: 'LIVE cushion', cushionUs: LIVE_CUSHION_US, stallUs: 1_000_000, speed: 2,
            expected: { played: 542, of: 599, steps: 1, finalShiftUs: 20_000 } },
        { mode: 'LIVE(+1s)', cushionUs: PLUS_1S_CEILING_US, stallUs: 3_000_000, speed: 1.5,
            expected: { played: 832, of: 948, steps: 1, finalShiftUs: 20_000 } },
        { mode: 'LIVE(+2s)', cushionUs: PLUS_2S_CEILING_US, stallUs: 3_000_000, speed: 1.5,
            expected: { played: 948, of: 948, steps: 0, finalShiftUs: 0 } },
    ]) {
        it(`${mode}: a ${stallUs / 1e6} s stall draining at ${speed}x`, () => {
            const r = drain(harness(cushionUs, () => false), stallUs, speed);
            expect({ ...r, finalShiftUs: Math.round(r.finalShiftUs) }).toEqual(expected);
        });
    }
});
