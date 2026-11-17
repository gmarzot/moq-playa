import type { PlaybackSample } from '../player-acceptance/assessment.mjs';

export interface Interval { startMs: number; durationMs: number; open?: boolean }
export interface LatencySecond { n: number; min: number; p50: number; p95: number; max: number }
export interface SoakTick {
  wallEpochMs: number;
  state?: string;
  stats?: Record<string, unknown> | null;
  latency?: Record<string, LatencySecond>;
  events?: { timeMs: number; type: string; data: unknown }[];
}
export interface LatencyKeyReport {
  perMinute: { minute: number; n: number; p50: number | null; p95: number | null; max: number }[];
  p50: number | null; p95: number | null; max: number | null; driftMs: number;
}

export interface Disruption { kind: string; method?: string; startEpochMs: number; endEpochMs: number; plannedMs?: number }
export interface Recovery {
  kind: string;
  method?: string;
  startEpochMs: number;
  durationMs: number;
  freshFrameAfterMs: number | null;
  outageMs: number | null;
  stableLatencyAfterMs: number | null;
  baselineLatencyMs: number | null;
}

export interface AbrSwitch {
  direction: 'down' | 'up';
  to: string;
  /** What triggered it: lag, link, probe, buffer, decode, stall or other. */
  kind: string;
  reason: string | null;
}
export interface AbrReport {
  timeline: { atS: number; kbps: number; height: number | null }[];
  timeAtLevelS: { kbps: number; height: number | null; seconds: number }[];
  downshifts: number;
  upshifts: number;
  firstDownshiftS: number | null;
  logged: { downshifts: number; upshifts: number; reasons: Record<string, number>; switches: (AbrSwitch & { atS: number })[] };
}

export function abrSwitch(text: string): AbrSwitch | null;
export function abrReport(ticks: SoakTick[], log?: { t: number; text: string }[], startEpochMs?: number): AbrReport;
export function quietIntervals(samples: PlaybackSample[], active: (s: PlaybackSample) => boolean, minMs: number): Interval[];
export function latencyReport(ticks: SoakTick[]): Record<string, LatencyKeyReport>;
export function recoveryReport(samples: PlaybackSample[], ticks: SoakTick[], disruptions: Disruption[], frozen: Interval[]): Recovery[];
export function assessSoak(input: {
  samples: PlaybackSample[];
  ticks: SoakTick[];
  expected?: { videoWidth?: number; videoHeight?: number; videoFps?: number };
  startup?: Record<string, unknown>;
  disruptions?: Disruption[];
  adverse?: boolean;
  /** Player console lines; adds `abr`. */
  abrLog?: { t: number; text: string }[] | null;
}): {
  verdict: 'played' | 'no-playback' | 'no-audio' | 'unrecovered';
  audio: { advertised: boolean; audible: boolean };
  durationS: number;
  samples: number;
  startup: Record<string, unknown> & { breakdownMs?: Record<string, number | null> };
  recovery: {
    events: Recovery[];
    unrecovered: number;
    /** How long the picture has been frozen at the end, when 15 s or more. */
    endedFrozenMs: number | null;
    unsettled: number;
    freshFrameAfterMsMax: number | null;
    stableLatencyAfterMsMax: number | null;
  };
  playback: {
    stalls: { count: number; totalMs: number; longestMs: number };
    rebufferRatio: number | null;
    frozen: { count: number; totalMs: number; longestMs: number };
    audioGaps: { count: number; totalMs: number; longestMs: number; p99Ms: number | null };
    fps: { mean: number; minPerMinute: number | null; expected: number | null };
    resolution: { width: number; height: number } | null;
    resolutionMatches: boolean | null;
  };
  latency: Record<string, LatencyKeyReport>;
  abr?: AbrReport;
  player: Record<string, unknown>;
  events: Record<string, number>;
};
