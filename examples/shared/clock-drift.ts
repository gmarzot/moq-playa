/**
 * Publisher-vs-viewer clock divergence, estimated from the per-tick latency
 * floor. The floor's slope over minutes is the drift; the distance of the fitted
 * floor from where it stood when correction began is what a latency series
 * subtracts. The constant offset is not observable from one-way delay and stays.
 *
 * A recovery transient (stall, re-anchor, hidden tab, startup) also moves the
 * floor, so samples right after one are skipped, the fit is median-of-slopes
 * over per-bucket minima, a slope applies only when both halves of the window
 * show it, and one too steep for a real clock only once it spans the window.
 */

export interface ClockDriftOptions {
  /** Samples older than this are dropped. Default 10 min. */
  readonly windowMs?: number;
  /** Span of clean samples before any correction. Default 5 min. */
  readonly minSpanMs?: number;
  /** Samples skipped after startup or a disturbance. Default 10 s. */
  readonly settleMs?: number;
  /** Per-bucket minimum taken over this period. Default 10 s. */
  readonly bucketMs?: number;
  /** Steeper slopes apply only once they span the full window. Default 5 ms/min. */
  readonly maxTrustedMsPerMin?: number;
}

export interface ClockDrift {
  readonly msPerMin: number;
  /** Subtracted from latency samples; 0 when the slope is not applied. */
  readonly correctionMs: number;
  readonly applied: boolean;
}

export class ClockDriftEstimator {
  private readonly windowMs: number;
  private readonly minSpanMs: number;
  private readonly settleMs: number;
  private readonly bucketMs: number;
  private readonly maxTrustedMsPerMin: number;
  private readonly samples: Array<[number, number]> = [];
  private settleUntilMs: number | null = null;
  /** Fitted floor when correction first applied: the level corrections return to. */
  private refFloorMs: number | null = null;
  /** Held while the window refills after a gap. */
  private last: ClockDrift | null = null;

  constructor(options: ClockDriftOptions = {}) {
    this.windowMs = options.windowMs ?? 10 * 60_000;
    this.minSpanMs = options.minSpanMs ?? 5 * 60_000;
    this.settleMs = options.settleMs ?? 10_000;
    this.bucketMs = options.bucketMs ?? 10_000;
    this.maxTrustedMsPerMin = options.maxTrustedMsPerMin ?? 5;
  }

  /** A stall, sync re-anchor or return to visibility: the floor is not settled. */
  disturb(atMs: number): void {
    this.settleUntilMs = Math.max(this.settleUntilMs ?? -Infinity, atMs + this.settleMs);
  }

  addSample(atMs: number, floorMs: number): void {
    if (!Number.isFinite(floorMs)) return;
    this.settleUntilMs ??= atMs + this.settleMs;
    if (atMs < this.settleUntilMs) return;
    this.samples.push([atMs, floorMs]);
    while (atMs - this.samples[0]![0] > this.windowMs) this.samples.shift();
  }

  estimate(atMs: number): ClockDrift | null {
    const n = this.samples.length;
    if (n < 2) return this.last;
    const t0 = this.samples[0]![0];
    const span = this.samples[n - 1]![0] - t0;
    if (span < this.minSpanMs) return this.last;

    const points = this.bucketMinima(t0);
    if (points.length < 6) return this.last;
    const slope = theilSen(points);
    const intercept = median(points.map(([x, y]) => y - slope * x));
    const msPerMin = slope * 60_000;
    // A settled transient leaves one half flat; a real clock keeps its slope in both.
    const mid = points.length >> 1;
    const steady = [points.slice(0, mid), points.slice(mid)].every((half) => {
      const s = theilSen(half) * 60_000;
      return Math.abs(msPerMin) < NEGLIGIBLE_MS_PER_MIN
        || (Math.sign(s) === Math.sign(msPerMin) && Math.abs(s) >= Math.abs(msPerMin) / 2);
    });
    const trusted = steady && (Math.abs(msPerMin) <= this.maxTrustedMsPerMin
      || span >= this.windowMs - this.bucketMs);
    if (!trusted) {
      this.last = { msPerMin, correctionMs: 0, applied: false };
      return this.last;
    }
    const fittedMs = intercept + slope * (atMs - t0);
    this.refFloorMs ??= fittedMs;
    this.last = { msPerMin, correctionMs: fittedMs - this.refFloorMs, applied: true };
    return this.last;
  }

  /** [ms since t0, minimum floor] per bucket. */
  private bucketMinima(t0: number): Array<[number, number]> {
    const buckets = new Map<number, [number, number]>();
    for (const [t, y] of this.samples) {
      const k = Math.floor((t - t0) / this.bucketMs);
      const cur = buckets.get(k);
      if (!cur || y < cur[1]) buckets.set(k, [t - t0, y]);
    }
    return [...buckets.values()];
  }
}

/** Below this the correction is noise either way. */
const NEGLIGIBLE_MS_PER_MIN = 0.5;

/** Median of pairwise slopes. */
function theilSen(points: Array<[number, number]>): number {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      slopes.push((points[j]![1] - points[i]![1]) / (points[j]![0] - points[i]![0]));
    }
  }
  return median(slopes);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
