/**
 * G5 Player
 *
 * Plays LOC and CMAF through the relay and instruments what it sees: a metrics
 * row of health counters, four charts on one shared time axis, the catalog as
 * delivered, and a transport panel. Built on openmoq/moq-playa; the engine is
 * theirs, the instrument is not.
 */

import { Player } from '@playa/player';
import {
  namespace, certHash, draftVersion, catalogBootstrap, warmStart,
  renderCushionFloorMs, renderCushionMaxMs, targetLatencyMs as targetLatencyOverrideMs, debug,
} from '../shared/cert.js';

/** `?catchUp=1.1`: max playback rate for chasing the catalog targetLatency (>= 1). */
const catchUpRate: number | undefined = (() => {
  const v = Number(new URLSearchParams(location.search).get('catchUp'));
  return Number.isFinite(v) && v >= 1 ? v : undefined;
})();
import { resolveRelayEndpoint, onDiscoveryAttempt } from '../shared/relay-endpoint.js';

// ─── DOM refs & helpers ─────────────────────────────────────────────

const playBtn = document.getElementById('play-btn') as HTMLButtonElement;
const seekBar = document.getElementById('seek') as HTMLInputElement;
const timeDisplay = document.getElementById('time')!;
const volumeBar = document.getElementById('volume') as HTMLInputElement;
const muteBtn = document.getElementById('mute-btn') as HTMLButtonElement;
const qualitySelect = document.getElementById('quality') as HTMLSelectElement;
const stateBadge = document.getElementById('state')!;
const diagGrid = document.getElementById('diag-grid')!;
const advGrid = document.getElementById('adv-grid')!;
const advPanel = document.getElementById('adv-panel') as HTMLDetailsElement;
const latSpark = document.getElementById('lat-spark') as HTMLCanvasElement;
const jitSpark = document.getElementById('jit-spark') as HTMLCanvasElement;
const cusSpark = document.getElementById('cus-spark') as HTMLCanvasElement;
const cusVal = document.getElementById('cus-val')!;
const cusTarget = document.getElementById('cus-target')!;
const cusCushion = document.getElementById('cus-cushion')!;
const bufSpark = document.getElementById('buf-spark') as HTMLCanvasElement;
const bufDVal = document.getElementById('bufd-val')!;
const bufVVal = document.getElementById('bufv-val')!;
const bufAVal = document.getElementById('bufa-val')!;
const latVal = document.getElementById('lat-val')!;
const latP95 = document.getElementById('lat-p95')!;
const latMax = document.getElementById('lat-max')!;
const latLabel = document.getElementById('lat-label')!;
const jitVal = document.getElementById('jit-val')!;
const catalogPanel = document.getElementById('catalog-panel')!;
const catMeta = document.getElementById('cat-meta')!;
const catTracks = document.getElementById('cat-tracks')!;
const catJson = document.getElementById('cat-json')!;
const catToggle = document.getElementById('cat-toggle') as HTMLButtonElement;
const catCopy = document.getElementById('cat-copy') as HTMLButtonElement;
const logCopy = document.getElementById('log-copy') as HTMLButtonElement;
const catRestore = document.getElementById('cat-restore') as HTMLButtonElement;
const layoutEl = document.getElementById('layout')!;
const logEl = document.getElementById('log')!;
const playerContainer = document.getElementById('player-container')!;

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
  logEl.textContent += `[${ts}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

/** Copy to the clipboard, confirming in the button itself. */
function wireCopy(btn: HTMLButtonElement, text: () => string): void {
  btn.addEventListener('click', async () => {
    const restore = btn.textContent;
    try {
      await navigator.clipboard.writeText(text());
      btn.textContent = 'copied';
    } catch {
      // Denied permission, or no clipboard outside a secure context.
      btn.textContent = 'blocked';
    }
    setTimeout(() => { btn.textContent = restore; }, 1200);
  });
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ─── Main ───────────────────────────────────────────────────────────
// Explicit ?url= is used as-is; otherwise the shared discovery probes the
// page host's common endpoint paths. Total failure renders the diagnostic
// and stops — no rethrow, no unhandled page error.

async function main(): Promise<void> {
  log('Discovering relay endpoint...');
  onDiscoveryAttempt((url, outcome) => log(`  probe ${url}: ${outcome}`));
  let relayUrl: string;
  try {
    relayUrl = await resolveRelayEndpoint();
  } catch (err) {
    log(`Fatal: ${(err as Error).message}`);
    stateBadge.textContent = 'error';
    stateBadge.className = 'state-badge error';
    return;
  }

  // ── Create Player ─────────────────────────────────────────────────

  // Engine-level options reach MoqtPlayer only via moqtPlayerConfig.
  const engineConfig = {
    ...(catalogBootstrap ? { catalogBootstrap } : {}),
    ...(warmStart ? { warmStartCurrentGroup: true } : {}),
    ...(catchUpRate ? { maxCatchUpRate: catchUpRate } : {}),
    ...(renderCushionFloorMs ? { renderCushionFloorMs } : {}),
    ...(renderCushionMaxMs ? { renderCushionMaxMs } : {}),
    ...(debug ? { logLevel: 'debug' as const } : {}),
  };
  const player = new Player(playerContainer, {
    url: relayUrl,
    namespace,
    autoplay: true,
    ...(certHash ? { certHash } : {}),
    ...(draftVersion ? { draftVersion } : {}),
    ...(targetLatencyOverrideMs ? { targetLatencyMs: targetLatencyOverrideMs } : {}),
    moqtPlayerConfig: engineConfig,
  });
  const optionSummary = Object.entries({ ...engineConfig, targetLatencyMs: targetLatencyOverrideMs })
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  if (optionSummary) log(`Options: ${optionSummary}`);

  // ── Wire Events ───────────────────────────────────────────────────

  player.on('statechange', ({ state }) => {
    stateBadge.textContent = state;
    stateBadge.className = `state-badge ${state}`;
  });

  player.on('ready', ({ levels }) => {
    log(`Ready: ${levels.length} quality level(s)`);
    playBtn.disabled = false;
    muteBtn.disabled = false;
    qualitySelect.disabled = false;
    qualitySelect.innerHTML = '<option value="auto">Auto</option>';
    for (const level of levels) {
      const opt = document.createElement('option');
      opt.value = String(level.index);
      opt.textContent = `${level.label} (${Math.round(level.bitrate / 1000)}k)`;
      qualitySelect.appendChild(opt);
    }
  });

  // Each milestone is ms from load(), so the gaps between them say which
  // stage a slow start spent its time in (late joiners differ from the first).
  player.on('playing', () => {
    const b = (player as any).engine?.stats?.ttffBreakdown;
    if (!b) { log('First frame rendered'); return; }
    const ms = (v: number | null) => (v == null ? '—' : v.toFixed(0));
    log(`First frame rendered · transport ${ms(b.transportConnectedMs)}`
      + ` · setup ${ms(b.setupCompleteMs)} · catalog ${ms(b.catalogReceivedMs)}`
      + ` · firstObject ${ms(b.firstObjectReceivedMs)}`
      + ` · decoder ${ms(b.decoderConfiguredMs)} · frame ${ms(b.firstFrameRenderedMs)}`);
  });

  player.on('timeupdate', ({ currentTime }) => {
    timeDisplay.textContent = formatTime(currentTime);
    if (player.duration) {
      seekBar.max = String(player.duration);
      seekBar.value = String(currentTime);
      seekBar.disabled = !player.seekable;
    }
  });

  player.on('durationchange', ({ duration }) => log(`Duration: ${formatTime(duration)}`));
  player.on('qualitychange', ({ level, auto }) => log(`Quality: ${level.label} (${auto ? 'ABR' : 'manual'})`));
  // MSE path: buffered ranges at the moment the element stalled ('waiting')
  // and again when the stall ends — a hole that has closed by the end is a
  // late object landing behind the playhead.
  const describeVideo = (video: HTMLVideoElement): string => {
    const r: string[] = [];
    for (let i = 0; i < video.buffered.length; i++) {
      r.push(`[${video.buffered.start(i).toFixed(2)}–${video.buffered.end(i).toFixed(2)}]`);
    }
    return `t=${video.currentTime.toFixed(2)} rs=${video.readyState} rate=${video.playbackRate} `
      + `buffered=${r.join('') || 'none'}`;
  };
  let watchedVideo: HTMLVideoElement | null = null;
  let stallStartSnap = '';
  const watchVideo = () => {
    const video = playerContainer.querySelector('video');
    if (!video || video === watchedVideo) return video;
    watchedVideo = video;
    video.addEventListener('waiting', () => { stallStartSnap = describeVideo(video); });
    if (debug) {
      // Element-side view of every playhead disturbance, timestamped like
      // the stall lines so the two can be correlated.
      for (const ev of ['play', 'playing', 'pause', 'waiting', 'stalled', 'suspend',
                        'seeking', 'seeked', 'ratechange', 'ended', 'error']) {
        video.addEventListener(ev, () => log(`[video] ${ev} ${describeVideo(video)}`));
      }
    }
    return video;
  };
  player.on('stall', ({ durationMs }) => {
    const video = watchVideo();
    const where = video
      ? ` start: ${stallStartSnap || '?'} · end: ${describeVideo(video)}` : '';
    log(`Stall: ${durationMs.toFixed(0)}ms${where}`);
    stallStartSnap = '';
    stallMarks.push(cushionSamples.length);
  });
  player.on('error', ({ severity, message }) => log(`[${severity}] ${message}`));

  const renderCushionMs = (): number | null =>
    (player as any).engine?.stats?.loc?.renderCushionMs ?? null;
  let lastSyncResets = 0;
  player.on('stats', (s: any) => {
    const syncResets: number = (player as any).engine?.stats?.loc?.syncResetCount ?? 0;
    if (syncResets > lastSyncResets) {
      log(`Sync reference re-anchored (${syncResets} total)`);
      lastSyncResets = syncResets;
    }
    // `unit` renders small and muted after the value; `tone` colours the value
    // by health, so a non-zero fault counter is visible without reading labels.
    const cell = (label: string, v: string, unit = '', tone = '', unitTone = '') =>
      `<div class="cell">${label}:<b${tone ? ` class="${tone}"` : ''}>${v}`
      + `${unit ? `<span class="u${unitTone ? ` ${unitTone}` : ''}">${unit}</span>` : ''}</b></div>`;
    // Role, not severity: green measures, amber marks the counters that
    // should stay at zero. Stream identity lives in the catalog panel.
    const NUM = 'num';
    // Amber only once a counter has something to report; white at zero.
    const FAULT = (n: number) => (n > 0 ? 'fault' : '');
    const fmtKbps = (v: number | null): string => (v == null ? '—' : v.toFixed(0));
    // The LOC gauges (render cushion, skew, audio underruns/late/snap) do not
    // exist on the MSE path, and a column of em-dashes is worse than no column.
    const cushion = renderCushionMs();
    const locPath = cushion != null || s.avSkewMs != null;
    // Compared against the playout cushion, which is on screen and static: a
    // reorder settling inside it is absorbed invisibly, one settling beyond it
    // arrived later than the buffer was sized to cope with. The adaptive gap
    // timeout is the true discard threshold but it moves, which made a frozen
    // value change colour on its own.
    const settleMs = settleMaxMs();
    const lagWorst = Math.max(0, ...lagSamples.map(([, d]) => d));
    const settleTone = targetLatencyMs > 0 && settleMs > targetLatencyMs ? 'fault' : '';
    diagGrid.innerHTML = [
      cell('ttff', s.timeToFirstFrameMs != null ? s.timeToFirstFrameMs.toFixed(0) : '—', 'ms', NUM),
      // Frames that were decoded but never presented are the interesting part,
      // so the pair stays together rather than in two separate columns.
      cell('bitrate v/a', `${fmtKbps(trackKbps('video'))}/${fmtKbps(trackKbps('audio'))}`, 'kbps', NUM),
      cell('rend/dec', `${s.framesRendered ?? 0}/${s.framesDecoded ?? 0}`, '', NUM),
      // Cross-stream arrival order, not a fault: LOC audio is one group per frame
      // on its own QUIC stream and independent streams carry no ordering between
      // them. The settle time is the one with a cliff in front of it — past the
      // adaptive gap timeout the object is discarded and costs a sync reset — so
      // it, not the count, is what goes amber.
      cell('reorder v/a',
        `${seqStat('video', 'reorders')}/${seqStat('audio', 'reorders')}`,
        `&le;${settleMs.toFixed(0)}ms`, NUM, settleTone),
      // Worst event-loop lag in the window. Tens of ms is ordinary scheduling;
      // hundreds means the thread is blocked or the tab is being throttled.
      cell('lag ms', lagSamples.length ? lagWorst.toFixed(0) : '—', '',
        lagWorst > 100 ? 'fault' : NUM),
      // Render cushion rides the queued-ahead chart label and A/V skew has a
      // chart of its own: this row is for facts and fault counts, not gauges.
      ...(locPath ? [
        cell('resyncs', String(syncResets), '', FAULT(syncResets)),
        cell('underruns', String(s.audioUnderruns ?? 0), '', FAULT(s.audioUnderruns ?? 0)),
        // Why audio underran: dropped late before decode / snapped by the output clamp.
        cell('late/snap', `${(player as any).engine?.stats?.loc?.audioLateDrops ?? 0}`
          + `/${(player as any).audioOutput?.liveEdgeSnapCount ?? 0}`, '',
          FAULT(((player as any).engine?.stats?.loc?.audioLateDrops ?? 0)
            + ((player as any).audioOutput?.liveEdgeSnapCount ?? 0))),
      ] : []),
      cell('dropped', String(s.framesDropped ?? 0), '', FAULT(s.framesDropped ?? 0)),
      // An id that never arrived: a frame missing inside a buffered range, which
      // nothing else on this panel can see.
      cell('obj lost v/a', `${seqStat('video', 'lost')}/${seqStat('audio', 'lost')}`, '',
        FAULT(seqStat('video', 'lost') + seqStat('audio', 'lost'))),
      cell('stalls', `${s.stallCount ?? 0} (${((s.stallDurationMs ?? 0) / 1000).toFixed(1)}s)`, '',
        FAULT(s.stallCount ?? 0)),
    ].join('');
  });

  // ── Latency & jitter sparklines (from media_object arrivals) ─────

  // Latency is wall-clock: arrival minus the publisher's capture stamp,
  // so it reads true only when both clocks agree. A systematic negative
  // offset is reported as clock skew rather than silently dropped.
  //
  // Jitter is RFC 3550 §6.4.1 interarrival jitter — the smoothed
  // deviation between arrival spacing and capture spacing, which
  // separates network jitter from the publisher's own pacing. Without
  // capture timestamps it degrades to arrival-interval deviation.

  // Raw per-object latency with arrival times, trimmed to a window. The chart
  // series below are filled on the 250 ms tick instead of per object, so all
  // four charts share one time axis (180 samples = 45 s) and features line up.
  const latWindow: Array<[number, number]> = [];
  const LAT_WINDOW_MS = 4_000;
  // Both curves are the printed p50 and p95 over the same window, so the lines
  // and the numbers cannot disagree. Max stays a readout: as a curve it is one
  // sample wide and reads as noise.
  const latP50Samples: number[] = [];
  const latP95Samples: number[] = [];
  // Per-tick worst sample, not drawn: it lets the readout report the worst
  // across the whole charted span. p95 over ~120 samples cannot be moved by a
  // lone spike, so this is the only series here that sees one.
  const latTickMaxSamples: number[] = [];
  // Per-tick floor, for the offset estimate below.
  const latMinSamples: number[] = [];
  const jitSamples: number[] = [];
  // Playout cushion: media buffered ahead of the playhead, sampled every
  // 250ms — MSE from the <video> element's buffered ranges, WebCodecs
  // from the engine's buffer-depth stat. Starvation (cushion ≈ 0 at a
  // stall marker) points at the player; a healthy cushion points wire-ward.
  const cushionSamples: number[] = [];
  const bufDeltaSamples: number[] = [];
  // Event-loop lag: how late a timer that does nothing actually runs. The 250 ms
  // tick below cannot measure this — setInterval waits for its own callback, so
  // its period carries this page's draw cost. A bare probe carries only
  // contention: other work blocking the thread, or Chrome clamping timers toward
  // 1 Hz for a tab that is hidden or inaudible. Either starves every stage of the
  // pipeline and surfaces downstream as queue oscillation.
  const LAG_PERIOD_MS = 50;
  const lagSamples: Array<[number, number]> = [];
  let lagDueAt = 0;
  let lastChaseNoteMs = 0;
  const lagProbe = (): void => {
    const now = performance.now();
    if (lagDueAt) lagSamples.push([now, Math.max(0, now - lagDueAt)]);
    while (lagSamples.length && now - lagSamples[0]![0] > SETTLE_WINDOW_MS) {
      lagSamples.shift();
    }
    lagDueAt = now + LAG_PERIOD_MS;
    setTimeout(lagProbe, LAG_PERIOD_MS);
  };
  setTimeout(lagProbe, LAG_PERIOD_MS);
  const stallMarks: number[] = [];
  let targetLatencyMs = 0;
  let audioCodec: string | null = null;
  let videoFps: number | null = null;
  let prevArrivalMs = 0;
  let prevCaptureMs = 0;
  let jitterEwma = 0;
  let expectedIntervalMs = 0;
  (window as any).__player = player;
  const pushSample = (a: number[], v: number) => {
    a.push(v);
    if (a.length > 180) a.shift();
  };

  // Series carry NaN for "nothing to report" so the charts stay on one axis;
  // readouts must skip those rather than print them.
  const lastFinite = (a: number[]): number | null => {
    for (let i = a.length - 1; i >= 0; i--) if (Number.isFinite(a[i]!)) return a[i]!;
    return null;
  };
  const maxFinite = (a: number[]): number | null => {
    const f = a.filter(Number.isFinite);
    return f.length ? Math.max(...f) : null;
  };

  const percentile = (a: number[], p: number): number => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
  };

  // Per-track object continuity. Arrival order is not delivery order: LOC audio
  // is one group per frame on its own QUIC stream (~47/s), and independent
  // streams carry no ordering guarantee between them, so adjacent ids routinely
  // race. A high-water mark plus a pending set separates the two cases — an id
  // that lands late and fills its own hole is a reorder, one still missing after
  // the settle window is loss. Loss inside a buffered range is what a stall with
  // data still ahead of the playhead looks like from here.
  const REORDER_SETTLE_MS = 1_000;
  // Past this a jump is a restart or a join, not a hole worth enumerating.
  const SEQ_JUMP_CAP = 200n;
  // Settle times age out: a lifetime maximum reports one bad moment forever and
  // stops describing current conditions.
  const SETTLE_WINDOW_MS = 45_000;
  interface ObjSeq {
    group: bigint; object: bigint;        // high-water mark, not last seen
    pending: Map<string, number>;
    reorders: number; lost: number;
    settles: Array<[number, number]>;     // [arrival, settle ms]
  }
  const objSeq: Record<string, ObjSeq> = {};
  const seqStat = (t: string, k: 'reorders' | 'lost'): number => objSeq[t]?.[k] ?? 0;
  const settleMaxMs = (): number => {
    let worst = 0;
    for (const s of Object.values(objSeq)) {
      for (const [, ms] of s.settles) if (ms > worst) worst = ms;
    }
    return worst;
  };
  // Payload bytes with arrival times, trimmed to a 5 s window: the measured
  // media bitrate, as distinct from the catalog's declared figure and from
  // wire goodput in the transport panel (which counts MOQT and QUIC overhead).
  const byteLog: Record<string, Array<[number, number]>> = { video: [], audio: [] };
  const BITRATE_WINDOW_MS = 5_000;
  const trackKbps = (t: string): number | null => {
    const w = byteLog[t];
    if (!w || w.length < 2) return null;
    const span = w[w.length - 1]![0] - w[0]![0];
    if (span < 500) return null;
    const total = w.reduce((n, [, b]) => n + b, 0);
    return (total * 8) / span;   // bytes/ms * 8 = kbit/s
  };
  const noteObject = (e: any): void => {
    const t = e.mediaType;
    if ((t !== 'video' && t !== 'audio') || e.kind !== 'data') return;
    // Bytes first: the sequence check below returns early when a relay omits
    // ids, and bitrate must not depend on that.
    if (e.bytes) {
      const w = byteLog[t]!;
      const now = performance.now();
      w.push([now, e.bytes]);
      while (w.length && now - w[0]![0] > BITRATE_WINDOW_MS) w.shift();
    }
    // The facade names these groupId/objectId.
    const gid = e.groupId ?? e.group, oid = e.objectId ?? e.object;
    if (gid === undefined || oid === undefined) return;
    const group = BigInt(gid), object = BigInt(oid);
    const now = performance.now();
    const s = objSeq[t];
    if (!s) {
      objSeq[t] = { group, object, pending: new Map(),
                    reorders: 0, lost: 0, settles: [] };
      return;
    }
    if (group > s.group || (group === s.group && object > s.object)) {
      if (group - s.group > SEQ_JUMP_CAP) {
        s.pending.clear();
        log(`obj jump [${t}]: ${s.group}.${s.object} -> ${group}.${object}`);
      } else if (group === s.group) {
        for (let o = s.object + 1n; o < object; o++) s.pending.set(`${group}.${o}`, now);
      } else {
        // Only each skipped group's head is tracked: without END_OF_GROUP the
        // previous group's object count is unknown, so its tail is not a hole.
        for (let g = s.group + 1n; g < group; g++) s.pending.set(`${g}.0`, now);
        for (let o = 0n; o < object && o < SEQ_JUMP_CAP; o++) {
          s.pending.set(`${group}.${o}`, now);
        }
      }
      s.group = group;
      s.object = object;
    } else {
      const key = `${group}.${object}`;
      const at = s.pending.get(key);
      if (at !== undefined) {
        s.pending.delete(key);
        s.reorders++;
        s.settles.push([now, now - at]);
      }
    }
    // An id that never fills its hole is loss. The settle window is what keeps
    // this from counting every in-flight reorder as a missing object.
    while (s.settles.length && now - s.settles[0]![0] > SETTLE_WINDOW_MS) s.settles.shift();
    let lost = 0, firstKey = '';
    for (const [key, at] of s.pending) {
      if (now - at <= REORDER_SETTLE_MS) continue;
      s.pending.delete(key);
      if (!lost) firstKey = key;
      lost++;
    }
    // One line per sweep: a multi-group gap expires every id it opened at once.
    if (lost) {
      s.lost += lost;
      log(`obj lost [${t}]: ${lost} from ${firstKey}`);
    }
  };

  (player as any).on('media_object', (e: any) => {
    noteObject(e);
    if (e.mediaType !== 'video' || e.kind !== 'data') return;

    const arrivalMs = performance.now();
    const captureMs = e.captureTimestamp && e.captureTimestamp > 0n
      ? Number(e.captureTimestamp) / 1000
      : 0;

    if (captureMs && prevCaptureMs) {
      // D = (Rj - Ri) - (Sj - Si);  J += (|D| - J) / 16
      const d = (arrivalMs - prevArrivalMs) - (captureMs - prevCaptureMs);
      jitterEwma += (Math.abs(d) - jitterEwma) / 16;
    } else if (prevArrivalMs) {
      const interval = arrivalMs - prevArrivalMs;
      if (expectedIntervalMs) jitterEwma = Math.abs(interval - expectedIntervalMs);
      expectedIntervalMs = expectedIntervalMs
        ? expectedIntervalMs * 0.9 + interval * 0.1 : interval;
    }

    prevArrivalMs = arrivalMs;
    if (captureMs) {
      prevCaptureMs = captureMs;
      const latencyMs = Date.now() - captureMs;
      // Kept whatever the sign: a publisher stamping ahead of its own clock,
      // or an unsynchronised pair of machines, is an offset the tick removes.
      // Only a stamp too far out to be a clock difference is dropped.
      if (Math.abs(latencyMs) < 120_000) {
        const now = performance.now();
        latWindow.push([now, latencyMs]);
        while (latWindow.length && now - latWindow[0]![0] > LAT_WINDOW_MS) latWindow.shift();
      }
    }
  });

  function drawSpark(canvas: HTMLCanvasElement, data: number[],
                     color: string, refLine = 0,
                     marks?: number[]): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width = canvas.clientWidth * devicePixelRatio;
    const h = canvas.height = canvas.clientHeight * devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    const live = data.filter(Number.isFinite);
    if (live.length < 2) return;
    const max = Math.max(...live, refLine) * 1.15 || 1;
    const yOf = (v: number) => h - (v / max) * (h - 6) - 3;
    const xOf = (i: number) => (i / (data.length - 1)) * w;
    if (refLine > 0) {
      ctx.beginPath();
      ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
      ctx.moveTo(0, yOf(refLine));
      ctx.lineTo(w, yOf(refLine));
      ctx.strokeStyle = '#667';
      ctx.lineWidth = devicePixelRatio;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const m of marks ?? []) {
      if (m < 0 || m >= data.length) continue;
      ctx.fillStyle = 'rgba(204, 68, 68, 0.55)';
      ctx.fillRect(xOf(m) - devicePixelRatio, 0, 2 * devicePixelRatio, h);
    }
    ctx.beginPath();
    // A gap in the data lifts the pen rather than drawing through it.
    let pen = false;
    data.forEach((v, i) => {
      if (!Number.isFinite(v)) { pen = false; return; }
      if (pen) ctx.lineTo(xOf(i), yOf(v)); else { ctx.moveTo(xOf(i), yOf(v)); pen = true; }
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = devicePixelRatio;
    ctx.stroke();
  }

  /** Two series on one scale — only comparable on a shared axis. */
  function drawSpark2(canvas: HTMLCanvasElement, a: number[], aColor: string,
                      b: number[], bColor: string): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width = canvas.clientWidth * devicePixelRatio;
    const h = canvas.height = canvas.clientHeight * devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    const max = Math.max(1, ...a.filter(Number.isFinite), ...b.filter(Number.isFinite)) * 1.15;
    for (const [data, color] of [[a, aColor], [b, bColor]] as Array<[number[], string]>) {
      if (data.filter(Number.isFinite).length < 2) continue;
      ctx.beginPath();
      let pen = false;
      data.forEach((v, i) => {
        if (!Number.isFinite(v)) { pen = false; return; }
        const x = (i / (data.length - 1)) * w;
        const y = h - (v / max) * (h - 6) - 3;
        if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = devicePixelRatio;
      ctx.stroke();
    }
  }

  /** Signed series around a zero rule: only the divergence is the signal. */
  function drawDelta(canvas: HTMLCanvasElement, data: number[]): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width = canvas.clientWidth * devicePixelRatio;
    const h = canvas.height = canvas.clientHeight * devicePixelRatio;
    ctx.clearRect(0, 0, w, h);
    const zeroY = h / 2;
    ctx.beginPath();
    ctx.setLineDash([4 * devicePixelRatio, 4 * devicePixelRatio]);
    ctx.moveTo(0, zeroY);
    ctx.lineTo(w, zeroY);
    ctx.strokeStyle = '#667';
    ctx.lineWidth = devicePixelRatio;
    ctx.stroke();
    ctx.setLineDash([]);
    const live = data.filter(Number.isFinite);
    if (live.length < 2) return;
    // A floor on the scale keeps normal ±ms wobble from looking like drift.
    const span = Math.max(100, ...live.map(Math.abs)) * 1.15;
    ctx.beginPath();
    let pen = false;
    data.forEach((v, i) => {
      if (!Number.isFinite(v)) { pen = false; return; }
      const x = (i / (data.length - 1)) * w;
      const y = zeroY - (v / span) * (h / 2 - 3);
      if (pen) ctx.lineTo(x, y); else { ctx.moveTo(x, y); pen = true; }
    });
    ctx.strokeStyle = '#d9922e';
    ctx.lineWidth = devicePixelRatio;
    ctx.stroke();
  }

  // ── Transport panel (QUIC/WebTransport) ───────────────────────────
  // Polled only while the panel is open. Chrome reports these on the
  // WebTransport object; native QUIC adapters and other browsers may not,
  // in which case the panel says so rather than showing zeros.
  let prevWtBytes = 0;
  let prevWtAtMs = 0;
  const advCell = (label: string, v: string) =>
    `<div class="cell">${label}:<b>${v}</b></div>`;
  const renderTransport = async (): Promise<void> => {
    if (!advPanel.open) return;
    const conn = (player as any).engine?.connection;
    const st = await conn?.getTransportStats?.();
    if (!st) {
      advGrid.innerHTML = advCell('transport stats',
        conn ? 'not reported by this transport' : 'not connected');
      return;
    }
    const num = (k: string): number | undefined => st[k];
    const ms = (k: string) => (num(k) != null ? `${num(k)!.toFixed(1)} ms` : '—');
    const lost = num('packetsLost') ?? 0;
    const rcvd = num('packetsReceived') ?? 0;
    const lossPct = rcvd + lost > 0 ? (lost / (rcvd + lost)) * 100 : 0;
    const bytes = num('bytesReceived') ?? 0;
    const nowMs = performance.now();
    // Wire goodput, which includes every stream and MOQT overhead — not the
    // media bitrate the catalog advertises.
    const goodputMbps = prevWtAtMs && bytes > prevWtBytes
      ? ((bytes - prevWtBytes) * 8) / ((nowMs - prevWtAtMs) * 1000)
      : 0;
    prevWtBytes = bytes; prevWtAtMs = nowMs;
    const cells = [
      advCell('rtt smoothed', ms('smoothedRtt')),
      advCell('rtt min', ms('minRtt')),
      advCell('rtt variation', ms('rttVariation')),
      advCell('packets lost', `${lost} (${lossPct.toFixed(2)}%)`),
      advCell('packets rx / tx', `${rcvd} / ${num('packetsSent') ?? 0}`),
      advCell('bytes rx', `${(bytes / 1e6).toFixed(1)} MB`),
      advCell('goodput', `${goodputMbps.toFixed(2)} Mbps`),
      advCell('est send rate', num('estimatedSendRate') != null
        ? `${(num('estimatedSendRate')! / 1e6).toFixed(2)} Mbps` : '—'),
      advCell('streams in / out',
        `${num('numIncomingStreamsCreated') ?? 0} / ${num('numOutgoingStreamsCreated') ?? 0}`),
    ];
    // Datagram counters only exist once a datagram has moved.
    for (const k of Object.keys(st)) {
      if (k.startsWith('datagrams.')) cells.push(advCell(k.slice(10), String(st[k])));
    }
    advGrid.innerHTML = cells.join('');
  };
  advPanel.addEventListener('toggle', () => { void renderTransport(); });

  let advTick = 0;
  setInterval(() => {
    watchVideo();
    if (++advTick % 4 === 0) void renderTransport();
    if (debug) {
      // The MSE adapter exists only after the catalog; enable its tracing
      // once it appears (console output).
      const ms = (player as any).engine?.mediaSource;
      if (ms && ms.debug === false) ms.debug = true;
    }
    // Contiguous cushion only (facade-computed per path). Zero with appends
    // still landing means the playhead is parked at a hole.
    const tickNowMs = performance.now();
    const cushionMs = player.stats.cushionMs;
    if (player.state !== 'idle') {
      cushionSamples.push(cushionMs ?? NaN);
      if (cushionSamples.length > 180) {
        cushionSamples.shift();
        for (let i = 0; i < stallMarks.length; i++) stallMarks[i]!--;
        while (stallMarks.length && stallMarks[0]! < 0) stallMarks.shift();
      }
    }
    // Per-track buffer: MSE SourceBuffers on CMAF; on LOC the renderer's
    // queued video against the audio output's scheduled audio.
    const eng = (player as any).engine;
    const byKind = eng?.mediaSource?.getBufferAheadMsByKind?.();
    const vMs = byKind ? byKind.video
      : ((player as any).renderer?.queuedAheadMs ?? null);
    const aMs = byKind ? byKind.audio
      : (((player as any).audioOutput?.scheduledAheadSec ?? null) != null
        ? (player as any).audioOutput.scheduledAheadSec * 1000 : null);
    if (player.state !== 'idle') {
      pushSample(bufDeltaSamples, vMs != null && aMs != null ? vMs - aMs : NaN);
    }

    // Sample the measurements onto the shared time axis before drawing.
    const latRaw = latWindow.map(([, v]) => v);
    if (latRaw.length) pushSample(latMinSamples, Math.min(...latRaw));
    // Clocks that disagree — or a publisher whose capture stamps run ahead of
    // its own clock — put every sample below zero by a constant. The floor of
    // the charted window is that constant: subtracting it leaves the spikes,
    // the jitter and the shape, which is what the chart is for. Zero offset
    // when the samples are already positive, so a synced pair reads absolute.
    // A low percentile rather than the outright floor: one bad stamp must not
    // re-base the whole chart for the length of the window.
    const latOffset = latMinSamples.length
      ? Math.min(0, percentile(latMinSamples, 0.05)) : 0;
    const latVals = latOffset
      ? latRaw.map((v) => Math.max(0, v - latOffset)) : latRaw;
    // Every series takes exactly one slot per tick, NaN where there is nothing
    // to report, so all four charts share one time axis and a feature at the
    // same x is the same instant. Skipping a slot silently stretches that
    // chart's window past the others'.
    const have = latVals.length > 0;
    pushSample(latP50Samples, have ? percentile(latVals, 0.5) : NaN);
    pushSample(latP95Samples, have ? percentile(latVals, 0.95) : NaN);
    pushSample(latTickMaxSamples, have ? Math.max(...latVals) : NaN);
    pushSample(jitSamples, prevCaptureMs || expectedIntervalMs ? jitterEwma : NaN);

    drawSpark2(latSpark, latP50Samples, '#d9c25c', latP95Samples, '#d9922e');
    drawSpark(jitSpark, jitSamples, '#d9922e');
    drawSpark(cusSpark, cushionSamples, '#4d4', targetLatencyMs, stallMarks);
    drawDelta(bufSpark, bufDeltaSamples);
    bufDVal.textContent = (vMs != null && aMs != null)
      ? `${vMs - aMs >= 0 ? '+' : ''}${(vMs - aMs).toFixed(0)}` : '—';
    bufVVal.textContent = vMs != null ? vMs.toFixed(0) : '—';
    bufAVal.textContent = aMs != null ? aMs.toFixed(0) : '—';
    cusVal.textContent = lastFinite(cushionSamples)?.toFixed(0) ?? '—';
    cusTarget.textContent = targetLatencyMs ? String(targetLatencyMs) : '—';
    // One measurement (queued) against one setting (target). The render
    // cushion is a third name for the same region and pub_media pins it equal
    // to the target anyway, so it is not shown; rate and chase state are.
    const rateNow = (playerContainer.querySelector('video')?.playbackRate ?? 1);
    const audioOut = (player as any).audioOutput;
    // Own strings only — no remote input reaches this, so markup is safe here.
    // One label for one concept: playout sped up to shed latency. CMAF does it
    // with the video element's playbackRate, LOC inside WebAudioOutput where
    // there is none to read — the value carries the difference, not the name.
    const chaseRate = audioOut ? (audioOut.chasing ? 1.02 : 1) : rateNow;
    cusCushion.innerHTML = audioOut || rateNow !== 1
      ? `rate: <b${chaseRate > 1 ? '' : ' class="idle"'}>${chaseRate.toFixed(2)}×</b>`
      : '';

    // A large queue with an idle chase is a contradiction: the controller acts on
    // its own `lead`, which the panel cannot see. Log both together when they
    // disagree — lead null means alignedTime was null, so no chase or snap could
    // have run at all.
    if (audioOut && targetLatencyMs > 0) {
      const qMs = audioOut.scheduledAheadSec * 1000;
      if (qMs > targetLatencyMs * 2 && !audioOut.chasing
          && tickNowMs - lastChaseNoteMs > 5_000) {
        lastChaseNoteMs = tickNowMs;
        const leadSec = audioOut.captureLeadSec;
        const lagNow = Math.max(0, ...lagSamples.map(([, d]) => d));
        log(`chase idle: queued=${qMs.toFixed(0)}ms target=${targetLatencyMs}ms `
          + `lead=${leadSec == null ? 'null' : (leadSec * 1000).toFixed(0) + 'ms'} `
          + `lag=${lagNow.toFixed(0)}ms snaps=${audioOut.liveEdgeSnapCount ?? 0}`);
      }
    }

    if (latVals.length) {
      latVal.textContent = percentile(latVals, 0.5).toFixed(0);
      latP95.textContent = percentile(latVals, 0.95).toFixed(0);
      latMax.textContent = maxFinite(latTickMaxSamples)?.toFixed(0) ?? '—';
    }
    // The offset is a publisher stamping artifact, not a playback figure, so it
    // stays off the label and rides a hover instead. Empty title falls through
    // to the chart's own explanation.
    latLabel.title = latOffset
      ? `Capture stamps run ${(-latOffset / 1000).toFixed(1)}s ahead of this `
        + 'browser\'s clock, so these are delay above the best sample in the '
        + 'window, not one-way delay. The publisher reports the same offset as '
        + 'its own send lag; it is a stamping artifact, not latency.'
      : '';
    jitVal.textContent = lastFinite(jitSamples)?.toFixed(1) ?? '—';
  }, 250);

  // ── CMSF / MSF catalog panel ──────────────────────────────────────
  // Redrawn only on catalog events (initial + deltas), never per frame.
  // Catalog values are remote input: built as text nodes, never HTML.

  function renderCatalog(cat: any): void {
    const tracks: any[] = cat?.tracks ?? [];
    const videoTrack = tracks.find((t) => (t.role ?? t.name) === 'video');
    audioCodec = tracks.find((t) => (t.role ?? t.name) === 'audio')?.codec ?? null;
    // Absent on the --ts path: the live demuxer has no framerate to declare.
    videoFps = Number(videoTrack?.framerate) || null;
    targetLatencyMs = Math.max(0,
      ...tracks.map((t) => Number(t.targetLatency) || 0));
    const packagings = [...new Set(tracks.map((t) => t.packaging))].join(', ');
    catMeta.textContent = [
      `v${cat?.version ?? '?'}`,
      `${tracks.length} track${tracks.length === 1 ? '' : 's'}`,
      packagings,
      cat?.initDataList?.length ? `${cat.initDataList.length} initData` : '',
    ].filter(Boolean).join(' · ');

    catTracks.replaceChildren(...tracks.map((t) => {
      const row = document.createElement('div');
      row.className = 'cat-track';
      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = `${t.name ?? '(unnamed)'}:`;
      const pkg = document.createElement('span');
      pkg.className = 'pk';
      pkg.textContent = (t.packaging ?? '?').toUpperCase();
      // Remote input: a text node, never markup.
      const detail = document.createElement('span');
      detail.className = 'dt';
      detail.textContent = [
        t.codec,
        t.width && t.height ? `${t.width}×${t.height}` : '',
        t.framerate ? `${t.framerate}fps` : '',
        t.samplerate ? `${t.samplerate}Hz` : '',
        t.channelConfig ? `${t.channelConfig}ch` : '',
        t.bitrate ? `${Math.round(t.bitrate / 1000)}kbps` : '',
        t.initRef ? `init=${t.initRef}` : '',
        t.targetLatency ? `target=${t.targetLatency}ms` : '',
      ].filter(Boolean).join(' · ');
      row.append(name, pkg, detail);
      return row;
    }));

    catJson.textContent = JSON.stringify(cat, null, 2);
  }

  // Periodic catalog refreshes repeat an unchanged catalog; logging each one
  // buries the stall lines. Log and redraw only on a real change.
  let lastCatalogKey = '';
  const catalogKey = (cat: any): string => JSON.stringify({ ...cat, generatedAt: undefined });
  player.on('catalog_received', ({ catalog }) => {
    lastCatalogKey = catalogKey(catalog);
    log(`Catalog received: ${catalog?.tracks?.length ?? 0} track(s)`);
    renderCatalog(catalog);
  });
  player.on('catalog_updated', ({ catalog }) => {
    const key = catalogKey(catalog);
    if (key === lastCatalogKey) return;
    lastCatalogKey = key;
    log('Catalog changed');
    renderCatalog(catalog);
  });

  const setCatalogHidden = (hidden: boolean): void => {
    layoutEl.classList.toggle('cat-hidden', hidden);
    catRestore.hidden = !hidden;
  };
  catRestore.addEventListener('click', () => setCatalogHidden(false));
  wireCopy(logCopy, () => logEl.textContent ?? '');
  wireCopy(catCopy, () => catJson.textContent ?? '');
  catToggle.addEventListener('click', () => {
    setCatalogHidden(true);
  });

  // ── Controls ──────────────────────────────────────────────────────

  playBtn.addEventListener('click', () => {
    if (player.state === 'playing') player.pause();
    else player.play();
  });

  player.on('play', () => { playBtn.textContent = 'Pause'; });
  player.on('pause', () => { playBtn.textContent = 'Play'; });

  seekBar.addEventListener('input', () => player.seek(Number(seekBar.value)));
  volumeBar.addEventListener('input', () => player.setVolume(Number(volumeBar.value) / 100));
  muteBtn.addEventListener('click', () => player.toggleMute());
  player.on('volumechange', ({ muted }) => { muteBtn.textContent = muted ? 'Unmute' : 'Mute'; });

  qualitySelect.addEventListener('change', () => {
    const val = qualitySelect.value;
    void player.setQuality(val === 'auto' ? 'auto' : Number(val))
      .catch((err: unknown) => log(`Quality switch failed: ${(err as Error).message}`));
  });

  // ── Load ──────────────────────────────────────────────────────────

  log(`Relay: ${relayUrl}`);
  log(`Namespace: ${namespace}`);
  player.load().catch((err) => log(`Fatal: ${(err as Error).message}`));
}

void main();
