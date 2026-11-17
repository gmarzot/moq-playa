/**
 * DeliveryLagDetector — whether one track's delivery lag (arrival time minus
 * capture or media time) stands above its floor and keeps rising: the backlog
 * of a link that cannot carry the track.
 *
 * Only changes in lag count, so a constant clock offset cancels; clock-rate
 * skew does not. The floor is the lowest lag over the base history, kept as
 * per-second minima. Window minima ignore an object late on its own, such as
 * a keyframe. The excess must stand through the previous window, so a
 * delivery hole whose catch-up arrives in pieces does not count.
 *
 * Captures that stay behind the latest one for `stepConfirmUs` are a clock
 * step or a timeline restart, and the evidence starts over; a late or
 * reordered object is soon followed by one that is ahead again. Until that is
 * known there is no opinion.
 *
 * @module
 */

export interface DeliveryLagConfig {
    /** Minimum-lag window (µs). Default 500 ms. */
    readonly windowUs?: number;
    /** Excess over the floor that counts (µs). Default 300 ms. */
    readonly excessThresholdUs?: number;
    /** History the floor is taken over (µs). Default 60 s. */
    readonly baseHistoryUs?: number;
    /** How long captures must stay behind the latest one to be a clock step (µs). Default 150 ms. */
    readonly stepConfirmUs?: number;
}

const BUCKET_US = 1_000_000;
/** Far above any media rate over two windows; beyond it the evidence starts over. */
const MAX_SAMPLES = 4096;

export class DeliveryLagDetector {
    private readonly windowUs: number;
    private readonly excessThresholdUs: number;
    private readonly baseHistoryUs: number;
    private readonly stepConfirmUs: number;

    private samples: Array<{ arrivalUs: number; lagUs: number }> = [];
    private buckets: Array<{ startUs: number; minLagUs: number }> = [];
    private latestCaptureUs: number | null = null;
    private lastArrivalUs: number | null = null;
    /** Arrival since which captures have stayed behind the latest one. */
    private behindSinceUs: number | null = null;

    constructor(config?: DeliveryLagConfig) {
        this.windowUs = config?.windowUs ?? 500_000;
        this.excessThresholdUs = config?.excessThresholdUs ?? 300_000;
        this.baseHistoryUs = config?.baseHistoryUs ?? 60_000_000;
        this.stepConfirmUs = config?.stepConfirmUs ?? 150_000;
    }

    /** One object: its capture or media time and its arrival time (µs). Non-finite or backward arrivals are ignored. */
    record(captureUs: number, arrivalUs: number): void {
        if (!Number.isFinite(captureUs) || !Number.isFinite(arrivalUs)) return;
        if (this.lastArrivalUs !== null && arrivalUs < this.lastArrivalUs) return;
        this.lastArrivalUs = arrivalUs;

        if (this.latestCaptureUs !== null && captureUs < this.latestCaptureUs) {
            if (this.behindSinceUs === null) this.behindSinceUs = arrivalUs;
            else if (arrivalUs - this.behindSinceUs >= this.stepConfirmUs) this.clearEvidence();
        } else {
            this.behindSinceUs = null;
        }
        this.expireSamples(arrivalUs);
        if (this.samples.length >= MAX_SAMPLES) this.clearEvidence();

        this.latestCaptureUs = this.latestCaptureUs === null ? captureUs : Math.max(this.latestCaptureUs, captureUs);
        const lagUs = arrivalUs - captureUs;
        this.samples.push({ arrivalUs, lagUs });
        const startUs = Math.floor(arrivalUs / BUCKET_US) * BUCKET_US;
        const last = this.buckets[this.buckets.length - 1];
        if (last && last.startUs === startUs) {
            if (lagUs < last.minLagUs) last.minLagUs = lagUs;
        } else {
            this.buckets.push({ startUs, minLagUs: lagUs });
        }
        this.expireBuckets(arrivalUs);
    }

    /**
     * How far the lag has stood above its floor through both windows (µs);
     * null when either window is empty or a step is unresolved.
     */
    excessLagUs(nowUs: number): number | null {
        const q = this.query(nowUs);
        return q === null ? null : Math.min(q.recentUs, q.previousUs) - q.floorUs;
    }

    /** A standing excess over the threshold that keeps rising. */
    isCongested(nowUs: number): boolean {
        const q = this.query(nowUs);
        return q !== null && q.previousUs - q.floorUs > this.excessThresholdUs && q.recentUs > q.previousUs;
    }

    reset(): void {
        this.clearEvidence();
        this.lastArrivalUs = null;
    }

    private query(nowUs: number): { recentUs: number; previousUs: number; floorUs: number } | null {
        this.expireSamples(nowUs);
        const recentUs = this.windowMin(nowUs - this.windowUs, nowUs);
        if (recentUs === null) this.expireBuckets(nowUs);
        const previousUs = this.windowMin(nowUs - 2 * this.windowUs, nowUs - this.windowUs);
        if (recentUs === null || previousUs === null || this.behindSinceUs !== null || this.buckets.length === 0) return null;
        let floorUs = this.buckets[0]!.minLagUs;
        for (const b of this.buckets) if (b.minLagUs < floorUs) floorUs = b.minLagUs;
        return { recentUs, previousUs, floorUs };
    }

    private clearEvidence(): void {
        this.samples = [];
        this.buckets = [];
        this.latestCaptureUs = null;
        this.behindSinceUs = null;
    }

    private expireSamples(nowUs: number): void {
        const keepFrom = nowUs - 2 * this.windowUs;
        let drop = 0;
        while (drop < this.samples.length && this.samples[drop]!.arrivalUs <= keepFrom) drop++;
        if (drop > 0) this.samples.splice(0, drop);
    }

    private expireBuckets(nowUs: number): void {
        while (this.buckets.length > 0 && this.buckets[0]!.startUs + BUCKET_US <= nowUs - this.baseHistoryUs) this.buckets.shift();
    }

    /** Minimum lag over arrivals in (fromUs, toUs], or null. */
    private windowMin(fromUs: number, toUs: number): number | null {
        let min: number | null = null;
        for (const s of this.samples) {
            if (s.arrivalUs <= fromUs || s.arrivalUs > toUs) continue;
            if (min === null || s.lagUs < min) min = s.lagUs;
        }
        return min;
    }
}
