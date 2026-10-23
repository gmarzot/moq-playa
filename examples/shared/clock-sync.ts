/**
 * This browser's clock against a reference server's, NTP over HTTPS: the
 * offset to add to Date.now(), from the fastest of a few round trips. The
 * path is taken as symmetric, so the error is at most half that round trip.
 *
 * @module
 */

export interface ClockOffset {
  /** Add to Date.now() to read the reference clock (ms). */
  readonly offsetMs: number;
  /** Round trip of the sample used (ms); the error is at most half of it. */
  readonly rttMs: number;
}

export interface ClockSample {
  readonly sentMs: number;
  readonly serverMs: number;
  readonly receivedMs: number;
}

/** The offset from the sample with the shortest round trip; null without one. */
export function offsetFromSamples(samples: readonly ClockSample[]): ClockOffset | null {
  let best: ClockSample | null = null;
  for (const s of samples) {
    if (s.receivedMs < s.sentMs) continue;
    if (best === null || s.receivedMs - s.sentMs < best.receivedMs - best.sentMs) best = s;
  }
  if (best === null) return null;
  return {
    offsetMs: best.serverMs - (best.sentMs + best.receivedMs) / 2,
    rttMs: best.receivedMs - best.sentMs,
  };
}

/** A `/time` body: seconds since the epoch with a fraction (nginx `$msec`), as ms. */
export function parseServerTime(body: string): number | null {
  const s = Number(body.trim());
  return Number.isFinite(s) && s > 1e9 ? s * 1000 : null;
}

/** Measure against `url`; null when no sample succeeds. */
export async function measureClockOffset(url: string, opts: {
  samples?: number;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
} = {}): Promise<ClockOffset | null> {
  const doFetch = opts.fetch ?? ((u, i) => fetch(u, i));
  const now = opts.now ?? Date.now;
  const samples: ClockSample[] = [];
  for (let i = 0; i < (opts.samples ?? 5); i++) {
    try {
      const sentMs = now();
      const res = await doFetch(url, { cache: 'no-store' });
      const receivedMs = now();
      if (!res.ok) continue;
      const serverMs = parseServerTime(await res.text());
      if (serverMs !== null) samples.push({ sentMs, serverMs, receivedMs });
    } catch { /* a failed sample is skipped */ }
  }
  return offsetFromSamples(samples);
}
