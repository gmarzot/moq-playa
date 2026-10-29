import { describe, it, expect } from 'vitest';
import {
  FreezeWatch, PLAYHEAD_FROZEN_MS, REORDER_SETTLE_MS, noteSeq, rebaseSeqs, stallsCell,
  type ObjSeq,
} from './counters.js';

/** Feeds `group.0` for each group in order, `stepMs` apart; returns the ids given up as lost. */
function feed(seqs: Record<string, ObjSeq>, t: string, groups: number[], atMs: number, stepMs = 40): number {
  let lost = 0;
  for (const g of groups) {
    lost += noteSeq(seqs, t, BigInt(g), 0n, atMs).lost;
    atMs += stepMs;
  }
  return lost;
}

describe('object continuity', () => {
  it('a group missing inside a session is lost', () => {
    const seqs: Record<string, ObjSeq> = {};
    feed(seqs, 'video', [710, 711, 713], 0);
    const lost = feed(seqs, 'video', [714], REORDER_SETTLE_MS + 500);
    expect(lost).toBe(1);
    expect(seqs['video']!.lost).toBe(1);
  });

  it('a late id filling its hole is a reorder, not loss', () => {
    const seqs: Record<string, ObjSeq> = {};
    feed(seqs, 'video', [710, 712, 711], 0);
    feed(seqs, 'video', [713], REORDER_SETTLE_MS + 500);
    expect(seqs['video']!.reorders).toBe(1);
    expect(seqs['video']!.lost).toBe(0);
  });

  it('groups skipped across a resubscribe are not lost', () => {
    const seqs: Record<string, ObjSeq> = {};
    feed(seqs, 'video', [710, 711, 712], 0);
    rebaseSeqs(seqs, { dropPending: true, track: 'video' });
    feed(seqs, 'video', [717, 718], 10_000);
    feed(seqs, 'video', [719], 10_000 + REORDER_SETTLE_MS + 500);
    expect(seqs['video']!.lost).toBe(0);
  });

  it('a hole still pending at the outage is dropped with it', () => {
    const seqs: Record<string, ObjSeq> = {};
    feed(seqs, 'video', [710, 712], 0);
    rebaseSeqs(seqs, { dropPending: true });
    feed(seqs, 'video', [717], 10_000);
    feed(seqs, 'video', [718], 10_000 + REORDER_SETTLE_MS + 500);
    expect(seqs['video']!.lost).toBe(0);
  });

  it('a pause rebase keeps pending ids: a straggler matches, a missing one is lost', () => {
    const seqs: Record<string, ObjSeq> = {};
    feed(seqs, 'video', [710, 712, 714], 0);   // 711 and 713 pending
    rebaseSeqs(seqs, { dropPending: false });
    feed(seqs, 'video', [720], 500);
    feed(seqs, 'video', [711], 600);           // straggler from before the pause
    feed(seqs, 'video', [721], REORDER_SETTLE_MS + 500);
    expect(seqs['video']!.reorders).toBe(1);
    expect(seqs['video']!.lost).toBe(1);       // 713 never arrived
  });

  it('after the rebase, loss in the new session still counts', () => {
    const seqs: Record<string, ObjSeq> = {};
    feed(seqs, 'video', [710], 0);
    rebaseSeqs(seqs, { dropPending: true });
    feed(seqs, 'video', [717, 719], 10_000);
    feed(seqs, 'video', [720], 10_000 + REORDER_SETTLE_MS + 500);
    expect(seqs['video']!.lost).toBe(1);
  });

  it('a stale id from before the resubscribe does not consume the rebase', () => {
    const seqs: Record<string, ObjSeq> = {};
    feed(seqs, 'audio', [500, 501], 0);
    rebaseSeqs(seqs, { dropPending: true, track: 'audio' });
    feed(seqs, 'audio', [499, 520], 100);
    feed(seqs, 'audio', [521], 100 + REORDER_SETTLE_MS + 500);
    expect(seqs['audio']!.lost).toBe(0);
  });

  it('a rebase of one track leaves the other counting', () => {
    const seqs: Record<string, ObjSeq> = {};
    feed(seqs, 'video', [1], 0);
    feed(seqs, 'audio', [1], 0);
    rebaseSeqs(seqs, { dropPending: true, track: 'video' });
    feed(seqs, 'audio', [3], 100);
    feed(seqs, 'audio', [4], 100 + REORDER_SETTLE_MS + 500);
    expect(seqs['audio']!.lost).toBe(1);
  });
});

describe('stalls cell', () => {
  const base = { stallCount: 1, stallDurationMs: 0, freezes: 0, frozenSec: 0, locPath: false };

  it('includes a stall still in progress and says so', () => {
    const c = stallsCell({ ...base, ongoingStallMs: 3 * 3_600_000 });
    expect(c.sec).toBe(10_800);
    expect(c.faults).toBe(1);
    expect(c.detail).toBe('Stalls: 1 (10800.0 s, ongoing for 10800.0 s) · Freezes: 0 (0.0 s)');
  });

  it('adds completed stalls, the ongoing one and MSE freezes', () => {
    const c = stallsCell({
      ...base, stallCount: 2, stallDurationMs: 4_000, ongoingStallMs: 1_500, freezes: 1, frozenSec: 0.5,
    });
    expect(c.sec).toBe(6);
    expect(c.faults).toBe(3);
  });

  it('leaves MSE freezes out on the LOC path', () => {
    const c = stallsCell({ ...base, stallDurationMs: 2_000, ongoingStallMs: 0, freezes: 4, frozenSec: 9, locPath: true });
    expect(c.sec).toBe(2);
    expect(c.detail).toBe('Stalls: 1 (2.0 s)');
  });
});

describe('FreezeWatch', () => {
  const idle = { ongoingStallMs: 0, playheadSec: null, playbackRate: 1, holeStartSec: null };

  it('reports the engine stall from its onset', () => {
    const w = new FreezeWatch();
    expect(w.update({ ...idle, nowMs: 10_000 })).toBeNull();
    expect(w.update({ ...idle, nowMs: 10_250, ongoingStallMs: 254 })).toBe(9_996);
    expect(w.update({ ...idle, nowMs: 10_500 })).toBeNull();
  });

  it('a playhead that stops moving is frozen from when it last moved', () => {
    const w = new FreezeWatch();
    w.update({ ...idle, nowMs: 0, playheadSec: 10 });
    w.update({ ...idle, nowMs: 250, playheadSec: 10.25 });
    expect(w.update({ ...idle, nowMs: 500, playheadSec: 10.25 })).toBeNull();
    expect(w.update({ ...idle, nowMs: 250 + PLAYHEAD_FROZEN_MS, playheadSec: 10.25 })).toBe(250);
    expect(w.update({ ...idle, nowMs: 1_500, playheadSec: 10.5 })).toBeNull();
  });

  it('a playhead inside a video hole is frozen from the hole start', () => {
    const w = new FreezeWatch();
    w.update({ ...idle, nowMs: 0, playheadSec: 119 });
    expect(w.update({ ...idle, nowMs: 1_000, playheadSec: 120.5, holeStartSec: 119.84 })).toBeCloseTo(340);
  });

  it('an unwatched playhead is never frozen by itself', () => {
    const w = new FreezeWatch();
    for (let t = 0; t <= 5_000; t += 250) expect(w.update({ ...idle, nowMs: t })).toBeNull();
  });
});
