/**
 * Soak metrics from a case's observation stream: 250 ms page samples (see
 * scripts/player-acceptance/assessment.mjs for their fields) and 1 s ticks
 * carrying the player's stats, per-object latency summaries and events.
 * Report-only, except the verdict: no-playback when nothing played, no-audio
 * when the catalog lists an audio track that is never heard, and, under an
 * adverse profile, unrecovered when no fresh frame follows a disruption.
 */

const STALL_MS = 500;
const FROZEN_MS = 1500;
const AUDIO_GAP_MS = 500;
const AUDIBLE_RMS = 0.015;
const AUDIO_CODEC = /^(mp4a|opus|ac-3|ec-3|flac|vorbis|alac|ulaw|alaw|pcm)/i;

const median = (values) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const quantile = (values, q) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** Intervals of at least `minMs` where `active(sample)` is false, from sample wall times. */
export function quietIntervals(samples, active, minMs) {
  const out = [];
  let since = null;
  for (const s of samples) {
    if (active(s)) {
      if (since !== null && s.wallMs - since >= minMs) out.push({ startMs: since, durationMs: s.wallMs - since });
      since = null;
    } else {
      since ??= s.wallMs;
    }
  }
  const last = samples.at(-1);
  if (since !== null && last && last.wallMs - since >= minMs) out.push({ startMs: since, durationMs: last.wallMs - since, open: true });
  return out;
}

function intervalSummary(intervals) {
  return {
    count: intervals.length,
    totalMs: Math.round(intervals.reduce((n, i) => n + i.durationMs, 0)),
    longestMs: Math.round(intervals.reduce((n, i) => Math.max(n, i.durationMs), 0)),
  };
}

/** Per-minute and overall latency from 1 s summaries keyed `<media>/<source>`. */
export function latencyReport(ticks) {
  const keys = new Set(ticks.flatMap((t) => Object.keys(t.latency ?? {})));
  const t0 = ticks[0]?.wallEpochMs ?? 0;
  const out = {};
  for (const key of keys) {
    const seconds = ticks.filter((t) => t.latency?.[key]?.n > 0)
      .map((t) => ({ minute: Math.floor((t.wallEpochMs - t0) / 60_000), ...t.latency[key] }));
    const perMinute = [];
    for (const minute of [...new Set(seconds.map((s) => s.minute))].sort((a, b) => a - b)) {
      const m = seconds.filter((s) => s.minute === minute);
      perMinute.push({ minute, n: m.reduce((n, s) => n + s.n, 0), p50: median(m.map((s) => s.p50)),
        p95: quantile(m.map((s) => s.p95), 0.95), max: Math.max(...m.map((s) => s.max)) });
    }
    out[key] = {
      perMinute,
      p50: median(seconds.map((s) => s.p50)),
      p95: quantile(seconds.map((s) => s.p95), 0.95),
      max: seconds.length ? Math.max(...seconds.map((s) => s.max)) : null,
      driftMs: perMinute.length > 1 ? perMinute.at(-1).p50 - perMinute[0].p50 : 0,
    };
  }
  return out;
}

/** A freeze still open this close to the end of the run is still recovering, not unrecovered. */
const OPEN_GRACE_MS = 15_000;
/** Latency is stable again once this many consecutive seconds sit near the baseline. */
const STABLE_S = 5;
const stableBound = (baseline) => baseline * 1.2 + 50;

/**
 * Recovery from each disruption: the first fresh frame after it ends, the
 * picture outage around it, and when video latency settles back near its
 * pre-disruption median. Without scheduled disruptions, each frozen interval
 * counts as one (a publisher restart is only visible as a freeze).
 */
export function recoveryReport(samples, ticks, disruptions, frozen) {
  const events = disruptions.length > 0 ? disruptions
    : frozen.filter((f) => !f.open || f.durationMs >= OPEN_GRACE_MS).map((f) => {
      const at = samples.find((s) => s.wallMs >= f.startMs)?.wallEpochMs;
      return { kind: 'freeze', startEpochMs: at, endEpochMs: at };
    }).filter((e) => e.startEpochMs !== undefined);
  const key = Object.keys(ticks.find((t) => Object.keys(t.latency ?? {}).some((k) => k.startsWith('video/')))?.latency ?? {})
    .find((k) => k.startsWith('video/'));
  const series = key ? ticks.filter((t) => t.latency?.[key]?.n > 0).map((t) => ({ at: t.wallEpochMs, p50: t.latency[key].p50 })) : [];
  const firstStart = events[0]?.startEpochMs ?? Infinity;
  const baseline = median(series.filter((p) => p.at < firstStart).map((p) => p.p50));
  const fresh = (s, prev) => s.presentedFrames > prev.presentedFrames && s.pictureDigest !== prev.pictureDigest;
  return events.map((e) => {
    let lastFresh = null;
    let next = null;
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i];
      if (!fresh(s, samples[i - 1])) continue;
      if (s.wallEpochMs < e.endEpochMs) lastFresh = s;
      else { next = s; break; }
    }
    let stableAt = null;
    if (baseline !== null) {
      const after = series.filter((p) => p.at >= e.endEpochMs);
      const i = after.findIndex((_, j) => after.slice(j, j + STABLE_S).length === STABLE_S
        && after.slice(j, j + STABLE_S).every((p) => p.p50 <= stableBound(baseline)));
      if (i >= 0) stableAt = after[i].at;
    }
    return {
      kind: e.kind,
      ...(e.method ? { method: e.method } : {}),
      startEpochMs: e.startEpochMs,
      durationMs: e.endEpochMs - e.startEpochMs,
      freshFrameAfterMs: next ? next.wallEpochMs - e.endEpochMs : null,
      outageMs: next && lastFresh ? next.wallEpochMs - lastFresh.wallEpochMs : null,
      stableLatencyAfterMs: stableAt === null ? null : stableAt - e.endEpochMs,
      baselineLatencyMs: baseline,
    };
  });
}

