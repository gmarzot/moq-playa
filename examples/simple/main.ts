/**
 * Playa — MSF/CMSF Example
 *
 * The entire player wired to a full UI in ~30 lines of player code.
 * Everything else is DOM glue.
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
const latSpark = document.getElementById('lat-spark') as HTMLCanvasElement;
const jitSpark = document.getElementById('jit-spark') as HTMLCanvasElement;
const cusSpark = document.getElementById('cus-spark') as HTMLCanvasElement;
const cusVal = document.getElementById('cus-val')!;
const cusTarget = document.getElementById('cus-target')!;
const cusLabel = document.getElementById('cus-label')!;
const bufSpark = document.getElementById('buf-spark') as HTMLCanvasElement;
const bufDVal = document.getElementById('bufd-val')!;
const bufVVal = document.getElementById('bufv-val')!;
const bufAVal = document.getElementById('bufa-val')!;
const latVal = document.getElementById('lat-val')!;
const latP95 = document.getElementById('lat-p95')!;
const jitVal = document.getElementById('jit-val')!;
const catalogPanel = document.getElementById('catalog-panel')!;
const catMeta = document.getElementById('cat-meta')!;
const catTracks = document.getElementById('cat-tracks')!;
const catJson = document.getElementById('cat-json')!;
const catToggle = document.getElementById('cat-toggle') as HTMLButtonElement;
const logEl = document.getElementById('log')!;
const playerContainer = document.getElementById('player-container')!;

function log(msg: string): void {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
  logEl.textContent += `[${ts}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
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
  const queuedLabel = (): string =>
    player.activeMediaType === 'video' ? 'buffered ahead ms' : 'audio queued ms';

  let lastSyncResets = 0;
  player.on('stats', (s: any) => {
    const syncResets: number = (player as any).engine?.stats?.loc?.syncResetCount ?? 0;
    if (syncResets > lastSyncResets) {
      log(`Sync reference re-anchored (${syncResets} total)`);
      lastSyncResets = syncResets;
    }
    const cell = (label: string, v: string) =>
      `<div class="cell">${label}:<b>${v}</b></div>`;
    const playbackRate = (): string => {
      const v = playerContainer.querySelector('video');
      return v ? v.playbackRate.toFixed(2) : '—';
    };
    const res = s.resolution ?? s.currentResolution;
    // The LOC gauges (render cushion, skew, audio underruns/late/snap) do not
    // exist on the MSE path, and a column of em-dashes is worse than no column.
    const cushion = renderCushionMs();
    const locPath = cushion != null || s.avSkewMs != null;
    diagGrid.innerHTML = [
      cell('state', player.state),
      cell('ttff ms', s.timeToFirstFrameMs != null ? s.timeToFirstFrameMs.toFixed(0) : '—'),
      // Codec is in the catalog panel; the decoded resolution is not, and it
      // is what the stream actually delivered rather than what it claimed.
      cell('resolution', res ? `${res.width}x${res.height}` : '—'),
      // Frames that were decoded but never presented are the interesting part,
      // so the pair stays together rather than in two separate columns.
      cell('rendered / decoded',
        `${s.framesRendered ?? 0} / ${s.framesDecoded ?? 0}`),
      cell('dropped', String(s.framesDropped ?? 0)),
      cell('stalls', `${s.stallCount ?? 0} (${((s.stallDurationMs ?? 0) / 1000).toFixed(1)}s)`),
      // Breaks in the (group, object) sequence per track — the only view of a
      // frame missing inside a buffered range.
      cell('obj breaks v/a', `${objBreaks.video ?? 0} / ${objBreaks.audio ?? 0}`),
      // MSE only: 1.05 means the soft chase is shedding latency right now.
      ...(locPath ? [] : [cell('rate', playbackRate())]),
      ...(locPath ? [
        cell('sync resets', String(syncResets)),
        // The playout delay the engine schedules against — a policy value, not
        // the media queued (that is the buffered-ahead chart).
        cell('render cushion ms', cushion != null ? cushion.toFixed(0) : '—'),
        cell('a/v skew ms', s.avSkewMs != null ? s.avSkewMs.toFixed(0) : '—'),
        cell('audio underruns', String(s.audioUnderruns ?? 0)),
        // Why audio underran: dropped late before decode / snapped by the output clamp.
        cell('audio late / snap', `${(player as any).engine?.stats?.loc?.audioLateDrops ?? 0}`
          + ` / ${(player as any).audioOutput?.liveEdgeSnapCount ?? 0}`),
      ] : []),
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

  const latSamples: number[] = [];
  const latP50Samples: number[] = [];
  const latP95Samples: number[] = [];
  const jitSamples: number[] = [];
  // Playout cushion: media buffered ahead of the playhead, sampled every
  // 250ms — MSE from the <video> element's buffered ranges, WebCodecs
  // from the engine's buffer-depth stat. Starvation (cushion ≈ 0 at a
  // stall marker) points at the player; a healthy cushion points wire-ward.
  const cushionSamples: number[] = [];
  const bufSkewSamples: number[] = [];
  const stallMarks: number[] = [];
  let targetLatencyMs = 0;
  let prevArrivalMs = 0;
  let prevCaptureMs = 0;
  let jitterEwma = 0;
  let expectedIntervalMs = 0;
  let skewSamples = 0;
  (window as any).__player = player;
  const pushSample = (a: number[], v: number) => {
    a.push(v);
    if (a.length > 180) a.shift();
  };

  const percentile = (a: number[], p: number): number => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
  };

  // Per-track object continuity: a stall with data still ahead of the playhead
  // means a frame is missing inside the buffered range, which only shows up as
  // a break in the (group, object) sequence.
  const objSeq: Record<string, { group: bigint; object: bigint }> = {};
  const objBreaks: Record<string, number> = { video: 0, audio: 0 };
  const noteObject = (e: any): void => {
    const t = e.mediaType;
    if ((t !== 'video' && t !== 'audio') || e.kind !== 'data') return;
    if (e.group === undefined || e.object === undefined) return;
    const group = BigInt(e.group), object = BigInt(e.object);
    const prev = objSeq[t];
    if (prev) {
      const sameGroup = group === prev.group;
      const contiguous = sameGroup
        ? object === prev.object + 1n
        : group === prev.group + 1n && object === 0n;
      if (!contiguous) {
        objBreaks[t] = (objBreaks[t] ?? 0) + 1;
        log(`obj break [${t}]: ${prev.group}.${prev.object} -> ${group}.${object}`);
      }
    }
    objSeq[t] = { group, object };
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
      pushSample(jitSamples, jitterEwma);
    } else if (prevArrivalMs) {
      const interval = arrivalMs - prevArrivalMs;
      if (expectedIntervalMs) pushSample(jitSamples, Math.abs(interval - expectedIntervalMs));
      expectedIntervalMs = expectedIntervalMs
        ? expectedIntervalMs * 0.9 + interval * 0.1 : interval;
    }

    prevArrivalMs = arrivalMs;
    if (captureMs) {
      prevCaptureMs = captureMs;
      const latencyMs = Date.now() - captureMs;
      if (latencyMs < -250) skewSamples++;
      else if (latencyMs < 30_000) {
        pushSample(latSamples, latencyMs);
        // Rolling percentiles over a short trailing window: the raw per-object
        // series is mostly noise, while p50 against p95 shows the tail moving.
        const win = latSamples.slice(-40);
        pushSample(latP50Samples, percentile(win, 0.5));
        pushSample(latP95Samples, percentile(win, 0.95));
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
    if (data.length < 2) return;
    const max = Math.max(...data, refLine) * 1.15 || 1;
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
    data.forEach((v, i) => {
      if (i === 0) ctx.moveTo(xOf(i), yOf(v)); else ctx.lineTo(xOf(i), yOf(v));
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
    const max = Math.max(1, ...a, ...b) * 1.15;
    for (const [data, color] of [[a, aColor], [b, bColor]] as Array<[number[], string]>) {
      if (data.length < 2) continue;
      ctx.beginPath();
      data.forEach((v, i) => {
        const x = (i / (data.length - 1)) * w;
        const y = h - (v / max) * (h - 6) - 3;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
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
    if (data.length < 2) return;
    // A floor on the scale keeps normal ±ms wobble from looking like drift.
    const span = Math.max(100, ...data.map(Math.abs)) * 1.15;
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = (i / (data.length - 1)) * w;
      const y = zeroY - (v / span) * (h / 2 - 3);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#d9922e';
    ctx.lineWidth = devicePixelRatio;
    ctx.stroke();
  }

  setInterval(() => {
    watchVideo();
    if (debug) {
      // The MSE adapter exists only after the catalog; enable its tracing
      // once it appears (console output).
      const ms = (player as any).engine?.mediaSource;
      if (ms && ms.debug === false) ms.debug = true;
    }
    // Contiguous cushion only (facade-computed per path). Zero with appends
    // still landing means the playhead is parked at a hole.
    const cushionMs = player.stats.cushionMs;
    if (cushionMs != null && player.state !== 'idle') {
      cushionSamples.push(cushionMs);
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
    if (player.state !== 'idle' && vMs != null && aMs != null) {
      pushSample(bufSkewSamples, vMs - aMs);
    }

    drawSpark2(latSpark, latP50Samples, '#d7b73f', latP95Samples, '#d9922e');
    drawSpark(jitSpark, jitSamples, '#d9922e');
    drawSpark(cusSpark, cushionSamples, '#4d4', targetLatencyMs, stallMarks);
    drawDelta(bufSpark, bufSkewSamples);
    bufDVal.textContent = (vMs != null && aMs != null)
      ? `${vMs - aMs >= 0 ? '+' : ''}${(vMs - aMs).toFixed(0)}` : '—';
    bufVVal.textContent = vMs != null ? vMs.toFixed(0) : '—';
    bufAVal.textContent = aMs != null ? aMs.toFixed(0) : '—';
    cusVal.textContent = cushionSamples.length
      ? cushionSamples[cushionSamples.length - 1]!.toFixed(0) : '—';
    cusTarget.textContent = targetLatencyMs ? String(targetLatencyMs) : '—';
    cusLabel.textContent = queuedLabel();
    if (latSamples.length) {
      latVal.textContent = percentile(latSamples, 0.5).toFixed(0);
      latP95.textContent = percentile(latSamples, 0.95).toFixed(0);
    } else if (skewSamples) {
      // Every sample landed before its own capture stamp: the clocks
      // disagree, so the difference is offset, not latency.
      latVal.textContent = 'clock skew';
      latP95.textContent = '—';
    }
    jitVal.textContent = jitSamples.length
      ? jitSamples[jitSamples.length - 1]!.toFixed(1)
      : '—';
  }, 250);

  // ── CMSF / MSF catalog panel ──────────────────────────────────────
  // Redrawn only on catalog events (initial + deltas), never per frame.
  // Catalog values are remote input: built as text nodes, never HTML.

  function renderCatalog(cat: any): void {
    const tracks: any[] = cat?.tracks ?? [];
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
      name.textContent = t.name ?? '(unnamed)';
      const pkg = document.createElement('span');
      pkg.className = 'pk';
      pkg.textContent = (t.packaging ?? '?').toUpperCase();
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

  catToggle.addEventListener('click', () => {
    const collapsed = catalogPanel.classList.toggle('collapsed');
    catToggle.textContent = collapsed ? 'show' : 'hide';
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
