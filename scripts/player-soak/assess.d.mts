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

export function quietIntervals(samples: PlaybackSample[], active: (s: PlaybackSample) => boolean, minMs: number): Interval[];
export function latencyReport(ticks: SoakTick[]): Record<string, LatencyKeyReport>;
export function assessSoak(input: {
  samples: PlaybackSample[];
  ticks: SoakTick[];
  expected?: { videoWidth?: number; videoHeight?: number; videoFps?: number };
  startup?: Record<string, unknown>;
}): {
  verdict: 'played' | 'no-playback';
  durationS: number;
  samples: number;
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
