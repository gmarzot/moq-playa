import { describe, it, expect } from 'vitest';
import { DeliveryLagDetector } from './delivery-lag-detector.js';

const S = 1_000_000;
const FPS = 30;
const FRAME_US = S / FPS;
const GOP = 60;
const KEY_SHARE = 0.2;
const PATH_US = 20_000;
const TICK_US = 16_000;
const AMPLE = 30e6;
/** A sender clock offset: only the trend may count. */
const EPOCH_US = 1_762_000_000_000_000;

function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

interface Delivery { captureUs: number; arrivalUs: number }

/**
 * Live video at capture pace through a FIFO bottleneck: a 2 s GOP whose
 * keyframe is 20% of it. Returns deliveries in arrival order.
 */
function trace(opts: {
    seconds?: number;
    bitrate: number;
    capacity: (t: number) => number;
    extraDelay?: (t: number) => number;
    /** Capture time steps by `byUs` from `atUs` on. */
    steps?: Array<{ atUs: number; byUs: number }>;
    /** Presentation index of the frame sent `i`th (decode order). */
    ptsOf?: (i: number) => number;
}): Delivery[] {
    const out: Delivery[] = [];
    let busyUntil = 0;
    const gopBytes = opts.bitrate * (GOP / FPS) / 8;
    for (let i = 0; i < (opts.seconds ?? 60) * FPS; i++) {
        const t = i * FRAME_US;
        const bytes = i % GOP === 0 ? gopBytes * KEY_SHARE : gopBytes * (1 - KEY_SHARE) / (GOP - 1);
        busyUntil = Math.max(t, busyUntil) + bytes * 8 / opts.capacity(t) * S;
        let captureUs = EPOCH_US + (opts.ptsOf?.(i) ?? i) * FRAME_US;
        for (const step of opts.steps ?? []) if (t >= step.atUs) captureUs += step.byUs;
        out.push({ captureUs, arrivalUs: busyUntil + PATH_US + (opts.extraDelay?.(t) ?? 0) });
    }
    return out.sort((a, b) => a.arrivalUs - b.arrivalUs);
}

/** Times (µs) at which a 16 ms tick finds congestion. */
function fires(deliveries: Delivery[], d = new DeliveryLagDetector()): number[] {
    const out: number[] = [];
    const endUs = deliveries[deliveries.length - 1]!.arrivalUs;
    let k = 0;
    for (let now = 0; now <= endUs; now += TICK_US) {
        while (k < deliveries.length && deliveries[k]!.arrivalUs <= now) {
            d.record(deliveries[k]!.captureUs, deliveries[k]!.arrivalUs);
            k++;
        }
        if (d.isCongested(now)) out.push(now);
    }
    return out;
}

/** Seconds from `fromUs` to the first fire at or after it, or null. */
function firstFireS(deliveries: Delivery[], fromUs: number): number | null {
    const t = fires(deliveries).find(x => x >= fromUs);
    return t === undefined ? null : (t - fromUs) / S;
}

/** Frames at capture pace into one detector; `now` is the latest arrival. */
class Frames {
    t = 0;
    now = 0;
    private shiftUs = 0;
    constructor(readonly d = new DeliveryLagDetector()) {}
    /** Frames until capture time `endUs`, each arriving `lag` after capture. */
    until(endUs: number, lag: number | ((t: number) => number)): this {
        for (; this.t < endUs; this.t += FRAME_US) {
            this.now = this.t + (typeof lag === 'number' ? lag : lag(this.t));
            this.d.record(EPOCH_US + this.t + this.shiftUs, this.now);
        }
        return this;
    }
    /** Steps the sender clock: later captures read `byUs` off. */
    shift(byUs: number): this {
        this.shiftUs += byUs;
        return this;
    }
}

const cutAt = (atUs: number, after: number) => (t: number) => (t < atUs ? AMPLE : after);
const jitter = (seed: number, maxUs: number) => { const r = rng(seed); return () => r() * maxUs; };
const wifiBursts = (seed: number) => {
    const r = rng(seed);
    return () => (r() < 1 / 30 ? 150_000 + r() * 250_000 : r() * 10_000);
};
/** I P B B decode order: the P is shown after its two B frames. */
const pbb = (i: number) => { const k = i % 4, b = i - k; return [b, b + 3, b + 1, b + 2][k]!; };

