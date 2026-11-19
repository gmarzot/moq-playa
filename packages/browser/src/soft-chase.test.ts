/**
 * SoftChase engage and release against burst and steady arrival.
 */
import { describe, it, expect } from 'vitest';
import { SoftChase } from './soft-chase.js';

function setup(targetSec: number) {
    const element = { playbackRate: 1 };
    const clock = { ms: 0 };
    const chase = new SoftChase(element, () => targetSec, () => clock.ms);
    return { element, clock, chase };
}

/** Groups of 2.5 s sent in one 20 ms burst of 75 objects, then ticks every 100 ms. */
function bursts(targetSec: number, troughSec: number, cycles: number) {
    const { element, clock, chase } = setup(targetSec);
    let ahead = troughSec;
    let peak = 0;
    let lowAfterFirst = Infinity;
    for (let c = 0; c < cycles; c++) {
        if (c > 0) lowAfterFirst = Math.min(lowAfterFirst, ahead);
        for (let k = 0; k < 75; k++) {
            chase.onLowPoint(ahead);
            ahead += 2.5 / 75;
            peak = Math.max(peak, ahead);
            chase.onCushion(ahead);
            clock.ms += 20 / 75;
            ahead -= 0.02 / 75 * element.playbackRate;
        }
        for (let ms = 20; ms < 2500; ms += 100) {
            const step = Math.min(100, 2500 - ms) / 1000;
            clock.ms += step * 1000;
            ahead -= step * element.playbackRate;
            chase.onCushion(ahead);
        }
    }
    return { chase, peak, lowAfterFirst };
}

describe('SoftChase', () => {
    const TARGET = 2;
    const ENGAGE = TARGET + TARGET * SoftChase.ON_RATIO;

    it('burst arrival whose trough is below the band does not chase', () => {
        const { chase, peak } = bursts(TARGET, 1.25, 6);
        expect(peak).toBeGreaterThan(ENGAGE);
        expect(chase.starts).toBe(0);
    });

    it('burst arrival whose trough is above the band chases', () => {
        const { chase } = bursts(TARGET, ENGAGE + 0.2, 6);
        expect(chase.starts).toBeGreaterThan(0);
    });

    it('steady 30 fps arrival engages once the low point passes the band and releases at the target', () => {
        const target = 0.2;
        const engage = target + target * SoftChase.ON_RATIO;
        const { element, clock, chase } = setup(target);
        const frame = 1 / 30;
        let ahead = 0.25;
        let engagedLow: number | null = null;
        const step = (arrivalSec: number) => {
            const low = ahead;
            chase.onLowPoint(low);
            ahead += arrivalSec;
            const was = chase.chasing;
            chase.onCushion(ahead);
            if (!was && chase.chasing) engagedLow = low;
            clock.ms += frame * 1000;
            ahead -= frame * element.playbackRate;
        };
        while (!chase.chasing && clock.ms < 10_000) step(frame + 0.005);
        expect(chase.starts).toBe(1);
        expect(engagedLow!).toBeGreaterThan(engage);
        expect(engagedLow!).toBeLessThan(engage + frame + 0.005);
        while (chase.chasing && clock.ms < 20_000) step(frame);
        expect(chase.chasing).toBe(false);
        expect(ahead).toBeGreaterThan(target - frame);
        expect(ahead).toBeLessThanOrEqual(target + frame);
    });

    it('without low points the cushion alone engages', () => {
        const { element, chase } = setup(0.2);
        chase.onCushion(0.35);
        expect(element.playbackRate).toBe(SoftChase.RATE);
    });

    it('reset forgets the low points', () => {
        const { element, clock, chase } = setup(0.2);
        chase.onLowPoint(0.1);
        clock.ms += 50;
        chase.onCushion(0.4);
        expect(element.playbackRate).toBe(1);
        chase.reset();
        chase.onCushion(0.4);
        expect(element.playbackRate).toBe(SoftChase.RATE);
    });
});