const COUNTERS = ['stallCount', 'stallDurationMs', 'framesDropped', 'audioUnderruns', 'gapCount', 'framesRendered'];

export function assessSoak({ samples, ticks, expected = {}, startup = {}, disruptions = [], adverse = false }) {
  const first = samples[0];
  const last = samples.at(-1);
  const durationMs = first && last ? last.wallMs - first.wallMs : 0;
  const advanced = (prev) => (s) => {
    const moved = prev.s === undefined || s.mediaTimeS > prev.s.mediaTimeS + 0.001;
    prev.s = s;
    return moved;
  };
  const stalls = quietIntervals(samples, advanced({}), STALL_MS);
  const frozen = quietIntervals(samples, (() => {
    let previous;
    return (s) => {
      const changed = previous === undefined || (s.pictureDigest !== previous.pictureDigest && s.pictureChange > 1);
      previous = s;
      return changed;
    };
  })(), FROZEN_MS);
  const audioGaps = quietIntervals(samples, (s) => s.audioRms > AUDIBLE_RMS, AUDIO_GAP_MS);

  const fpsPerMinute = [];
  for (let m = 0; first && first.wallMs + (m + 1) * 60_000 <= last.wallMs + 1; m++) {
    const a = samples.find((s) => s.wallMs >= first.wallMs + m * 60_000);
    const b = [...samples].reverse().find((s) => s.wallMs <= first.wallMs + (m + 1) * 60_000);
    if (a && b && b.wallMs > a.wallMs) fpsPerMinute.push((b.presentedFrames - a.presentedFrames) / ((b.wallMs - a.wallMs) / 1000));
  }
  const fpsMean = first && last && durationMs > 0 ? (last.presentedFrames - first.presentedFrames) / (durationMs / 1000) : 0;

  const firstStats = ticks.find((t) => t.stats)?.stats;
  const lastStats = [...ticks].reverse().find((t) => t.stats)?.stats;
  const player = {};
  for (const c of COUNTERS) player[c] = firstStats && lastStats ? lastStats[c] - firstStats[c] : null;
  const skews = ticks.map((t) => t.stats?.avSkewMs).filter(Number.isFinite);
  const cushions = ticks.map((t) => t.stats?.cushionMs).filter(Number.isFinite);
  player.avSkewMs = { p50: median(skews), max: skews.length ? Math.max(...skews.map(Math.abs)) : null };
  player.cushionMs = { p50: median(cushions), min: cushions.length ? Math.min(...cushions) : null };
  player.timeToFirstFrameMs = lastStats?.timeToFirstFrameMs ?? null;

  const events = {};
  for (const e of ticks.flatMap((t) => t.events ?? [])) events[e.type] = (events[e.type] ?? 0) + 1;

  const recovery = recoveryReport(samples, ticks, disruptions, frozen);
  const unrecovered = recovery.filter((r) => r.freshFrameAfterMs === null).length;
  const maxOf = (values) => (values.length ? Math.max(...values) : null);
  const breakdown = [...ticks].reverse().find((t) => t.stats?.ttffBreakdown?.firstFrameRenderedMs != null)?.stats.ttffBreakdown;

  const resolution = last ? { width: last.videoWidth, height: last.videoHeight } : null;
  const played = samples.length > 0 && fpsMean > 0 && last.mediaTimeS > first.mediaTimeS;
  const catalog = ticks.flatMap((t) => t.events ?? []).find((e) => e.type === 'catalog_received')?.data?.catalog;
  const advertisesAudio = Array.isArray(catalog?.tracks) && catalog.tracks.some((t) => t.role === 'audio'
    || (t.role === undefined && AUDIO_CODEC.test(t.codec ?? '')));
  const audible = samples.some((s) => s.audioRms > AUDIBLE_RMS);
  return {
    verdict: !played ? 'no-playback' : advertisesAudio && !audible ? 'no-audio'
      : adverse && unrecovered > 0 ? 'unrecovered' : 'played',
    audio: { advertised: advertisesAudio, audible },
    durationS: Math.round(durationMs / 1000),
    samples: samples.length,
    startup: { ...startup, ...(breakdown ? { breakdownMs: breakdown } : {}) },
    recovery: {
      events: recovery,
      unrecovered,
      unsettled: recovery.filter((r) => r.stableLatencyAfterMs === null).length,
      freshFrameAfterMsMax: maxOf(recovery.map((r) => r.freshFrameAfterMs).filter(Number.isFinite)),
      stableLatencyAfterMsMax: maxOf(recovery.map((r) => r.stableLatencyAfterMs).filter(Number.isFinite)),
    },
    playback: {
      stalls: intervalSummary(stalls),
      rebufferRatio: durationMs > 0 ? +(intervalSummary(stalls).totalMs / durationMs).toFixed(4) : null,
      frozen: intervalSummary(frozen),
      audioGaps: intervalSummary(audioGaps),
      fps: { mean: +fpsMean.toFixed(2), minPerMinute: fpsPerMinute.length ? +Math.min(...fpsPerMinute).toFixed(2) : null,
        expected: expected.videoFps ?? null },
      resolution,
      resolutionMatches: expected.videoWidth ? resolution?.width === expected.videoWidth && resolution?.height === expected.videoHeight : null,
    },
    latency: latencyReport(ticks),
    player,
    events,
    intervals: { stalls, frozen, audioGaps },
  };
}