describe('DeliveryLagDetector on a link falling short', () => {
    it.each([
        ['3.1 Mbps rung, link cut to 2.5 Mbps at a GOP start', 3.1e6, 2.5e6, 20 * S, 1.5],
        ['1.5 Mbps rung, link cut to 1.0 Mbps', 1.5e6, 1.0e6, 20 * S, 1.5],
        ['3.1 Mbps rung, link cut to 2.5 Mbps mid-GOP', 3.1e6, 2.5e6, 21 * S, 2.5],
        ['4.5 Mbps rung, link cut to 4.0 Mbps (11% short)', 4.5e6, 4.0e6, 20 * S, 6],
        ['4.5 Mbps rung, link cut to 4.3 Mbps (4% short) mid-GOP', 4.5e6, 4.3e6, 21 * S, 9],
    ])('%s', (_name, bitrate, after, cutUs, withinS) => {
        const tr = trace({ bitrate, capacity: cutAt(cutUs, after) });
        expect(fires(tr).filter(t => t < cutUs)).toHaveLength(0);
        expect(firstFireS(tr, cutUs)).toBeLessThan(withinS);
    });

    it('with arrival jitter', () => {
        const tr = trace({ bitrate: 3.1e6, capacity: cutAt(21 * S, 2.5e6), extraDelay: jitter(5, 10_000) });
        expect(firstFireS(tr, 21 * S)).toBeLessThan(2.5);
    });

    it('with B-frames, whose captures run briefly behind the latest', () => {
        const tr = trace({ bitrate: 3.1e6, capacity: cutAt(21 * S, 2.5e6), ptsOf: pbb, extraDelay: jitter(19, 10_000) });
        expect(firstFireS(tr, 21 * S)).toBeLessThan(2.5);
    });

    it('on a VBR scene the link cannot carry', () => {
        const tr = trace({ bitrate: 3e6, capacity: () => 4e6, seconds: 30 });
        expect(fires(tr)).toHaveLength(0);
        const scene = trace({ bitrate: 3e6, capacity: (t) => (t >= 10 * S && t < 18 * S ? 4e6 / 3 : 4e6), seconds: 30 });
        expect(firstFireS(scene, 10 * S)).toBeLessThan(3);
    });
});

describe('DeliveryLagDetector without congestion', () => {
    it.each([
        ['91% utilised', () => trace({ bitrate: 1.5e6, capacity: () => 1.65e6 })],
        ['96% utilised, each keyframe over 300 ms on the link', () => trace({ bitrate: 4.5e6, capacity: () => 4.7e6 })],
        ['keyframe bursts on 6 Mbps', () => trace({ bitrate: 4.5e6, capacity: () => 6e6 })],
        ['Wi-Fi bursts of 150-400 ms', () => trace({ bitrate: 3e6, capacity: () => AMPLE, extraDelay: wifiBursts(7) })],
        ['a 400 ms delivery hole every 5 s', () => trace({
            bitrate: 3e6, capacity: () => AMPLE,
            extraDelay: (t) => { const p = t % (5 * S); return p < 400_000 ? 400_000 - p : 0; },
        })],
        ['cell holes of 500-700 ms', () => {
            const r = rng(11);
            return trace({ bitrate: 3e6, capacity: () => AMPLE, extraDelay: () => (r() < 1 / 60 ? 500_000 + r() * 200_000 : r() * 20_000) });
        }],
        ['B-frames with jitter', () => trace({ bitrate: 3e6, capacity: () => AMPLE, ptsOf: pbb, extraDelay: jitter(17, 10_000) })],
    ])('holds: %s', (_name, make) => {
        expect(fires(make())).toHaveLength(0);
    });

    it('holds through a delivery hole whose catch-up arrives in two pieces', () => {
        // As on a recorded LOC viewer: 530 ms without video, then eight frames at once and the rest 100 ms later.
        const d = new DeliveryLagDetector();
        let arrival = 0;
        for (let i = 0; i < 300; i++, arrival += FRAME_US) d.record(EPOCH_US + arrival - 65_000, arrival);
        const holeStart = arrival - FRAME_US;
        const pieces = [holeStart + 530_000, holeStart + 630_000];
        for (let i = 0; i < 19; i++) {
            const at = pieces[i < 8 ? 0 : 1]!;
            d.record(EPOCH_US + holeStart + (i + 1) * FRAME_US - 65_000, at);
            expect(d.isCongested(at)).toBe(false);
        }
        for (let now = pieces[1]!, c = holeStart + 20 * FRAME_US; now < pieces[1]! + 3 * S; now += FRAME_US, c += FRAME_US) {
            d.record(EPOCH_US + c - 65_000, Math.max(now, c));
            expect(d.isCongested(Math.max(now, c))).toBe(false);
        }
    });

    it('does not read a draining backlog as congestion', () => {
        // Lag grows to 1 s, then drains to 400 ms after a step down.
        const lags: number[] = [];
        for (let i = 0; i < 150; i++) lags.push(20_000);
        for (let lag = 20_000; lag < 1_000_000; lag += 15_000) lags.push(lag);
        const peak = lags.length;
        for (let lag = 1_000_000; lag > 400_000; lag -= 10_000) lags.push(lag);
        for (let i = 0; i < 150; i++) lags.push(400_000);
        const tr = lags.map((lag, i) => ({ captureUs: EPOCH_US + i * FRAME_US, arrivalUs: i * FRAME_US + lag }));
        const at = fires(tr);
        const peakUs = tr[peak]!.arrivalUs;
        expect(at.some(t => t < peakUs)).toBe(true);
        expect(at.filter(t => t > peakUs + 500_000)).toHaveLength(0);
    });
});

