import { describe, it, expect, vi } from 'vitest';
import {
  ClockReference, describeClockOffset, measureClockOffset, offsetFromSamples, pageTimerLagMs, parseServerTime, wallMsAt,
} from './clock-sync.js';
import type { ClockOffset } from './clock-sync.js';

describe('clock-sync', () => {
  it('takes the offset from the fastest round trip', () => {
    // Local clock 435 ms behind the server; the 20 ms trip wins over the 300 ms one.
    expect(offsetFromSamples([
      { sentMs: 1000, serverMs: 1000 + 435 + 150, receivedMs: 1300 },
      { sentMs: 2000, serverMs: 2000 + 435 + 10, receivedMs: 2020 },
    ])).toEqual({ offsetMs: 435, rttMs: 20 });
    expect(offsetFromSamples([])).toBeNull();
  });

  it('parses nginx $msec and rejects anything else', () => {
    expect(parseServerTime('1792769703.965\n')).toBe(1792769703965);
    expect(parseServerTime('<html>404</html>')).toBeNull();
    expect(parseServerTime('12')).toBeNull();
  });

  it('measures over fetch, skipping failed and non-ok samples', async () => {
    let t = 1_792_769_000_000;
    const now = () => t;
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response('nope', { status: 404 }))
      .mockImplementation(async () => {
        t += 10; const server = (t + 435) / 1000; t += 10;
        return new Response(String(server));
      });
    expect(await measureClockOffset('https://relay.example/time', { samples: 4, fetch, now }))
      .toEqual({ offsetMs: 435, rttMs: 20 });
    expect(await measureClockOffset('https://relay.example/time', {
      samples: 2, fetch: async () => { throw new Error('offline'); }, now,
    })).toBeNull();
  });

  it('keeps its offset until a measurement moves past that measurement\'s error', async () => {
    const answers: Array<ClockOffset | null> = [
      { offsetMs: 294, rttMs: 90 }, { offsetMs: 330, rttMs: 90 }, { offsetMs: 360, rttMs: 20 }, null,
    ];
    const adopted: number[] = [];
    let failed = 0;
    const ref = new ClockReference('https://relay.example/time', {
      measure: async () => answers.shift() ?? null,
      now: () => 1_000,
      onAdopt: (o) => adopted.push(o.offsetMs),
      onFail: () => { failed++; },
    });
    expect(ref.nowMs()).toBe(1_000);
    await ref.calibrate();
    expect(ref.nowMs()).toBe(1_294);
    await ref.calibrate();                 // 36 ms move, within ±45: kept
    expect(ref.offset?.offsetMs).toBe(294);
    await ref.calibrate();                 // 66 ms move, past ±10: adopted
    await ref.calibrate();                 // no answer: the offset stays
    expect(adopted).toEqual([294, 360]);
    expect(failed).toBe(1);
    expect(ref.offset).toEqual({ offsetMs: 360, rttMs: 20 });
  });

  it('joins a calibration already running', async () => {
    const measure = vi.fn(async () => ({ offsetMs: 10, rttMs: 4 }));
    const ref = new ClockReference('https://relay.example/time', { measure });
    await Promise.all([ref.calibrate(), ref.calibrate()]);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(describeClockOffset(ref.offset!, ref.url)).toBe('this machine is 10 ms behind relay.example (±2 ms)');
  });

  it('reads a page-timer timestamp as Date.now() through the clocks paired now', () => {
    // A frame presented 30 ms ago on the page timer.
    expect(wallMsAt(9_970, 10_000, 1_800_000_000_000)).toBe(1_799_999_999_970);
    // timeOrigin + perfMs would be 400 ms early with the page timer that far behind.
    const timeOriginMs = 1_799_999_989_600;
    expect(pageTimerLagMs(timeOriginMs, 10_000, 1_800_000_000_000)).toBe(400);
    expect(wallMsAt(9_970, 10_000, 1_800_000_000_000) - (timeOriginMs + 9_970)).toBe(400);
    expect(pageTimerLagMs(1_800_000_000_100 - 10_000, 10_000, 1_800_000_000_000)).toBe(-100);
  });
});
