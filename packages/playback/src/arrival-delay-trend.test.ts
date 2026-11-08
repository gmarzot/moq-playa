import { describe, it, expect } from 'vitest';
import { ArrivalDelayTrend } from './arrival-delay-trend.js';

const S = 1_000_000;
const STEP = 100_000;

/** Ten objects a second for `seconds`, each captured `delayAt(t)` before it arrives. */
function feed(trend: ArrivalDelayTrend, seconds: number, delayAt: (t: number, i: number) => number, track = 'v', t0 = 0): number {
  let t = t0;
  for (let i = 0; i < seconds * 10; i++, t += STEP) trend.record(track, t, t - delayAt(t, i));
  return t;
}

describe('ArrivalDelayTrend', () => {
  it('reports a steady rise: a backlog', () => {
    const trend = new ArrivalDelayTrend();
    const end = feed(trend, 8, (t) => 200_000 + t * 0.15);
    expect(trend.riseUs(end)).toBe(900_000);
  });

  it('holds at 0 for a flat delay with one late object a second', () => {
    const trend = new ArrivalDelayTrend();
    const end = feed(trend, 8, (_t, i) => 200_000 + (i % 10 === 0 ? 400_000 : 0));
    expect(trend.riseUs(end)).toBe(0);
  });

  it('holds at 0 through one clock step', () => {
    const trend = new ArrivalDelayTrend();
    const end = feed(trend, 8, (t) => (t < 4 * S ? 200_000 : 900_000));
    expect(trend.riseUs(end)).toBe(0);
  });

  it('needs MIN_SPAN_US of samples', () => {
    const trend = new ArrivalDelayTrend();
    const end = feed(trend, 3, (t) => t * 0.5);
    expect(trend.riseUs(end)).toBe(0);
  });

  it('starts afresh on a discontinuity and on another track', () => {
    const trend = new ArrivalDelayTrend();
    let end = feed(trend, 6, (t) => t * 0.2);
    expect(trend.riseUs(end)).toBeGreaterThan(400_000);
    end = feed(trend, 1, () => 60 * S, 'v', end);
    expect(trend.riseUs(end)).toBe(0);

    end = feed(trend, 6, (t) => t * 0.2, 'v', end);
    end = feed(trend, 1, (t) => t * 0.2, 'w', end);
    expect(trend.riseUs(end)).toBe(0);
  });

  it('forgets samples older than the window', () => {
    const trend = new ArrivalDelayTrend();
    let end = feed(trend, 6, (t) => t * 0.2);
    end = feed(trend, 9, () => 1_200_000, 'v', end);
    expect(trend.riseUs(end)).toBe(0);
  });
});
