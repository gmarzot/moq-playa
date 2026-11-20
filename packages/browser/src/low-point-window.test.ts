import { describe, it, expect } from 'vitest';
import { LowPointWindow } from './low-point-window.js';

describe('LowPointWindow', () => {
    it('steady arrival keeps the minimum window', () => {
        const w = new LowPointWindow();
        for (let i = 0; i < 300; i++) w.push(i / 30, i);
        expect(w.windowSec(299 / 30)).toBe(LowPointWindow.MIN_SEC);
        expect(w.min(299 / 30)).toBe(292);
    });

    it('a burst cadence widens the window to twice the gap, capped', () => {
        const w = new LowPointWindow();
        w.push(0, 1);
        w.push(0.01, 3);
        w.push(2.5, 2);
        expect(w.windowSec(2.5)).toBeCloseTo(4.98, 5);
        expect(w.min(2.5)).toBe(1);
        expect(w.windowSec(9)).toBe(LowPointWindow.MAX_SEC);
    });

    it('forgets gaps and samples older than its history', () => {
        const w = new LowPointWindow();
        w.push(0, 0);
        w.push(3, 5);
        for (let t = 3; t <= 14; t += 0.02) w.push(t, 5);
        expect(w.windowSec(14)).toBe(LowPointWindow.MIN_SEC);
        expect(w.min(14)).toBe(5);
        expect(new LowPointWindow().min(1)).toBeNull();
    });
});
