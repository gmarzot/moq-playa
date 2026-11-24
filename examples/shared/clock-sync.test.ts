import { describe, it, expect, vi } from 'vitest';
import { ClockReference, describeClockOffset, measureClockOffset, offsetFromSamples, parseServerTime } from './clock-sync.js';
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
});
