import { describe, it, expect } from 'vitest';
import { BandwidthEstimator } from './bandwidth-estimator.js';

describe('BandwidthEstimator link rate', () => {
    it('reports 0 until three large objects are timed', () => {
        const est = new BandwidthEstimator();
        est.recordBurst(100_000, 10, 1_000_000);
        est.recordBurst(100_000, 10, 1_100_000);
        expect(est.getBurstKbps(1_200_000)).toBe(0);
        est.recordBurst(100_000, 10, 1_200_000);
        expect(est.getBurstKbps(1_200_000)).toBe(80_000);
    });

    it('ignores small objects and transfers below timer resolution', () => {
        const est = new BandwidthEstimator();
        for (let i = 0; i < 5; i++) est.recordBurst(4_000, 5, i * 100_000);
        for (let i = 0; i < 5; i++) est.recordBurst(100_000, 0.5, i * 100_000);
        expect(est.getBurstKbps(500_000)).toBe(0);
    });

    it('takes the lower median, so one fast outlier cannot raise it', () => {
        const est = new BandwidthEstimator();
        // 8, 16 and 800 Mbps, then 24 Mbps: lower median of four is 16 Mbps.
        est.recordBurst(100_000, 100, 0);
        est.recordBurst(100_000, 50, 1);
        est.recordBurst(100_000, 1, 2);
        expect(est.getBurstKbps(2)).toBe(16_000);
        est.recordBurst(100_000, 100 / 3, 3);
        expect(est.getBurstKbps(3)).toBe(16_000);
    });

    it('forgets samples older than the window', () => {
        const est = new BandwidthEstimator();
        for (let i = 0; i < 3; i++) est.recordBurst(100_000, 10, i);
        expect(est.getBurstKbps(BandwidthEstimator.BURST_WINDOW_US)).toBe(80_000);
        expect(est.getBurstKbps(BandwidthEstimator.BURST_WINDOW_US + 3)).toBe(0);
    });

    it('reset clears the link rate', () => {
        const est = new BandwidthEstimator();
        for (let i = 0; i < 3; i++) est.recordBurst(100_000, 10, i);
        est.reset();
        expect(est.getBurstKbps(3)).toBe(0);
    });
});
