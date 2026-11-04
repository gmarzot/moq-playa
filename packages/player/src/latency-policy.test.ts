/**
 * LatencyPolicy — live holds the delay; smooth raises it on late arrivals and
 * steps it down after clean windows, never below the spare slack or the base.
 */

import { describe, it, expect } from 'vitest';
import { LatencyPolicy, SMOOTH_MARGIN_US, SMOOTH_CLEAN_WINDOW_US } from './latency-policy.js';

function makeClock() {
  let now = 0;
  return { now: () => now, advance: (us: number) => { now += us; } };
}

describe('LatencyPolicy', () => {
  it('live mode never moves the delay', () => {
    const clock = makeClock();
    const p = new LatencyPolicy({ mode: 'live', baseUs: 200_000 }, clock);
    expect(p.noteArrival(-400_000, 200_000)).toBeNull();
    clock.advance(SMOOTH_CLEAN_WINDOW_US * 2);
    expect(p.noteArrival(500_000, 200_000)).toBeNull();
    expect(p.heldUs).toBe(200_000);
    expect(p.stats).toMatchObject({ mode: 'live', raises: 0, lowers: 0 });
  });

  it('smooth: a late arrival raises the delay by its lateness plus the margin, capped at the ceiling', () => {
    const p = new LatencyPolicy({ mode: 'smooth', baseUs: 200_000, ceilingUs: 1_000_000 }, makeClock());
    expect(p.noteArrival(-300_000, 200_000)).toBe(200_000 + 300_000 + SMOOTH_MARGIN_US);
    // Late against a lower delay than the one held: already covered.
    expect(p.noteArrival(-10_000, 300_000)).toBeNull();
    expect(p.noteArrival(-900_000, 550_000)).toBe(1_000_000);
    expect(p.stats).toMatchObject({ heldMs: 1000, ceilingMs: 1000, raises: 2 });
  });

  it('smooth: after a clean window the delay steps down by the spare slack, at most half the excess', () => {
    const clock = makeClock();
    const p = new LatencyPolicy({ mode: 'smooth', baseUs: 200_000 }, clock);
    p.noteArrival(-750_000, 200_000);                       // held 1000 ms
    clock.advance(1_000_000);
    expect(p.noteArrival(600_000, 1_000_000)).toBeNull();   // window still running
    clock.advance(SMOOTH_CLEAN_WINDOW_US);
    // 550 ms spare after the margin; half the 800 ms excess is less.
    expect(p.noteArrival(700_000, 1_000_000)).toBe(600_000);
    clock.advance(1_000_000);
    p.noteArrival(120_000, 600_000);
    clock.advance(SMOOTH_CLEAN_WINDOW_US);
    // Only 70 ms spare in this window: the step is that, not half the excess.
    expect(p.noteArrival(400_000, 600_000)).toBe(530_000);
    expect(p.stats).toMatchObject({ raises: 1, lowers: 2 });
  });

  it('smooth: a late arrival restarts the clean window', () => {
    const clock = makeClock();
    const p = new LatencyPolicy({ mode: 'smooth', baseUs: 200_000 }, clock);
    p.noteArrival(-300_000, 200_000);                       // held 550 ms
    clock.advance(SMOOTH_CLEAN_WINDOW_US - 1_000_000);
    p.noteArrival(400_000, 550_000);
    expect(p.noteArrival(-10_000, 550_000)).toBe(610_000);
    clock.advance(2_000_000);
    expect(p.noteArrival(400_000, 610_000)).toBeNull();
    expect(p.heldUs).toBe(610_000);
  });

  it('smooth: steps down to the base and no further; a new base keeps a held delay above it', () => {
    const clock = makeClock();
    const p = new LatencyPolicy({ mode: 'smooth', baseUs: 200_000 }, clock);
    p.noteArrival(-1_000, 200_000);
    for (let i = 0; i < 20; i++) {
      clock.advance(SMOOTH_CLEAN_WINDOW_US);
      p.noteArrival(1_000_000, p.heldUs);
    }
    expect(p.heldUs).toBe(200_000);
    p.noteArrival(-500_000, 200_000);                       // held 750 ms
    p.setBase(300_000);
    expect(p.heldUs).toBe(750_000);
    p.setBase(900_000);
    expect(p.heldUs).toBe(900_000);
  });

  it('smooth: before any raise the held delay follows the base, down as well as up', () => {
    const p = new LatencyPolicy({ mode: 'smooth', baseUs: 2_000_000 }, makeClock());
    p.setBase(200_000);                                     // the catalog target replaces a default
    expect(p.heldUs).toBe(200_000);
    expect(p.noteArrival(-100_000, 200_000)).toBe(350_000);
  });
});