describe('DeliveryLagDetector through publisher clock steps', () => {
    const cases: Array<[string, (t: number) => number]> = [
        ['clean', () => 0],
        ['jitter', jitter(3, 10_000)],
        ['Wi-Fi bursts', wifiBursts(7)],
    ];
    for (const byUs of [-300_000, -500_000, -800_000, -1_200_000]) {
        it.each(cases)(`holds through a ${byUs / 1000} ms step (%s)`, (_name, extraDelay) => {
            const tr = trace({ bitrate: 3e6, capacity: () => AMPLE, steps: [{ atUs: 30 * S, byUs }], extraDelay });
            expect(fires(tr)).toHaveLength(0);
        });
    }

    it('holds through a clock that steps forward and back', () => {
        const tr = trace({
            bitrate: 3e6, capacity: () => AMPLE, extraDelay: jitter(9, 10_000),
            steps: [{ atUs: 20 * S, byUs: 800_000 }, { atUs: 40 * S, byUs: -800_000 }],
        });
        expect(fires(tr)).toHaveLength(0);
    });

    it('starts the evidence over on a step, and has no opinion until it is known', () => {
        const f = new Frames();
        f.until(5 * S, 20_000).until(7 * S, 500_000);
        expect(f.d.excessLagUs(f.now)).toBe(480_000);
        f.shift(-700_000).until(f.t + FRAME_US, 500_000);
        expect(f.d.excessLagUs(f.now)).toBeNull();
        expect(f.d.isCongested(f.now)).toBe(false);
        f.until(f.t + S, 500_000);
        expect(f.d.excessLagUs(f.now)).toBe(0);
    });

    it('keeps its evidence through a late or reordered object', () => {
        const f = new Frames();
        f.until(5 * S, 20_000).until(7 * S, 500_000);
        // The previous group's tail, 900 ms behind, then live frames again.
        f.d.record(EPOCH_US + f.t - 900_000, f.now);
        f.d.record(EPOCH_US + f.t - 870_000, f.now);
        f.until(f.t + 10 * FRAME_US, 500_000);
        expect(f.d.excessLagUs(f.now)).toBe(480_000);
    });
});

describe('DeliveryLagDetector evidence', () => {
    it('reports no excess for a flat lag, whatever the clock offset', () => {
        const f = new Frames().until(10 * S, 20_000);
        expect(f.d.excessLagUs(f.now)).toBe(0);
        expect(f.d.isCongested(f.now)).toBe(false);
    });

    it('has no opinion when nothing arrived in the last window', () => {
        const f = new Frames().until(10 * S, 20_000);
        expect(f.d.excessLagUs(f.now + 2 * S)).toBeNull();
        expect(f.d.isCongested(f.now + 2 * S)).toBe(false);
    });

    it('counts an excess once it has stood through a whole window', () => {
        const f = new Frames().until(5 * S, 20_000);
        const growing = (t: number) => 420_000 + (t - 5 * S) * 0.06;
        f.until(5.5 * S, growing);
        expect(f.d.excessLagUs(f.now)).toBe(0);
        expect(f.d.isCongested(f.now)).toBe(false);
        f.until(6 * S, growing);
        expect(f.d.excessLagUs(f.now)).toBeGreaterThan(300_000);
        expect(f.d.isCongested(f.now)).toBe(true);
    });

    it('forgets the floor after the base history', () => {
        const f = new Frames(new DeliveryLagDetector({ baseHistoryUs: 5 * S }));
        f.until(5 * S, 20_000).until(12 * S, 600_000);
        expect(f.d.excessLagUs(f.now)).toBe(0);
    });

    it('starts over on reset', () => {
        const f = new Frames().until(5 * S, 20_000).until(7 * S, 500_000);
        f.d.reset();
        expect(f.d.excessLagUs(f.now)).toBeNull();
        f.until(f.t + S, 500_000);
        expect(f.d.excessLagUs(f.now)).toBe(0);
    });

    it('ignores non-finite values and arrivals that go backwards', () => {
        const f = new Frames().until(S, 20_000);
        f.d.record(NaN, f.now + 1);
        f.d.record(EPOCH_US + f.t, Infinity);
        f.d.record(EPOCH_US + f.t - 5 * S, f.now - 1);
        expect(f.d.excessLagUs(f.now)).toBe(0);
    });

    it('starts over rather than grow past its sample budget', () => {
        const f = new Frames();
        for (let i = 0; i < 10_000; i++) f.d.record(EPOCH_US, 20_000 + i / 100);
        expect((f.d as unknown as { samples: unknown[] }).samples.length).toBeLessThanOrEqual(4096);
        f.t = 100_000;
        f.until(2 * S, 20_000);
        expect(f.d.excessLagUs(f.now)).toBe(0);
    });
});
