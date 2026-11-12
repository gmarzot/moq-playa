/**
 * LatencyPolicy — live holds the delay; smooth starts at its floor, raises it
 * on late arrivals and steps it down after clean windows, never below the
 * spare slack or the floor.
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

  it('smooth: a configured ceiling below a default base applies once the real base arrives', () => {
    const p = new LatencyPolicy({ mode: 'smooth', baseUs: 2_000_000, ceilingUs: 500_000 }, makeClock());
    expect(p.ceilingUs).toBe(2_000_000);
    p.setBase(200_000);
    expect(p.ceilingUs).toBe(500_000);
    expect(p.noteArrival(-900_000, 200_000)).toBe(500_000);
  });

  it('smooth: lateness in the startup grace is ignored (a join backlog), then raises as usual', () => {
    const clock = makeClock();
    const p = new LatencyPolicy({ mode: 'smooth', baseUs: 200_000, startupGraceUs: 3_000_000 }, clock);
    expect(p.armed).toBe(false);
    expect(p.noteArrival(-1_500_000, 200_000)).toBeNull();
    clock.advance(2_000_000);
    expect(p.noteArrival(-500_000, 200_000)).toBeNull();
    expect(p.armed).toBe(false);
    clock.advance(1_000_000);
    expect(p.armed).toBe(true);
    expect(p.noteArrival(-300_000, 200_000)).toBe(200_000 + 300_000 + SMOOTH_MARGIN_US);
  });

  it('smooth: before any raise the held delay follows the base, down as well as up', () => {
    const p = new LatencyPolicy({ mode: 'smooth', baseUs: 2_000_000 }, makeClock());
    p.setBase(200_000);                                     // the catalog target replaces a default
    expect(p.heldUs).toBe(200_000);
    expect(p.noteArrival(-100_000, 200_000)).toBe(350_000);
  });

  it('smooth: starts at the floor, raises above it, and steps back down to it and no further', () => {
    const clock = makeClock();
    const p = new LatencyPolicy({ mode: 'smooth', baseUs: 200_000, floorUs: 1_000_000 }, clock);
    expect(p.heldUs).toBe(1_000_000);
    expect(p.stats).toMatchObject({ heldMs: 1000, floorMs: 1000, ceilingMs: 2000 });
    // Late against the floor: raised from it, not from the base.
    expect(p.noteArrival(-300_000, 1_000_000)).toBe(1_350_000);
    for (let i = 0; i < 20; i++) {
      clock.advance(SMOOTH_CLEAN_WINDOW_US);
      p.noteArrival(1_000_000, p.heldUs);
    }
    expect(p.heldUs).toBe(1_000_000);
    expect(p.lowers).toBeGreaterThan(0);
  });

  it('smooth: the floor yields to a higher base and to the ceiling; live ignores it', () => {
    const p = new LatencyPolicy({ mode: 'smooth', baseUs: 200_000, floorUs: 1_000_000, ceilingUs: 500_000 }, makeClock());
    expect(p.floorUs).toBe(500_000);
    expect(p.heldUs).toBe(500_000);
    p.setBase(1_500_000);
    expect(p.floorUs).toBe(1_500_000);
    expect(p.heldUs).toBe(1_500_000);
    const live = new LatencyPolicy({ mode: 'live', baseUs: 200_000, floorUs: 1_000_000 }, makeClock());
    expect(live.heldUs).toBe(200_000);
    expect(live.stats.floorMs).toBe(200);
  });

  it('setBounds re-bounds the held delay: a lower ceiling clamps it, a higher floor lifts it', () => {
    const p = new LatencyPolicy({ mode: 'smooth', baseUs: 200_000, ceilingUs: 2_000_000, floorUs: 500_000 }, makeClock());
    p.noteArrival(-1_000_000, 500_000);                     // held 1550 ms
    expect(p.heldUs).toBe(1_550_000);
    p.setBounds({ floorUs: 500_000, ceilingUs: 1_000_000 });
    expect(p.heldUs).toBe(1_000_000);
    // A higher ceiling does not restore the clamped raise.
    p.setBounds({ floorUs: 500_000, ceilingUs: 2_000_000 });
    expect(p.heldUs).toBe(1_000_000);
    p.setBounds({ floorUs: 1_200_000, ceilingUs: 2_000_000 });
    expect(p.heldUs).toBe(1_200_000);
    expect(p.stats).toMatchObject({ floorMs: 1200, ceilingMs: 2000 });
  });
});
