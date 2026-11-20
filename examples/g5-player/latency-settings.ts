/**
 * The page's latency settings: one target (the catalog's unless typed) and a
 * posture carried by the congestion-control choice. Low latency holds the
 * target; Browser default and Smooth let the playout buffer grow from the
 * target up to SMOOTH_CEILING_MS, Smooth also sending the `throughput` hint.
 */

export type CongestionControl = 'low-latency' | 'throughput';

/** The adaptive postures' expansion bound: the most late media may raise the playout buffer to (ms). */
export const SMOOTH_CEILING_MS = 3000;

export interface LatencySettings {
  /** Typed target (ms); undefined follows the catalog. */
  readonly targetLatencyMs: number | undefined;
  /** Undefined leaves the browser default. */
  readonly congestionControl: CongestionControl | undefined;
}

/** What the player is given. */
export interface PlaybackLatency {
  readonly latencyMode: 'live' | 'smooth';
  readonly targetLatencyMs: number | undefined;
  readonly smoothFloorMs: number | undefined;
  readonly smoothCeilingMs: number | undefined;
}

const positiveMs = (raw: string | null): number | undefined => {
  if (raw === null || raw.trim() === '') return undefined;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : undefined;
};

/** `targetLatency=MS` (absent or invalid: Catalog) and `congestionControl=low-latency|throughput`. */
export function parseLatencySettings(p: URLSearchParams): LatencySettings {
  const cc = p.get('congestionControl');
  return {
    targetLatencyMs: positiveMs(p.get('targetLatency')),
    congestionControl: cc === 'low-latency' || cc === 'throughput' ? cc : undefined,
  };
}

/** Retired params, rewritten once at load. */
const RETIRED = ['latency', 'latencyMin', 'latencyMax'] as const;

/**
 * `latency=smooth&latencyMin=X` → `targetLatency=X`, X being where the delay started;
 * `latency`, `latencyMax` and the rest are dropped. `congestionControl` keeps the posture.
 * Returns the rewritten query, or null when it has no retired param.
 */
export function migrateLatencyQuery(p: URLSearchParams): URLSearchParams | null {
  if (!RETIRED.some((k) => p.has(k))) return null;
  const next = new URLSearchParams(p);
  for (const k of RETIRED) next.delete(k);
  const min = positiveMs(p.get('latencyMin'));
  if (p.get('latency') === 'smooth' && min !== undefined) next.set('targetLatency', String(min));
  return next;
}

/**
 * The player's latency options. The adaptive floor is the typed target, else the
 * catalog's; with neither it is 0, so the buffer starts at the live hold and only
 * late media raises it.
 */
export function playbackLatency(s: LatencySettings, catalogTargetMs?: number): PlaybackLatency {
  if (s.congestionControl === 'low-latency') {
    return { latencyMode: 'live', targetLatencyMs: s.targetLatencyMs, smoothFloorMs: undefined, smoothCeilingMs: undefined };
  }
  const floor = s.targetLatencyMs ?? (catalogTargetMs !== undefined && catalogTargetMs > 0 ? catalogTargetMs : 0);
  return {
    latencyMode: 'smooth',
    targetLatencyMs: s.targetLatencyMs,
    smoothFloorMs: floor,
    // The engine rejects a ceiling below the floor.
    smoothCeilingMs: Math.max(SMOOTH_CEILING_MS, floor),
  };
}

export function postureLabel(cc: CongestionControl | undefined): string {
  return cc === 'throughput' ? 'Smooth' : cc === 'low-latency' ? 'Low latency' : 'Browser default';
}

/** "target 205 ms (catalog)", "target 500 ms", or "target default" when neither sets one. */
export function targetText(typedMs: number | undefined, catalogMs: number | undefined): string {
  if (typedMs !== undefined) return `target ${typedMs} ms`;
  if (catalogMs !== undefined && catalogMs > 0) return `target ${catalogMs} ms (catalog)`;
  return 'target default';
}

/** "1.0 s · target 205 ms (catalog)"; "—" while latency is not measurable. */
export function latencyReadout(measuredMs: number | null, target: string): string {
  const shown = measuredMs === null || !Number.isFinite(measuredMs) ? '—' : `${(measuredMs / 1000).toFixed(1)} s`;
  return `${shown} · ${target}`;
}

/** LIVE while the catalog says live; ENDED once it stops; VOD when it never was. */
export type LiveState = 'live' | 'ended' | 'vod';

/** The media tracks' `isLive`: true if any is live; undefined when none carries the flag. */
export function catalogIsLive(tracks: readonly unknown[]): boolean | undefined {
  const flags: boolean[] = [];
  for (const t of tracks) {
    if (typeof t !== 'object' || t === null) continue;
    const track = t as { role?: unknown; name?: unknown; codec?: unknown; isLive?: unknown };
    const role = track.role ?? track.name;
    const media = role === 'video' || role === 'audio' || typeof track.codec === 'string';
    if (media && typeof track.isLive === 'boolean') flags.push(track.isLive);
  }
  return flags.length ? flags.includes(true) : undefined;
}

/** The indicator after a catalog; `prev` is null before the first. */
export function nextLiveState(prev: LiveState | null, isLive: boolean | undefined): LiveState {
  // Missing isLive reads as live: MSF requires the flag, and a relayed broadcast is live.
  if (isLive ?? true) return 'live';
  return prev === 'live' || prev === 'ended' ? 'ended' : 'vod';
}
