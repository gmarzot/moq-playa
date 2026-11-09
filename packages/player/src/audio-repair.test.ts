import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioRepair, type AudioRepairRange } from './audio-repair.js';

function setup(overrides: Partial<ConstructorParameters<typeof AudioRepair>[0]> = {}) {
  const ranges: AudioRepairRange[] = [];
  const cancelled: bigint[] = [];
  let id = 0n;
  const onGiveUp = vi.fn();
  const repair = new AudioRepair({
    fetch: (r) => { ranges.push(r); return Promise.resolve(++id); },
    cancel: (i) => { cancelled.push(i); },
    onGiveUp,
    ...overrides,
  });
  return { repair, ranges, cancelled, onGiveUp };
}

const whole = (startGroup: bigint, endGroup: bigint): AudioRepairRange =>
  ({ startGroup, startObject: 0n, endGroup, endObject: 0n });

describe('AudioRepair', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('asks for nothing while datagrams are contiguous', () => {
    const { repair, ranges } = setup();
    for (let g = 10n; g < 20n; g++) repair.note(g, 0n);
    vi.advanceTimersByTime(1000);
    expect(ranges).toEqual([]);
    expect(repair.stats.gaps).toBe(0);
  });

  it('fetches a lost group after the grace and cancels the filled request', async () => {
    const { repair, ranges, cancelled } = setup();
    repair.note(10n, 0n);
    repair.note(12n, 0n);
    expect(ranges).toEqual([]);
    await vi.advanceTimersByTimeAsync(30);
    expect(ranges).toEqual([whole(11n, 11n)]);
    repair.noteFetched(11n, 0n);
    expect(repair.stats).toEqual({ gaps: 1, filled: 1, failed: 0, active: true });
    expect(cancelled).toEqual([1n]);
  });

  it('does not fetch a datagram that was only reordered', async () => {
    const { repair, ranges } = setup();
    repair.note(10n, 0n);
    repair.note(12n, 0n);
    repair.note(11n, 0n);
    await vi.advanceTimersByTimeAsync(100);
    expect(ranges).toEqual([]);
  });

  it('covers a burst with one range', async () => {
    const { repair, ranges } = setup();
    repair.note(10n, 0n);
    repair.note(14n, 0n);
    await vi.advanceTimersByTimeAsync(30);
    expect(ranges).toEqual([whole(11n, 13n)]);
  });

  it('asks for objects missing inside a group', async () => {
    const { repair, ranges } = setup();
    repair.note(10n, 2n);
    repair.note(10n, 5n);
    await vi.advanceTimersByTimeAsync(30);
    expect(ranges).toEqual([{ startGroup: 10n, startObject: 3n, endGroup: 10n, endObject: 5n }]);
  });

  it('treats a very large jump as a discontinuity', async () => {
    const { repair, ranges } = setup();
    repair.note(10n, 0n);
    repair.note(1000n, 0n);
    await vi.advanceTimersByTimeAsync(100);
    expect(ranges).toEqual([]);
    expect(repair.stats.gaps).toBe(0);
  });

  it('counts a gap failed at the deadline and closes its request', async () => {
    const { repair, cancelled } = setup({ deadlineMs: 100 });
    repair.note(10n, 0n);
    repair.note(12n, 0n);
    await vi.advanceTimersByTimeAsync(130);
    expect(repair.stats.failed).toBe(1);
    expect(cancelled).toEqual([1n]);
  });

  it('counts a refused FETCH as failed', async () => {
    const { repair } = setup({ fetch: () => Promise.reject(new Error('refused')) });
    repair.note(10n, 0n);
    repair.note(12n, 0n);
    await vi.advanceTimersByTimeAsync(30);
    expect(repair.stats.failed).toBe(1);
  });

  it('caps the requests in flight without counting that against the relay', async () => {
    const { repair, ranges, onGiveUp } = setup({ maxInFlight: 1, giveUpAfter: 1, deadlineMs: 1000 });
    repair.note(10n, 0n);
    repair.note(12n, 0n);
    repair.note(14n, 0n);
    await vi.advanceTimersByTimeAsync(30);
    expect(ranges).toEqual([whole(11n, 11n)]);
    expect(repair.stats.failed).toBe(1);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('pauses after repeated failures, then resumes', async () => {
    const { repair, ranges, onGiveUp } = setup({ giveUpAfter: 2, deadlineMs: 50, pauseMs: 1000 });
    for (const g of [10n, 12n]) repair.note(g, 0n);
    await vi.advanceTimersByTimeAsync(100);
    for (const g of [14n]) repair.note(g, 0n);
    await vi.advanceTimersByTimeAsync(100);
    expect(onGiveUp).toHaveBeenCalledOnce();
    expect(repair.stats.active).toBe(false);
    const sent = ranges.length;
    repair.note(16n, 0n);
    await vi.advanceTimersByTimeAsync(100);
    expect(ranges.length).toBe(sent);
    await vi.advanceTimersByTimeAsync(1000);
    expect(repair.stats.active).toBe(true);
    repair.note(100n, 0n);
    repair.note(102n, 0n);
    await vi.advanceTimersByTimeAsync(30);
    expect(ranges.length).toBe(sent + 1);
  });

  it('a fill clears the failure streak', async () => {
    const { repair, onGiveUp } = setup({ giveUpAfter: 2, deadlineMs: 50 });
    repair.note(10n, 0n);
    repair.note(12n, 0n);
    await vi.advanceTimersByTimeAsync(100);
    repair.note(14n, 0n);
    await vi.advanceTimersByTimeAsync(30);
    repair.noteFetched(13n, 0n);
    repair.note(16n, 0n);
    await vi.advanceTimersByTimeAsync(100);
    expect(onGiveUp).not.toHaveBeenCalled();
  });

  it('closes a request that was still being opened when its gap ended', async () => {
    let resolve!: (id: bigint) => void;
    const { repair, cancelled } = setup({ fetch: () => new Promise((r) => { resolve = r; }), deadlineMs: 50 });
    repair.note(10n, 0n);
    repair.note(12n, 0n);
    await vi.advanceTimersByTimeAsync(100);
    expect(cancelled).toEqual([]);
    resolve(7n);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toEqual([7n]);
  });

  it('forgets open gaps and position on reset', async () => {
    const { repair, ranges } = setup();
    repair.note(10n, 0n);
    repair.note(12n, 0n);
    repair.reset();
    await vi.advanceTimersByTimeAsync(100);
    expect(ranges).toEqual([]);
    repair.note(500n, 0n);
    await vi.advanceTimersByTimeAsync(100);
    expect(ranges).toEqual([]);
  });
});
