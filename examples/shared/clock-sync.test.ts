import { describe, it, expect, vi } from 'vitest';
import { measureClockOffset, offsetFromSamples, parseServerTime } from './clock-sync.js';

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
});
