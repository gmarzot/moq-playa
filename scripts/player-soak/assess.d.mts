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
}): {
  verdict: 'played' | 'no-playback' | 'no-audio' | 'unrecovered';
  audio: { advertised: boolean; audible: boolean };
  durationS: number;
  samples: number;
  startup: Record<string, unknown> & { breakdownMs?: Record<string, number | null> };
  recovery: {
    events: Recovery[];
    unrecovered: number;
    unsettled: number;
    freshFrameAfterMsMax: number | null;
    stableLatencyAfterMsMax: number | null;
  };
  playback: {
    stalls: { count: number; totalMs: number; longestMs: number };
    rebufferRatio: number | null;
    frozen: { count: number; totalMs: number; longestMs: number };
    audioGaps: { count: number; totalMs: number; longestMs: number };
    fps: { mean: number; minPerMinute: number | null; expected: number | null };
    resolution: { width: number; height: number } | null;
    resolutionMatches: boolean | null;
  };
  latency: Record<string, LatencyKeyReport>;
  player: Record<string, unknown>;
  events: Record<string, number>;
};
