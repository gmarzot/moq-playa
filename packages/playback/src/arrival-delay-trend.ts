/**
 * ArrivalDelayTrend — whether one track's arrival delay (arrival time minus
 * capture time) keeps rising: the backlog of a link that cannot carry it.
 *
 * Per-second minimums ignore an object that is late on its own, such as a
 * keyframe; a steady rise across the window's thirds tells a backlog from a
 * one-off clock step. The clocks' offset cancels: only the change counts.
 *
 * @module
 */

export class ArrivalDelayTrend {
    static readonly BUCKET_US = 1_000_000;
    static readonly WINDOW_US = 8_000_000;
    /** Shortest span of samples that can show a rise. */
    static readonly MIN_SPAN_US = 4_000_000;
    /** A jump this large is a timestamp discontinuity (a loop, a new source). */
    static readonly DISCONTINUITY_US = 5_000_000;

    private buckets: Array<{ startUs: number; minUs: number }> = [];
    private lastDelayUs: number | null = null;
    private track: string | null = null;

    /** One object of `track`; another track starts the trend afresh. */
    record(track: string, arrivalUs: number, captureUs: number): void {
        if (track !== this.track) {
            this.reset();
            this.track = track;
        }
        const delayUs = arrivalUs - captureUs;
        if (this.lastDelayUs !== null && Math.abs(delayUs - this.lastDelayUs) > ArrivalDelayTrend.DISCONTINUITY_US) {
            this.buckets = [];
        }
        this.lastDelayUs = delayUs;
        const last = this.buckets[this.buckets.length - 1];
        if (last && arrivalUs - last.startUs < ArrivalDelayTrend.BUCKET_US) {
            if (delayUs < last.minUs) last.minUs = delayUs;
        } else {
            this.buckets.push({ startUs: arrivalUs, minUs: delayUs });
        }
        this.trim(arrivalUs);
    }

    /**
     * How far `track`'s delay rose across the window (µs), or 0 unless it rose
     * through both halves of it: the last third's minimum above the middle's,
     * and the middle's above the first's, each by a quarter of the rise.
     */
    riseUs(track: string, nowUs: number): number {
        if (track !== this.track) return 0;
        this.trim(nowUs);
        const b = this.buckets;
        if (b.length < 3 || b[b.length - 1]!.startUs - b[0]!.startUs < ArrivalDelayTrend.MIN_SPAN_US) return 0;
        const third = Math.floor(b.length / 3);
        const low = (from: number, to: number): number =>
            b.slice(from, to).reduce((m, x) => Math.min(m, x.minUs), Infinity);
        const first = low(0, third);
        const middle = low(third, b.length - third);
        const end = low(b.length - third, b.length);
        const rise = end - first;
        if (rise <= 0 || middle - first < rise / 4 || end - middle < rise / 4) return 0;
        return rise;
    }

    reset(): void {
        this.buckets = [];
        this.lastDelayUs = null;
        this.track = null;
    }

    private trim(nowUs: number): void {
        while (this.buckets.length && nowUs - this.buckets[0]!.startUs > ArrivalDelayTrend.WINDOW_US) this.buckets.shift();
    }
}
