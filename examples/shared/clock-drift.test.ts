import { describe, it, expect } from 'vitest';
import { ClockDriftEstimator } from './clock-drift.js';

const MIN = 60_000;

/** One sample per second from `fromMs` to `toMs`, floor from `floorAt`, plus ±3 ms jitter. */
function feed(est: ClockDriftEstimator, fromMs: number, toMs: number, floorAt: (t: number) => number): void {
  for (let t = fromMs; t <= toMs; t += 1000) {
    est.addSample(t, floorAt(t) + ((t / 1000) % 7) - 3);
  }
}

describe('ClockDriftEstimator', () => {
  it('applies nothing before 5 minutes of clean samples', () => {
    const est = new ClockDriftEstimator();
    feed(est, 0, 4 * MIN, (t) => 70 + (2 * t) / MIN);
    expect(est.estimate(4 * MIN)).toBeNull();
  });

  it('a steady floor gives no drift', () => {
    const est = new ClockDriftEstimator();
    feed(est, 0, 8 * MIN, () => 70);
    const d = est.estimate(8 * MIN)!;
    expect(Math.abs(d.msPerMin)).toBeLessThan(0.5);
    expect(Math.abs(d.correctionMs)).toBeLessThan(3);
  });

  it('a real 2 ms/min divergence is measured and removed', () => {
    const est = new ClockDriftEstimator();
    const floor = (t: number) => 70 + (2 * t) / MIN;
    feed(est, 0, 6 * MIN, floor);
    const first = est.estimate(6 * MIN)!;
    expect(first.applied).toBe(true);
    expect(first.msPerMin).toBeCloseTo(2, 0);
    feed(est, 6 * MIN + 1000, 9 * MIN, floor);
    const later = est.estimate(9 * MIN)!;
    // Three more minutes at 2 ms/min.
    expect(later.correctionMs - first.correctionMs).toBeCloseTo(6, 0);
  });

  it('a startup recovery transient is not taken for drift', () => {
    const est = new ClockDriftEstimator();
    // Floor falls from 300 to 70 over the first two minutes, then holds.
    const floor = (t: number) => (t < 2 * MIN ? 300 - (230 * t) / (2 * MIN) : 70);
    est.disturb(30_000);
    est.disturb(60_000);
    feed(est, 0, 7 * MIN, floor);
    est.estimate(7 * MIN);
    feed(est, 7 * MIN + 1000, 9 * MIN, floor);
    const d = est.estimate(9 * MIN)!;
    expect(Math.abs(d.msPerMin)).toBeLessThan(0.5);
    expect(Math.abs(d.correctionMs)).toBeLessThan(3);
  });

  it('a long settling decline with no disturbance marked is not applied', () => {
    const est = new ClockDriftEstimator();
    // Falls for three minutes, then flat: the second half of the window disagrees.
    const floor = (t: number) => (t < 3 * MIN ? 300 - (230 * t) / (3 * MIN) : 70);
    feed(est, 0, 6 * MIN, floor);
    const d = est.estimate(6 * MIN)!;
    expect(d.msPerMin).toBeLessThan(-5);
    expect(d.applied).toBe(false);
    expect(d.correctionMs).toBe(0);
  });

  it('the same transient has aged out of a 10-minute window later', () => {
    const est = new ClockDriftEstimator();
    const floor = (t: number) => (t < 2 * MIN ? 300 - (230 * t) / (2 * MIN) : 70);
    feed(est, 0, 14 * MIN, floor);
    const d = est.estimate(14 * MIN)!;
    expect(Math.abs(d.msPerMin)).toBeLessThan(0.5);
    expect(Math.abs(d.correctionMs)).toBeLessThan(3);
  });

  it('a steep slope applies only once it spans the window', () => {
    const est = new ClockDriftEstimator();
    const floor = (t: number) => 100 - (39 * t) / MIN;
    feed(est, 0, 6 * MIN, floor);
    const early = est.estimate(6 * MIN)!;
    expect(early.msPerMin).toBeCloseTo(-39, 0);
    expect(early.applied).toBe(false);
    expect(early.correctionMs).toBe(0);
    feed(est, 6 * MIN + 1000, 10 * MIN, floor);
    expect(est.estimate(10 * MIN)!.applied).toBe(true);
  });

  it('skips samples for 10 s after a disturbance', () => {
    const est = new ClockDriftEstimator();
    feed(est, 0, 6 * MIN, () => 70);
    est.disturb(6 * MIN);
    // A spike the settle window must hide.
    feed(est, 6 * MIN + 1000, 6 * MIN + 9000, () => 5_000);
    feed(est, 6 * MIN + 10_000, 7 * MIN, () => 70);
    const d = est.estimate(7 * MIN)!;
    expect(Math.abs(d.msPerMin)).toBeLessThan(0.5);
  });
});
